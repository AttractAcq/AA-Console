import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { bots, type Bot, type Identity } from "../shared/types.js";
import { grants } from "../policy/permissions.js";

export const credentialSchema = z
  .array(
    z
      .object({
        token: z.string().min(32),
        bot: z.enum(bots),
        clients: z.array(z.string().uuid()).min(1),
      })
      .strict(),
  )
  .min(1);
export type Credential = z.infer<typeof credentialSchema>[number];
export type BotAuthMode = "env" | "dual" | "db";

const hash = (s: string) => createHash("sha256").update(s).digest();
export const tokenHashHex = (s: string) => hash(s).toString("hex");
const unauthorized = () => new Error("unauthorized");

export function authenticate(
  header: string | undefined,
  credentials: Credential[],
): Identity {
  const token = /^Bearer ([^\s]+)$/.exec(header ?? "")?.[1];
  if (!token) throw unauthorized();
  const c = credentials.find((c) =>
    timingSafeEqual(hash(c.token), hash(token)),
  );
  if (!c) throw unauthorized();
  return { bot: c.bot, clients: [...c.clients] };
}

function envIdentity(
  token: string,
  credentials: Credential[],
): Identity | undefined {
  let found: Identity | undefined;
  for (const c of credentials) {
    if (timingSafeEqual(hash(c.token), hash(token)))
      found = { bot: c.bot, clients: [...c.clients] };
  }
  return found;
}

function sameSet(a: string[], b: string[]): boolean {
  const norm = (xs: string[]) => [...new Set(xs)].sort().join("\0");
  return norm(a) === norm(b);
}

export type AaResolveResult = {
  found: boolean;
  status?: string;
  bot_id?: Bot;
  token_id?: string;
  clients?: string[];
  permissions?: string[];
};

export type BotAuthAlert = (event: Record<string, unknown>) => void;

type CacheEntry = { expires: number; value: AaResolveResult | null };

export class BotAuthenticator {
  private readonly cache = new Map<string, CacheEntry>();
  private allowLocalAdminEnv = false;
  private readonly byBot = new Map<Bot, Identity>();
  constructor(
    private readonly mode: BotAuthMode,
    private readonly credentials: Credential[],
    private readonly resolveAa:
      ((hashHex: string) => Promise<AaResolveResult>) | undefined,
    private readonly alert: BotAuthAlert = () => {},
    private readonly now: () => number = Date.now,
    private readonly positiveTtlMs = 30_000,
    private readonly negativeTtlMs = 5_000,
  ) {}

  static fromConfig(
    c: {
      BOT_AUTH_MODE: BotAuthMode;
      PUBLIC_ORIGIN?: string;
      bots: Credential[];
      AA_INTERNAL_API_URL?: string;
      AA_MCP_SERVICE_SECRET?: string;
    },
    alert: BotAuthAlert = () => {},
    resolve?: (hashHex: string) => Promise<AaResolveResult>,
  ): BotAuthenticator {
    const fn =
      resolve ??
      (c.AA_INTERNAL_API_URL && c.AA_MCP_SERVICE_SECRET
        ? (hashHex: string) =>
            resolveBotToken(
              c.AA_INTERNAL_API_URL!,
              c.AA_MCP_SERVICE_SECRET!,
              hashHex,
            )
        : undefined);
    const auth = new BotAuthenticator(c.BOT_AUTH_MODE, c.bots, fn, alert);
    // Local mock fixtures may use env auth. Hosted Admin requests require the
    // DB resolver, without preventing legacy credentials for other bots booting.
    if (c.PUBLIC_ORIGIN) {
      const origin = new URL(c.PUBLIC_ORIGIN);
      auth.allowLocalAdminEnv =
        origin.protocol === "http:" &&
        ["localhost", "127.0.0.1"].includes(origin.hostname);
    }
    return auth;
  }

  identities(): Identity[] {
    if (this.mode === "db") return [...this.byBot.values()];
    return this.credentials.map((c) => ({
      bot: c.bot,
      clients: [...c.clients],
    }));
  }

  async authenticate(header: string | undefined): Promise<Identity> {
    const token = /^Bearer ([^\s]+)$/.exec(header ?? "")?.[1];
    if (!token) throw unauthorized();
    const presented = hash(token);
    const env = envIdentity(token, this.credentials);
    if (this.mode === "env") {
      if (!env || (env.bot === "bot_admin" && !this.allowLocalAdminEnv))
        throw unauthorized();
      return env;
    }
    const hashHex = presented.toString("hex");
    let aa: AaResolveResult | null | "unavailable";
    try {
      aa = await this.lookupAa(hashHex);
    } catch {
      aa = "unavailable";
      this.alert({ event: "bot_auth_aa_unavailable" });
    }
    if (this.mode === "db") {
      const identity = this.fromAa(aa, true);
      if (!identity) throw unauthorized();
      this.byBot.set(identity.bot, identity);
      return identity;
    }
    if (aa !== "unavailable" && aa?.found && aa.status !== "active")
      throw unauthorized();
    const aaIdentity = this.fromAa(aa);
    if (
      aa !== "unavailable" &&
      aa?.found &&
      aa.status === "active" &&
      !aaIdentity
    )
      throw unauthorized();
    // Admin never falls back to env or stale permissions in dual/db mode.
    if (env?.bot === "bot_admin" || aaIdentity?.bot === "bot_admin") {
      const current = this.fromAa(aa, true);
      if (
        !current ||
        current.bot !== "bot_admin" ||
        (env && this.mismatch(aa, env))
      )
        throw unauthorized();
      this.byBot.set(current.bot, current);
      return current;
    }
    if (aaIdentity && env) {
      if (this.mismatch(aa, env)) {
        this.alert({
          event: "bot_auth_mismatch",
          bot_aa: aaIdentity.bot,
          bot_env: env.bot,
          clients_match: sameSet(aaIdentity.clients, env.clients),
          permissions_match: sameSet(
            (aa && aa !== "unavailable" ? aa.permissions : undefined) ?? [],
            grants[env.bot],
          ),
        });
        throw unauthorized();
      }
      return env;
    }
    if (aaIdentity) {
      this.byBot.set(aaIdentity.bot, aaIdentity);
      return aaIdentity;
    }
    if (env) return env;
    throw unauthorized();
  }

  private mismatch(
    aa: AaResolveResult | null | "unavailable",
    env: Identity,
  ): boolean {
    if (aa === "unavailable" || !aa?.found || aa.status !== "active")
      return false;
    if (!aa.bot_id || aa.bot_id !== env.bot) return true;
    if (!sameSet(aa.clients ?? [], env.clients)) return true;
    return !sameSet(aa.permissions ?? [], grants[env.bot]);
  }

  private fromAa(
    aa: AaResolveResult | null | "unavailable",
    withPermissions = false,
  ): Identity | undefined {
    if (aa === "unavailable" || !aa?.found || aa.status !== "active") return;
    if (!aa.bot_id || !bots.includes(aa.bot_id)) return;
    const identity: Identity = {
      bot: aa.bot_id,
      clients: [...(aa.clients ?? [])],
    };
    if (withPermissions) identity.permissions = [...(aa.permissions ?? [])];
    return identity;
  }

  private async lookupAa(hashHex: string): Promise<AaResolveResult | null> {
    const hit = this.cache.get(hashHex);
    if (hit && hit.value?.bot_id !== "bot_admin" && hit.expires > this.now())
      return hit.value;
    if (!this.resolveAa) return null;
    const value = await this.resolveAa(hashHex);
    const ttl =
      value.found && value.status === "active"
        ? this.positiveTtlMs
        : this.negativeTtlMs;
    this.cache.set(hashHex, { value, expires: this.now() + ttl });
    return value;
  }
}

const resolveSchema = z
  .object({
    found: z.boolean(),
    status: z.string().optional(),
    bot_id: z.enum(bots).optional(),
    token_id: z.string().uuid().optional(),
    clients: z.array(z.string().uuid()).optional(),
    permissions: z.array(z.string()).optional(),
  })
  .strict();

export async function resolveBotToken(
  origin: string,
  secret: string,
  hashHex: string,
  timeoutMs = 5000,
): Promise<AaResolveResult> {
  const signal = AbortSignal.timeout(timeoutMs);
  const response = await fetch(new URL("/internal/mcp/auth/resolve", origin), {
    method: "POST",
    redirect: "error",
    signal,
    headers: {
      authorization: `Bearer ${secret}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ token_hash: hashHex }),
  });
  if (!response.ok) throw new Error("aa_resolve_failed");
  const raw: unknown = await response.json();
  const parsed = resolveSchema.safeParse(raw);
  if (!parsed.success) throw new Error("aa_resolve_failed");
  return parsed.data;
}

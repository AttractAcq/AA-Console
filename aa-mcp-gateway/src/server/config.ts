import { isAbsolute } from "node:path";
import { z } from "zod";
import { credentialSchema, type Credential } from "../auth/identity.js";
/** HTTP origins allowed besides HTTPS. Host-exact for Railway private hop. */
const ALLOWED_HTTP_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "aa-console.railway.internal",
]);
function isAllowedHttpOrigin(u: URL): boolean {
  if (u.protocol !== "http:") return false;
  // Exact hostname only — no *.railway.internal wildcard, no IPs/CIDRs.
  return ALLOWED_HTTP_HOSTS.has(u.hostname);
}
export function config(env: NodeJS.ProcessEnv = process.env) {
  const hosted = env.NODE_ENV === "production" || Boolean(env.RAILWAY_ENVIRONMENT_ID);
  const schema = z.object({
    PORT: z.coerce.number().int().min(1).max(65535).default(3100),
    HOST: z.string().default(hosted ? "0.0.0.0" : "127.0.0.1"),
    PUBLIC_ORIGIN: hosted ? z.string().url() : z.string().url().default("http://localhost:3100"),
    DATABASE_PATH: z.string().min(1).default("./data/gateway.sqlite"),
    BOT_AUTH_MODE: z.enum(["env", "dual", "db"]).default("dual"),
    BOT_CREDENTIALS_JSON: z.string().optional(),
    REVIEWER_CREDENTIALS_JSON: z.string(),
    AA_INTERNAL_API_URL: z.string().url().optional(),
    AA_MCP_SERVICE_SECRET: z.string().min(32).optional(),
    MCP_DISCOVER_STUBS: z
      .string()
      .optional()
      .transform((v) => v?.trim().toLowerCase() === "true"),
  });
  const c = schema.parse(env);
  if (hosted) {
    if (c.HOST !== "0.0.0.0") throw new Error("Hosted HOST must be 0.0.0.0");
    if (!isAbsolute(c.DATABASE_PATH)) throw new Error("Hosted DATABASE_PATH must be an absolute persistent path");
    const origin = new URL(c.PUBLIC_ORIGIN);
    if (origin.protocol !== "https:" || ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname)) {
      throw new Error("Hosted PUBLIC_ORIGIN must be a public HTTPS origin");
    }
  }
  const reviewers = z
    .array(
      z
        .object({ id: z.string().min(1).max(100), token: z.string().min(32) })
        .strict(),
    )
    .min(1)
    .parse(JSON.parse(c.REVIEWER_CREDENTIALS_JSON));
  const rawBots = c.BOT_CREDENTIALS_JSON?.trim() ?? "";
  let bots: Credential[] = [];
  if (c.BOT_AUTH_MODE === "db") {
    if (rawBots && rawBots !== "[]")
      throw new Error("BOT_CREDENTIALS_JSON must be empty in db mode");
    if (!c.AA_INTERNAL_API_URL || !c.AA_MCP_SERVICE_SECRET)
      throw new Error("db auth mode requires AA API URL and token");
  } else {
    bots = credentialSchema.parse(JSON.parse(rawBots || "[]"));
  }
  if (new Set(bots.map((b) => b.bot)).size !== bots.length)
    throw new Error("Duplicate Bot identity");
  const tokens = [
    ...bots.map((b) => b.token),
    ...reviewers.map((r) => r.token),
  ];
  if (new Set(tokens).size !== tokens.length)
    throw new Error("Credentials must be distinct");
  if (new Set(reviewers.map((r) => r.id)).size !== reviewers.length)
    throw new Error("Duplicate reviewer identity");
  if (Boolean(c.AA_INTERNAL_API_URL) !== Boolean(c.AA_MCP_SERVICE_SECRET))
    throw new Error("AA API URL and token must be supplied together");
  for (const value of [c.PUBLIC_ORIGIN, c.AA_INTERNAL_API_URL].filter(
    Boolean,
  ) as string[]) {
    const u = new URL(value);
    if (u.username || u.password || u.search || u.hash || u.pathname !== "/")
      throw new Error("Origin only");
    if (u.protocol !== "https:" && !isAllowedHttpOrigin(u))
      throw new Error("HTTPS required");
  }
  return { ...c, bots, reviewers };
}
export type Config = ReturnType<typeof config>;

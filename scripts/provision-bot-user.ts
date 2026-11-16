import { createClient } from "@supabase/supabase-js";
import { pathToFileURL } from "node:url";

// Service-role provisioner for one Console bot login.
// Does not use create_console_user. Do not run against staging or production
// without a separate CLEAR. This file never writes the password to disk.

export const BOT_KEYS = [
  "bot-cos",
  "bot-cdm",
  "bot-marketing",
  "bot-production",
  "bot-distribution",
  "bot-sales",
  "bot-admin",
  "bot-finance",
  "bot-engineering",
  "bot-security",
] as const;

export type BotKey = (typeof BOT_KEYS)[number];

// Explicit mailbox names. Do not derive the local part from bot_key.
// These addresses have no mailbox and must not depend on delivery.
export const BOT_EMAILS: Record<BotKey, string> = {
  "bot-cos": "cos@attractacq.com",
  "bot-cdm": "delivery@attractacq.com",
  "bot-marketing": "marketing@attractacq.com",
  "bot-production": "production@attractacq.com",
  "bot-distribution": "distribution@attractacq.com",
  "bot-sales": "sales@attractacq.com",
  "bot-admin": "ops-admin@attractacq.com",
  "bot-finance": "finance@attractacq.com",
  "bot-engineering": "engineering@attractacq.com",
  "bot-security": "security@attractacq.com",
};

const BOT_KEY_PATTERN = /^bot-[a-z0-9-]+$/;
export const CONFIRM = {
  provision: "create-bot-user",
  reset: "reset-bot-password",
  unenroll: "unenroll-bot-mfa",
} as const;

export type ProfileRow = {
  id: string;
  role: string;
  is_bot: boolean;
  bot_key: string | null;
  email: string | null;
};

type AuthError = { message: string; code?: string };
type AuthUser = { id: string; email?: string | null };

export type BotProvisionClient = {
  auth: {
    admin: {
      createUser: (input: {
        email: string;
        password: string;
        email_confirm: true;
        app_metadata: { is_bot: true; bot_key: string };
      }) => Promise<{ data: { user: AuthUser | null } | null; error: AuthError | null }>;
      deleteUser: (id: string) => Promise<{ data: unknown; error: AuthError | null }>;
      listUsers: (params?: { page?: number; perPage?: number }) => Promise<{
        data: { users: AuthUser[] } | null;
        error: AuthError | null;
      }>;
      updateUserById: (
        id: string,
        attributes: { password: string },
      ) => Promise<{ data: { user: AuthUser | null } | null; error: AuthError | null }>;
      mfa: {
        listFactors: (params: { userId: string }) => Promise<{
          data: { factors: Array<{ id: string; factor_type?: string; status?: string }> } | null;
          error: AuthError | null;
        }>;
        deleteFactor: (params: { id: string; userId: string }) => Promise<{
          data: { id: string } | null;
          error: AuthError | null;
        }>;
      };
    };
  };
  from: (table: "profiles") => {
    select: (columns: string) => {
      eq: (column: string, value: string) => {
        maybeSingle: () => Promise<{ data: ProfileRow | null; error: AuthError | null }>;
      };
    };
    insert: (row: {
      id: string;
      email: string;
      full_name: string;
      role: "admin";
      is_bot: true;
      bot_key: string;
    }) => Promise<{ error: AuthError | null }>;
  };
  rpc: (
    fn: "revoke_bot_sessions",
    args: { p_user_id: string },
  ) => Promise<{
    data: Array<{ sessions_deleted: number; refresh_tokens_deleted: number }> | null;
    error: AuthError | null;
  }>;
};

export type ProvisionResult = {
  status: "created";
  botKey: BotKey;
  email: string;
  userId: string;
};

export class ProvisionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProvisionError";
  }
}

function scrub(message: string, password: string): string {
  if (!password) return message;
  return message.split(password).join("[redacted]");
}

export function botEmail(botKey: string): string {
  return BOT_EMAILS[assertBotKey(botKey)];
}

export function assertBotKey(value: string): BotKey {
  if (!BOT_KEY_PATTERN.test(value) || !BOT_KEYS.includes(value as BotKey)) {
    throw new ProvisionError(
      `bot_key must be one of: ${BOT_KEYS.join(", ")}`,
    );
  }
  return value as BotKey;
}

function alreadyExists(error: AuthError): boolean {
  const code = (error.code ?? "").toLowerCase();
  const message = error.message.toLowerCase();
  return code === "email_exists"
    || message.includes("already been registered")
    || message.includes("already exists");
}

async function findUserByEmail(client: BotProvisionClient, email: string): Promise<AuthUser | null> {
  for (let page = 1; page <= 20; page += 1) {
    const listed = await client.auth.admin.listUsers({ page, perPage: 200 });
    if (listed.error) throw new ProvisionError(listed.error.message);
    const users = listed.data?.users ?? [];
    const found = users.find((user) => (user.email ?? "").toLowerCase() === email);
    if (found) return found;
    if (users.length < 200) return null;
  }
  return null;
}

async function readProfile(client: BotProvisionClient, userId: string): Promise<ProfileRow | null> {
  const result = await client.from("profiles")
    .select("id, role, is_bot, bot_key, email")
    .eq("id", userId)
    .maybeSingle();
  if (result.error) throw new ProvisionError(result.error.message);
  return result.data;
}

async function insertProfile(
  client: BotProvisionClient,
  row: { id: string; email: string; fullName: string; botKey: BotKey },
  password: string,
): Promise<void> {
  const inserted = await client.from("profiles").insert({
    id: row.id,
    email: row.email,
    full_name: row.fullName,
    role: "admin",
    is_bot: true,
    bot_key: row.botKey,
  });
  if (inserted.error) {
    throw new ProvisionError(scrub(inserted.error.message, password));
  }
}

export async function provisionBotUser(
  client: BotProvisionClient,
  input: { botKey: string; fullName: string; password: string },
): Promise<ProvisionResult> {
  const botKey = assertBotKey(input.botKey.trim());
  const fullName = input.fullName.trim();
  const password = input.password;
  if (!fullName) throw new ProvisionError("full_name is required");
  if (password.length < 16) {
    throw new ProvisionError("password must be at least 16 characters");
  }
  const email = BOT_EMAILS[botKey];

  const created = await client.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    app_metadata: { is_bot: true, bot_key: botKey },
  });

  if (created.error) {
    if (alreadyExists(created.error)) {
      throw new ProvisionError(
        `Auth account ${email} already exists. Refusing to promote an existing account into a bot. Password was not changed.`,
      );
    }
    throw new ProvisionError(scrub(created.error.message, password));
  }

  const userId = created.data?.user?.id ?? null;
  if (!userId) throw new ProvisionError("Auth did not return a user id. Password was not stored by this script.");

  try {
    await insertProfile(client, { id: userId, email, fullName, botKey }, password);
    return { status: "created", botKey, email, userId };
  } catch (error) {
    const removed = await client.auth.admin.deleteUser(userId);
    if (removed.error) {
      throw new ProvisionError(
        `Profile insert failed and the new auth user ${userId} could not be deleted: ${scrub(removed.error.message, password)}`,
      );
    }
    if (error instanceof ProvisionError) throw error;
    const message = error instanceof Error ? error.message : "profile insert failed";
    throw new ProvisionError(scrub(message, password));
  }
}

async function requireBotAccount(client: BotProvisionClient, botKeyInput: string) {
  const botKey = assertBotKey(botKeyInput.trim());
  const email = BOT_EMAILS[botKey];
  const user = await findUserByEmail(client, email);
  if (!user) {
    throw new ProvisionError(`No auth user for ${email}. Nothing was changed.`);
  }
  const profile = await readProfile(client, user.id);
  const profileEmail = (profile?.email ?? "").toLowerCase();
  if (!profile || profile.is_bot !== true || profile.bot_key !== botKey || (profileEmail !== "" && profileEmail !== email)) {
    throw new ProvisionError(`Refusing ${email}: the profile is not bot ${botKey}. Nothing was changed.`);
  }
  return { botKey, email, userId: user.id };
}

export async function resetBotPassword(
  client: BotProvisionClient,
  input: { botKey: string; password: string; dryRun?: boolean },
): Promise<{ status: "reset" | "dry_run"; botKey: BotKey; email: string; userId: string }> {
  const account = await requireBotAccount(client, input.botKey);
  if (input.dryRun) return { status: "dry_run", ...account };
  if (input.password.length < 16) {
    throw new ProvisionError("password must be at least 16 characters");
  }
  const updated = await client.auth.admin.updateUserById(account.userId, { password: input.password });
  if (updated.error) throw new ProvisionError(scrub(updated.error.message, input.password));
  const revoked = await client.rpc("revoke_bot_sessions", { p_user_id: account.userId });
  if (revoked.error) {
    throw new ProvisionError(
      `Password was changed but sessions were not revoked: ${scrub(revoked.error.message, input.password)}`,
    );
  }
  return { status: "reset", ...account };
}

export async function unenrollBotMfa(
  client: BotProvisionClient,
  input: { botKey: string; dryRun?: boolean },
): Promise<{ status: "unenrolled" | "dry_run"; botKey: BotKey; email: string; userId: string; factorIds: string[] }> {
  const account = await requireBotAccount(client, input.botKey);
  const listed = await client.auth.admin.mfa.listFactors({ userId: account.userId });
  if (listed.error) throw new ProvisionError(listed.error.message);
  const factorIds = (listed.data?.factors ?? []).map((factor) => factor.id);
  if (input.dryRun) return { status: "dry_run", ...account, factorIds };
  for (const id of factorIds) {
    const removed = await client.auth.admin.mfa.deleteFactor({ id, userId: account.userId });
    if (removed.error) {
      throw new ProvisionError(`MFA factor ${id} was not deleted: ${removed.error.message}`);
    }
  }
  const revoked = await client.rpc("revoke_bot_sessions", { p_user_id: account.userId });
  if (revoked.error) {
    throw new ProvisionError(`MFA factors were deleted but sessions were not revoked: ${revoked.error.message}`);
  }
  return { status: "unenrolled", ...account, factorIds };
}

async function readPassword(): Promise<string> {
  if (process.stdin.isTTY) {
    throw new ProvisionError(
      "Pipe the password on stdin. It is not read from the environment or an interactive prompt.",
    );
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
}

function arg(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value || value.startsWith("--")) {
    throw new ProvisionError(`Missing ${name}`);
  }
  return value;
}

function commandName(): "provision" | "reset-password" | "unenroll-mfa" {
  const first = process.argv[2];
  if (first === "reset-password" || first === "unenroll-mfa" || first === "provision") return first;
  return "provision";
}

function liveClient(url: string, key: string): BotProvisionClient {
  const raw = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const admin = raw.auth.admin;
  return {
    from: (table) => raw.from(table) as ReturnType<BotProvisionClient["from"]>,
    auth: {
      admin: {
        createUser: (input) => admin.createUser(input),
        deleteUser: (id) => admin.deleteUser(id),
        listUsers: (params) => admin.listUsers(params),
        updateUserById: (id, attributes) => admin.updateUserById(id, attributes),
        mfa: {
          listFactors: (params) => admin.mfa.listFactors(params),
          deleteFactor: (params) => admin.mfa.deleteFactor(params),
        },
      },
    },
    rpc: (fn, args) => raw.rpc(fn, args),
  };
}

async function main(): Promise<void> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new ProvisionError("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
  }
  const client = liveClient(url, key);
  const botKey = arg("--bot-key");
  const command = commandName();
  const forcedDryRun = process.argv.includes("--dry-run");
  if (command === "reset-password") {
    const confirmed = process.env.BOT_RESET_CONFIRM === CONFIRM.reset;
    const dryRun = forcedDryRun || !confirmed;
    const password = dryRun ? "" : await readPassword();
    const result = await resetBotPassword(client, { botKey, password, dryRun });
    process.stdout.write(`${result.status} ${result.botKey} ${result.email} ${result.userId}\n`);
    return;
  }
  if (command === "unenroll-mfa") {
    const confirmed = process.env.BOT_MFA_CONFIRM === CONFIRM.unenroll;
    const dryRun = forcedDryRun || !confirmed;
    const result = await unenrollBotMfa(client, { botKey, dryRun });
    process.stdout.write(`${result.status} ${result.botKey} ${result.email} ${result.userId} factors=${result.factorIds.length}\n`);
    return;
  }
  if (process.env.BOT_PROVISION_CONFIRM !== CONFIRM.provision) {
    throw new ProvisionError(
      `Refusing to create an auth user. Set BOT_PROVISION_CONFIRM=${CONFIRM.provision} after a separate CLEAR.`,
    );
  }
  const password = await readPassword();
  const result = await provisionBotUser(client, {
    botKey,
    fullName: arg("--full-name"),
    password,
  });
  process.stdout.write(`${result.status} ${result.botKey} ${result.email} ${result.userId}\n`);
}

const invokedDirectly = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "provision failed";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}

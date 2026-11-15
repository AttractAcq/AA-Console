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

const BOT_KEY_PATTERN = /^bot-[a-z0-9-]+$/;
const CONFIRM_VALUE = "create-bot-user";

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
};

export type ProvisionResult = {
  status: "created" | "already_provisioned" | "profile_repaired";
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
  return `${botKey}@attractacq.com`;
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
  const email = botEmail(botKey);

  const created = await client.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    app_metadata: { is_bot: true, bot_key: botKey },
  });

  let userId = created.data?.user?.id ?? null;
  let createdNow = Boolean(userId) && !created.error;

  if (created.error) {
    if (!alreadyExists(created.error)) {
      throw new ProvisionError(scrub(created.error.message, password));
    }
    createdNow = false;
    const existing = await findUserByEmail(client, email);
    if (!existing) {
      throw new ProvisionError(
        `Auth already has ${email}, but the user id could not be resolved. Password was not changed.`,
      );
    }
    userId = existing.id;
  }

  if (!userId) throw new ProvisionError("Auth did not return a user id. Password was not stored by this script.");

  try {
    const profile = await readProfile(client, userId);
    if (!profile) {
      await insertProfile(client, { id: userId, email, fullName, botKey }, password);
      return {
        status: createdNow ? "created" : "profile_repaired",
        botKey,
        email,
        userId,
      };
    }
    const matches = profile.role === "admin"
      && profile.is_bot === true
      && profile.bot_key === botKey
      && (profile.email ?? "").toLowerCase() === email;
    if (!matches) {
      throw new ProvisionError(
        `Auth user ${userId} already has a profile that does not match ${botKey}. Password and profile were not changed.`,
      );
    }
    return { status: "already_provisioned", botKey, email, userId };
  } catch (error) {
    if (createdNow) {
      const removed = await client.auth.admin.deleteUser(userId);
      if (removed.error) {
        throw new ProvisionError(
          `Profile insert failed and the new auth user ${userId} could not be deleted: ${scrub(removed.error.message, password)}`,
        );
      }
    }
    if (error instanceof ProvisionError) throw error;
    const message = error instanceof Error ? error.message : "profile insert failed";
    throw new ProvisionError(scrub(message, password));
  }
}

async function readPassword(): Promise<string> {
  const fromEnv = process.env.BOT_USER_PASSWORD;
  if (fromEnv) return fromEnv;
  if (process.stdin.isTTY) {
    throw new ProvisionError(
      "Set BOT_USER_PASSWORD or pipe the password on stdin. It is not accepted from an interactive prompt.",
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

async function main(): Promise<void> {
  if (process.env.BOT_PROVISION_CONFIRM !== CONFIRM_VALUE) {
    throw new ProvisionError(
      `Refusing to create an auth user. Set BOT_PROVISION_CONFIRM=${CONFIRM_VALUE} after a separate CLEAR.`,
    );
  }
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new ProvisionError("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
  }
  const password = await readPassword();
  const client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const result = await provisionBotUser(client as unknown as BotProvisionClient, {
    botKey: arg("--bot-key"),
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

import { describe, expect, it, vi } from "vitest";
import {
  BOT_EMAILS,
  BOT_KEYS,
  ProvisionError,
  botEmail,
  provisionBotUser,
  resetBotPassword,
  unenrollBotMfa,
  type BotProvisionClient,
  type ProfileRow,
} from "./provision-bot-user";

const PASSWORD = "test-only-bot-password";

function client(options: {
  createError?: { message: string; code?: string } | null;
  userId?: string;
  users?: Array<{ id: string; email?: string | null }>;
  profile?: ProfileRow | null;
  insertError?: { message: string } | null;
  deleteError?: { message: string } | null;
  factors?: Array<{ id: string; factor_type?: string; status?: string }>;
} = {}) {
  const createUser = vi.fn(async () => ({
    data: options.createError ? { user: null } : { user: { id: options.userId ?? "user-1" } },
    error: options.createError ?? null,
  }));
  const deleteUser = vi.fn(async () => ({
    data: options.deleteError ? null : { user: {} },
    error: options.deleteError ?? null,
  }));
  const listUsers = vi.fn(async () => ({
    data: { users: options.users ?? [] },
    error: null,
  }));
  const updateUserById = vi.fn(async () => ({ data: { user: { id: options.userId ?? "user-1" } }, error: null }));
  const deleteFactor = vi.fn(async ({ id }: { id: string }) => ({ data: { id }, error: null }));
  const listFactors = vi.fn(async () => ({ data: { factors: options.factors ?? [] }, error: null }));
  const insert = vi.fn(async () => ({ error: options.insertError ?? null }));
  const maybeSingle = vi.fn(async () => ({ data: options.profile ?? null, error: null }));
  const fake = {
    auth: { admin: { createUser, deleteUser, listUsers, updateUserById, mfa: { listFactors, deleteFactor } } },
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle }) }),
      insert,
    }),
  } as unknown as BotProvisionClient;
  return { fake, createUser, deleteUser, listUsers, insert, updateUserById, deleteFactor, listFactors };
}

describe("provisionBotUser", () => {
  it("creates an admin bot through the Auth admin API and inserts the profile", async () => {
    const { fake, createUser, insert, deleteUser } = client();
    const result = await provisionBotUser(fake, {
      botKey: "bot-cos",
      fullName: "Chief of Staff",
      password: PASSWORD,
    });
    expect(result).toEqual({
      status: "created",
      botKey: "bot-cos",
      email: "cos@attractacq.com",
      userId: "user-1",
    });
    expect(createUser).toHaveBeenCalledWith({
      email: "cos@attractacq.com",
      password: PASSWORD,
      email_confirm: true,
      app_metadata: { is_bot: true, bot_key: "bot-cos" },
    });
    expect(insert).toHaveBeenCalledWith({
      id: "user-1",
      email: "cos@attractacq.com",
      full_name: "Chief of Staff",
      role: "admin",
      is_bot: true,
      bot_key: "bot-cos",
    });
    expect(deleteUser).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(PASSWORD);
  });

  it("rejects a bot key outside the allowlist before calling Auth", async () => {
    const { fake, createUser } = client();
    await expect(provisionBotUser(fake, {
      botKey: "bot-other",
      fullName: "Other",
      password: PASSWORD,
    })).rejects.toThrow(ProvisionError);
    expect(createUser).not.toHaveBeenCalled();
    expect(BOT_KEYS).toContain("bot-security");
    expect(botEmail("bot-cos")).toBe("cos@attractacq.com");
    expect(botEmail("bot-cdm")).toBe("delivery@attractacq.com");
    expect(botEmail("bot-admin")).toBe("ops-admin@attractacq.com");
    expect(botEmail("bot-finance")).toBe("finance@attractacq.com");
    expect(BOT_EMAILS["bot-cos"]).not.toBe("bot-cos@attractacq.com");
  });

  it("reports an existing user and does not change the password or profile", async () => {
    const { fake, deleteUser, insert } = client({
      createError: { message: "A user with this email address has already been registered", code: "email_exists" },
      users: [{ id: "existing-1", email: "sales@attractacq.com" }],
      profile: {
        id: "existing-1",
        role: "admin",
        is_bot: true,
        bot_key: "bot-sales",
        email: "sales@attractacq.com",
      },
    });
    const result = await provisionBotUser(fake, {
      botKey: "bot-sales",
      fullName: "Sales",
      password: PASSWORD,
    });
    expect(result.status).toBe("already_provisioned");
    expect(result.userId).toBe("existing-1");
    expect(insert).not.toHaveBeenCalled();
    expect(deleteUser).not.toHaveBeenCalled();
  });

  it("does not overwrite a conflicting profile", async () => {
    const { fake, insert, deleteUser } = client({
      createError: { code: "email_exists", message: "already been registered" },
      users: [{ id: "existing-2", email: "ops-admin@attractacq.com" }],
      profile: {
        id: "existing-2",
        role: "employee",
        is_bot: false,
        bot_key: null,
        email: "ops-admin@attractacq.com",
      },
    });
    await expect(provisionBotUser(fake, {
      botKey: "bot-admin",
      fullName: "Admin",
      password: PASSWORD,
    })).rejects.toThrow(/were not changed/);
    expect(insert).not.toHaveBeenCalled();
    expect(deleteUser).not.toHaveBeenCalled();
  });

  it("deletes the new auth user when the profile insert fails", async () => {
    const { fake, deleteUser } = client({
      insertError: { message: `profile failed near ${PASSWORD}` },
    });
    await expect(provisionBotUser(fake, {
      botKey: "bot-engineering",
      fullName: "Engineering",
      password: PASSWORD,
    })).rejects.toThrow(/\[redacted\]/);
    expect(deleteUser).toHaveBeenCalledWith("user-1");
  });

  it("creates the auth user already confirmed and does not ask Auth to send mail", async () => {
    const { fake, createUser } = client();
    await provisionBotUser(fake, { botKey: "bot-marketing", fullName: "Marketing", password: PASSWORD });
    const input = createUser.mock.calls[0]?.[0] as { email: string; email_confirm: boolean };
    expect(input.email).toBe("marketing@attractacq.com");
    expect(input.email_confirm).toBe(true);
    expect(JSON.stringify(createUser.mock.calls)).not.toMatch(/magiclink|recovery|invite/i);
  });
});

const botProfile: ProfileRow = {
  id: "user-1",
  role: "admin",
  is_bot: true,
  bot_key: "bot-cos",
  email: "cos@attractacq.com",
};

describe("bot credential maintenance", () => {
  it("resets a bot password through the admin API and refuses a human", async () => {
    const bot = client({
      users: [{ id: "user-1", email: "cos@attractacq.com" }],
      profile: botProfile,
    });
    const result = await resetBotPassword(bot.fake, { botKey: "bot-cos", password: PASSWORD });
    expect(result.status).toBe("reset");
    expect(bot.updateUserById).toHaveBeenCalledWith("user-1", { password: PASSWORD });
    expect(JSON.stringify(result)).not.toContain(PASSWORD);

    const human = client({
      users: [{ id: "human-1", email: "cos@attractacq.com" }],
      profile: { ...botProfile, id: "human-1", is_bot: false, bot_key: null, role: "admin" },
    });
    await expect(resetBotPassword(human.fake, { botKey: "bot-cos", password: PASSWORD }))
      .rejects.toThrow(/not bot bot-cos/);
    expect(human.updateUserById).not.toHaveBeenCalled();
  });

  it("does not change a password on dry-run", async () => {
    const { fake, updateUserById } = client({
      users: [{ id: "user-1", email: "cos@attractacq.com" }],
      profile: botProfile,
    });
    const result = await resetBotPassword(fake, { botKey: "bot-cos", password: "", dryRun: true });
    expect(result.status).toBe("dry_run");
    expect(updateUserById).not.toHaveBeenCalled();
  });

  it("deletes MFA factors for a bot and refuses a non-bot", async () => {
    const bot = client({
      users: [{ id: "user-1", email: "finance@attractacq.com" }],
      profile: { ...botProfile, bot_key: "bot-finance", email: "finance@attractacq.com" },
      factors: [
        { id: "factor-1", factor_type: "totp", status: "verified" },
        { id: "factor-2", factor_type: "totp", status: "unverified" },
      ],
    });
    const result = await unenrollBotMfa(bot.fake, { botKey: "bot-finance" });
    expect(result.factorIds).toEqual(["factor-1", "factor-2"]);
    expect(bot.deleteFactor).toHaveBeenCalledTimes(2);
    expect(bot.deleteFactor).toHaveBeenCalledWith({ id: "factor-1", userId: "user-1" });

    const dry = client({
      users: [{ id: "user-1", email: "finance@attractacq.com" }],
      profile: { ...botProfile, bot_key: "bot-finance", email: "finance@attractacq.com" },
      factors: [{ id: "factor-1" }],
    });
    const preview = await unenrollBotMfa(dry.fake, { botKey: "bot-finance", dryRun: true });
    expect(preview.status).toBe("dry_run");
    expect(dry.deleteFactor).not.toHaveBeenCalled();

    const human = client({
      users: [{ id: "human-1", email: "finance@attractacq.com" }],
      profile: { id: "human-1", role: "admin", is_bot: false, bot_key: null, email: "finance@attractacq.com" },
      factors: [{ id: "factor-9" }],
    });
    await expect(unenrollBotMfa(human.fake, { botKey: "bot-finance" })).rejects.toThrow(/not bot/);
    expect(human.deleteFactor).not.toHaveBeenCalled();
    expect(human.listFactors).not.toHaveBeenCalled();
  });
});

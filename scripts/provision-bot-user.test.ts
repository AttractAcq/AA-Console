import { describe, expect, it, vi } from "vitest";
import {
  BOT_BAN_DURATION,
  BOT_EMAILS,
  BOT_KEYS,
  CONFIRM,
  DISABLED_BOT_ROLE,
  ProvisionError,
  botEmail,
  disableBotUser,
  maintenanceDryRun,
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
  authUpdateError?: { message: string } | null;
  updateError?: { message: string } | null;
  rpcError?: { message: string } | null;
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
  const updateUserById = vi.fn(async () => ({
    data: options.authUpdateError ? { user: null } : { user: { id: options.userId ?? "user-1" } },
    error: options.authUpdateError ?? null,
  }));
  const deleteFactor = vi.fn(async ({ id }: { id: string }) => ({ data: { id }, error: null }));
  const listFactors = vi.fn(async () => ({ data: { factors: options.factors ?? [] }, error: null }));
  const rpc = vi.fn(async () => ({
    data: options.rpcError ? null : [{ sessions_deleted: 1, refresh_tokens_deleted: 1 }],
    error: options.rpcError ?? null,
  }));
  const insert = vi.fn(async () => ({ error: options.insertError ?? null }));
  const updateEq = vi.fn(async () => ({ error: options.updateError ?? null }));
  const update = vi.fn(() => ({ eq: updateEq }));
  const maybeSingle = vi.fn(async () => ({ data: options.profile ?? null, error: null }));
  const fake = {
    auth: {
      admin: {
        createUser, deleteUser, listUsers, updateUserById,
        mfa: { listFactors, deleteFactor },
      },
    },
    rpc,
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle }) }),
      insert,
      update,
    }),
  } as unknown as BotProvisionClient;
  return {
    fake, createUser, deleteUser, listUsers, insert, update, updateEq,
    updateUserById, deleteFactor, listFactors, rpc,
  };
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

  it("refuses to promote a pre-existing auth account into a bot", async () => {
    const { fake, deleteUser, insert } = client({
      createError: { message: "A user with this email address has already been registered", code: "email_exists" },
      users: [{ id: "existing-1", email: "sales@attractacq.com" }],
      profile: {
        id: "existing-1",
        role: "admin",
        is_bot: false,
        bot_key: null,
        email: "sales@attractacq.com",
      },
    });
    await expect(provisionBotUser(fake, {
      botKey: "bot-sales",
      fullName: "Sales",
      password: PASSWORD,
    })).rejects.toThrow(/Refusing to promote an existing account/);
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
    expect(bot.rpc).toHaveBeenCalledWith("revoke_bot_sessions", { p_user_id: "user-1" });
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
    const { fake, updateUserById, rpc } = client({
      users: [{ id: "user-1", email: "cos@attractacq.com" }],
      profile: botProfile,
    });
    const result = await resetBotPassword(fake, { botKey: "bot-cos", password: "", dryRun: true });
    expect(result.status).toBe("dry_run");
    expect(updateUserById).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
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
    expect(bot.rpc).toHaveBeenCalledWith("revoke_bot_sessions", { p_user_id: "user-1" });

    const dry = client({
      users: [{ id: "user-1", email: "finance@attractacq.com" }],
      profile: { ...botProfile, bot_key: "bot-finance", email: "finance@attractacq.com" },
      factors: [{ id: "factor-1" }],
    });
    const preview = await unenrollBotMfa(dry.fake, { botKey: "bot-finance", dryRun: true });
    expect(preview.status).toBe("dry_run");
    expect(dry.deleteFactor).not.toHaveBeenCalled();
    expect(dry.rpc).not.toHaveBeenCalled();

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

describe("disableBotUser", () => {
  const sales: ProfileRow = {
    id: "user-1",
    role: "admin",
    is_bot: true,
    bot_key: "bot-sales",
    email: "sales@attractacq.com",
  };

  it("bans, revokes sessions, and demotes without deleting the profile", async () => {
    const bot = client({
      users: [{ id: "user-1", email: "sales@attractacq.com" }],
      profile: sales,
    });
    const result = await disableBotUser(bot.fake, { botKey: "bot-sales" });
    expect(result).toEqual({
      status: "disabled",
      botKey: "bot-sales",
      email: "sales@attractacq.com",
      userId: "user-1",
      previousRole: "admin",
      role: DISABLED_BOT_ROLE,
      banDuration: BOT_BAN_DURATION,
    });
    expect(BOT_BAN_DURATION).toBe("876000h");
    expect(bot.updateUserById).toHaveBeenCalledWith("user-1", { ban_duration: "876000h" });
    expect(bot.updateUserById.mock.calls[0]?.[1]).not.toHaveProperty("password");
    expect(bot.rpc).toHaveBeenCalledWith("revoke_bot_sessions", { p_user_id: "user-1" });
    expect(bot.update).toHaveBeenCalledWith({ role: "employee" });
    expect(bot.updateEq).toHaveBeenCalledWith("id", "user-1");
    expect(bot.deleteUser).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toMatch(/password|service_role|secret/i);
  });

  it("is idempotent for a bot that is already an employee", async () => {
    const bot = client({
      users: [{ id: "user-1", email: "sales@attractacq.com" }],
      profile: { ...sales, role: "employee" },
    });
    const result = await disableBotUser(bot.fake, { botKey: "bot-sales" });
    expect(result.status).toBe("disabled");
    expect(result.previousRole).toBe("employee");
    expect(result.role).toBe("employee");
    expect(bot.updateUserById).toHaveBeenCalledTimes(1);
    expect(bot.rpc).toHaveBeenCalledTimes(1);
    expect(bot.update).toHaveBeenCalledWith({ role: "employee" });
    expect(bot.deleteUser).not.toHaveBeenCalled();
  });

  it("dry-runs by default and does not write", async () => {
    expect(maintenanceDryRun(undefined, CONFIRM.disable, false)).toBe(true);
    expect(maintenanceDryRun("nope", CONFIRM.disable, false)).toBe(true);
    expect(maintenanceDryRun(CONFIRM.disable, CONFIRM.disable, true)).toBe(true);
    expect(maintenanceDryRun(CONFIRM.disable, CONFIRM.disable, false)).toBe(false);

    const { fake, updateUserById, rpc, update, deleteUser } = client({
      users: [{ id: "user-1", email: "sales@attractacq.com" }],
      profile: sales,
    });
    const result = await disableBotUser(fake, { botKey: "bot-sales", dryRun: true });
    expect(result.status).toBe("dry_run");
    expect(result.previousRole).toBe("admin");
    expect(result.role).toBe("employee");
    expect(updateUserById).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(deleteUser).not.toHaveBeenCalled();
  });

  it("refuses a human and a missing auth user before any write", async () => {
    const human = client({
      users: [{ id: "human-1", email: "sales@attractacq.com" }],
      profile: { ...sales, id: "human-1", is_bot: false, bot_key: null },
    });
    await expect(disableBotUser(human.fake, { botKey: "bot-sales" })).rejects.toThrow(/not bot bot-sales/);
    expect(human.updateUserById).not.toHaveBeenCalled();
    expect(human.rpc).not.toHaveBeenCalled();
    expect(human.update).not.toHaveBeenCalled();
    expect(human.deleteUser).not.toHaveBeenCalled();

    const missing = client();
    await expect(disableBotUser(missing.fake, { botKey: "bot-cos" })).rejects.toThrow(/No auth user/);
    expect(missing.updateUserById).not.toHaveBeenCalled();
    expect(missing.deleteUser).not.toHaveBeenCalled();
  });

  it("stops after a failed ban and does not demote when session revoke fails", async () => {
    const banned = client({
      users: [{ id: "user-1", email: "sales@attractacq.com" }],
      profile: sales,
      authUpdateError: { message: "ban refused" },
    });
    await expect(disableBotUser(banned.fake, { botKey: "bot-sales" })).rejects.toThrow(/ban refused/);
    expect(banned.rpc).not.toHaveBeenCalled();
    expect(banned.update).not.toHaveBeenCalled();
    expect(banned.deleteUser).not.toHaveBeenCalled();

    const revoked = client({
      users: [{ id: "user-1", email: "sales@attractacq.com" }],
      profile: sales,
      rpcError: { message: "revoke refused" },
    });
    await expect(disableBotUser(revoked.fake, { botKey: "bot-sales" }))
      .rejects.toThrow(/banned but sessions were not revoked/);
    expect(revoked.update).not.toHaveBeenCalled();
    expect(revoked.deleteUser).not.toHaveBeenCalled();

    const demoted = client({
      users: [{ id: "user-1", email: "sales@attractacq.com" }],
      profile: sales,
      updateError: { message: "role refused" },
    });
    await expect(disableBotUser(demoted.fake, { botKey: "bot-sales" }))
      .rejects.toThrow(/profile role was not changed/);
    expect(demoted.deleteUser).not.toHaveBeenCalled();
  });
});

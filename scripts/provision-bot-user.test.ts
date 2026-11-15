import { describe, expect, it, vi } from "vitest";
import {
  BOT_KEYS,
  ProvisionError,
  botEmail,
  provisionBotUser,
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
  const insert = vi.fn(async () => ({ error: options.insertError ?? null }));
  const maybeSingle = vi.fn(async () => ({ data: options.profile ?? null, error: null }));
  const fake = {
    auth: { admin: { createUser, deleteUser, listUsers } },
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle }) }),
      insert,
    }),
  } as unknown as BotProvisionClient;
  return { fake, createUser, deleteUser, listUsers, insert };
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
      email: "bot-cos@attractacq.com",
      userId: "user-1",
    });
    expect(createUser).toHaveBeenCalledWith({
      email: "bot-cos@attractacq.com",
      password: PASSWORD,
      email_confirm: true,
      app_metadata: { is_bot: true, bot_key: "bot-cos" },
    });
    expect(insert).toHaveBeenCalledWith({
      id: "user-1",
      email: "bot-cos@attractacq.com",
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
    expect(botEmail("bot-finance")).toBe("bot-finance@attractacq.com");
  });

  it("reports an existing user and does not change the password or profile", async () => {
    const { fake, deleteUser, insert } = client({
      createError: { message: "A user with this email address has already been registered", code: "email_exists" },
      users: [{ id: "existing-1", email: "bot-sales@attractacq.com" }],
      profile: {
        id: "existing-1",
        role: "admin",
        is_bot: true,
        bot_key: "bot-sales",
        email: "bot-sales@attractacq.com",
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
      users: [{ id: "existing-2", email: "bot-admin@attractacq.com" }],
      profile: {
        id: "existing-2",
        role: "employee",
        is_bot: false,
        bot_key: null,
        email: "bot-admin@attractacq.com",
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
});

import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeConfig } from "../config.js";
import { handleCampaignActionRequest } from "../campaigns/actions/request-route.js";
import { handleGitHubStatus } from "../github/status-route.js";
import { handleSitesRoute } from "../github/sites-route.js";
import { handleInvitationInspect, handleInvitationList, handleInvitationRequest, handleInvitationSend } from "../invitations/routes.js";
import { logger } from "../logging/logger.js";
import { handleProofCaptureAdmin } from "../proof-capture/admin-route.js";
import {
  BOT_FORBIDDEN_CODE,
  requireAdminOrClientManager,
  requireHumanAdmin,
} from "./auth.js";
import { handleMasterChat } from "./route.js";
import {
  BOT_IDENTITY_COLUMNS,
  SENSITIVE_SERVICE_ROLE_TABLES,
  isSensitiveServiceRoleTable,
  writeTouchesBotIdentity,
} from "./scope.js";
import { runTool, type ToolContext } from "./tools.js";

const USER = "11111111-1111-4111-8111-111111111111";
const CLIENT = "00000000-0000-0000-0000-000000000001";
const CAMPAIGN = "00000000-0000-0000-0000-00000000000a";

beforeEach(() => {
  vi.spyOn(logger, "warn").mockImplementation(() => {});
  vi.spyOn(logger, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

function authClient(options: {
  appMetadata?: Record<string, unknown>;
  profile?: { role?: string; is_bot?: boolean } | null;
  profileSteps?: Array<{ data: unknown; error: { message?: string; code?: string } | null }>;
  manager?: string | null;
} = {}) {
  let step = 0;
  const from = vi.fn((table: string) => {
    const chain = {
      select: () => chain,
      eq: () => chain,
      gt: () => chain,
      order: () => chain,
      limit: () => chain,
      maybeSingle: async () => {
        if (table !== "profiles") return { data: null, error: null };
        if (options.profileSteps) {
          const current = options.profileSteps[Math.min(step, options.profileSteps.length - 1)]!;
          step += 1;
          return current;
        }
        return {
          data: options.profile === undefined ? { role: "admin", is_bot: false } : options.profile,
          error: null,
        };
      },
    };
    return chain;
  });
  const user = {
    id: USER,
    email: "admin@example.com",
    app_metadata: options.appMetadata ?? {},
  };
  const rpc = vi.fn(async (name: string) => {
    if (name === "active_video_approval_manager") return { data: options.manager ?? null, error: null };
    return { data: "should-not-run", error: null };
  });
  const sb = {
    auth: {
      getUser: async () => ({ data: { user }, error: null }),
      getClaims: async () => ({
        data: { claims: { sub: USER, role: "authenticated", aal: "aal2" } },
        error: null,
      }),
    },
    from,
    rpc,
  } as unknown as SupabaseClient;
  return { sb, from, rpc };
}

/** Role stays admin. The JWT claim alone is what makes this a bot. */
function botClient() {
  return authClient({
    appMetadata: { is_bot: true, bot_key: "bot-cos" },
    profile: { role: "admin", is_bot: false },
  });
}

function humanClient() {
  return authClient({ profile: { role: "admin", is_bot: false } });
}

function post(url: string, payload: unknown): IncomingMessage {
  const req = Readable.from([JSON.stringify(payload)]) as IncomingMessage;
  req.method = "POST";
  req.url = url;
  req.headers = { authorization: "Bearer token" };
  return req;
}

function capture() {
  let status = 0;
  let raw = "";
  const res = {
    writeHead(code: number) { status = code; },
    end(value?: string) { raw = value ?? ""; },
  } as unknown as ServerResponse;
  return {
    res,
    result: () => ({ status, body: raw ? JSON.parse(raw) as { ok?: boolean; error?: string } : {} }),
  };
}

async function expectBotDenied(run: (res: ServerResponse, sb: SupabaseClient) => Promise<void>) {
  const { sb } = botClient();
  const { res, result } = capture();
  await run(res, sb);
  const { status, body } = result();
  expect(status).toBe(403);
  expect(body.error).toBe(BOT_FORBIDDEN_CODE);
  expect(body.ok).toBe(false);
}

describe("requireHumanAdmin", () => {
  it("admits a human admin", async () => {
    const { sb } = humanClient();
    await expect(requireHumanAdmin(sb, "Bearer token")).resolves.toMatchObject({
      userId: USER,
      isBot: false,
    });
  });

  it("refuses a bot claim even when the profile row says is_bot false", async () => {
    const { sb } = botClient();
    await expect(requireHumanAdmin(sb, "Bearer token")).rejects.toMatchObject({
      status: 403,
      code: BOT_FORBIDDEN_CODE,
    });
  });

  it("refuses a bot_key claim with no is_bot flag", async () => {
    const { sb } = authClient({
      appMetadata: { bot_key: "bot-finance" },
      profile: { role: "admin", is_bot: false },
    });
    await expect(requireHumanAdmin(sb, "Bearer token")).rejects.toMatchObject({ code: BOT_FORBIDDEN_CODE });
  });

  it("refuses a profile is_bot row when the claim is clean", async () => {
    const { sb } = authClient({
      appMetadata: {},
      profile: { role: "admin", is_bot: true },
    });
    await expect(requireHumanAdmin(sb, "Bearer token")).rejects.toMatchObject({ code: BOT_FORBIDDEN_CODE });
  });

  it("fails closed when the profile lookup errors", async () => {
    const { sb } = authClient({
      profileSteps: [{ data: null, error: { message: "connection reset", code: "08006" } }],
    });
    await expect(requireHumanAdmin(sb, "Bearer token")).rejects.toMatchObject({ status: 503 });
  });

  it("falls back to the claim when is_bot is not in the schema yet", async () => {
    const missing = { data: null, error: { code: "42703", message: "column profiles.is_bot does not exist" } };
    const role = { data: { role: "admin" }, error: null };
    const human = authClient({ profileSteps: [missing, role] });
    await expect(requireHumanAdmin(human.sb, "Bearer token")).resolves.toMatchObject({ userId: USER, isBot: false });
    expect(logger.warn).toHaveBeenCalledWith(
      "bot_identity_column_missing",
      expect.objectContaining({ userId: USER }),
    );

    const bot = authClient({
      appMetadata: { is_bot: true },
      profileSteps: [missing, role],
    });
    await expect(requireHumanAdmin(bot.sb, "Bearer token")).rejects.toMatchObject({ code: BOT_FORBIDDEN_CODE });
  });

  it("accepts a PostgREST schema-cache miss the same way", async () => {
    const { sb } = authClient({
      profileSteps: [
        { data: null, error: { code: "PGRST204", message: "Could not find the 'is_bot' column of 'profiles' in the schema cache" } },
        { data: { role: "admin" }, error: null },
      ],
    });
    await expect(requireHumanAdmin(sb, "Bearer token")).resolves.toMatchObject({ isBot: false });
  });
});

describe("requireAdminOrClientManager", () => {
  it("refuses a bot admin and a bot who is the assigned manager", async () => {
    const admin = authClient({
      appMetadata: { bot_key: "bot-cos" },
      profile: { role: "admin", is_bot: false },
    });
    await expect(requireAdminOrClientManager(admin.sb, "Bearer token", CLIENT)).rejects.toMatchObject({
      code: BOT_FORBIDDEN_CODE,
    });

    const manager = authClient({
      appMetadata: {},
      profile: { role: "smm", is_bot: true },
      manager: USER,
    });
    await expect(requireAdminOrClientManager(manager.sb, "Bearer token", CLIENT)).rejects.toMatchObject({
      code: BOT_FORBIDDEN_CODE,
    });
  });
});

describe("bot sessions are refused on hard-hold routes", () => {
  it("POST /master/chat", async () => {
    await expectBotDenied((res, sb) => handleMasterChat(post("/master/chat", { message: "write the profiles" }), res, sb, {} as RuntimeConfig));
  });

  it("POST /admin/sites/provision", async () => {
    await expectBotDenied((res, sb) => handleSitesRoute(post("/admin/sites/provision", {}), res, sb, {} as RuntimeConfig, "provision"));
  });

  it("POST /admin/sites/publish", async () => {
    await expectBotDenied((res, sb) => handleSitesRoute(post("/admin/sites/publish", {}), res, sb, {} as RuntimeConfig, "publish"));
  });

  it("POST /admin/sites/request-page-approval", async () => {
    await expectBotDenied((res, sb) => handleSitesRoute(
      post("/admin/sites/request-page-approval", {}), res, sb, {} as RuntimeConfig, "request-page-approval",
    ));
  });

  it("POST /admin/invitations/request", async () => {
    await expectBotDenied((res, sb) => handleInvitationRequest(post("/admin/invitations/request", {}), res, sb, {} as RuntimeConfig));
  });

  it("POST /admin/invitations/send", async () => {
    await expectBotDenied((res, sb) => handleInvitationSend(post("/admin/invitations/send", {}), res, sb, {} as RuntimeConfig));
  });

  it("POST /admin/invitations/list", async () => {
    await expectBotDenied((res, sb) => handleInvitationList(post("/admin/invitations/list", {}), res, sb));
  });

  it("POST /admin/invitations/inspect", async () => {
    await expectBotDenied((res, sb) => handleInvitationInspect(post("/admin/invitations/inspect", {}), res, sb));
  });

  it("POST /admin/proof-capture", async () => {
    await expectBotDenied((res, sb) => handleProofCaptureAdmin(
      post("/admin/proof-capture", { clientId: CLIENT, action: "list" }), res, sb, {} as RuntimeConfig,
    ));
  });

  it("POST /admin/campaign-actions/request", async () => {
    const { sb, rpc } = botClient();
    const { res, result } = capture();
    await handleCampaignActionRequest(
      post("/admin/campaign-actions/request", { clientId: CLIENT, campaignId: CAMPAIGN, actionKey: "proof_publish" }),
      res,
      sb,
    );
    expect(result().status).toBe(403);
    expect(result().body.error).toBe(BOT_FORBIDDEN_CODE);
    expect(rpc).not.toHaveBeenCalledWith("request_campaign_proof_publish_v6", expect.anything());
  });

  it("GET /admin/github/status", async () => {
    const { sb } = botClient();
    const { res, result } = capture();
    const req = { method: "GET", headers: { authorization: "Bearer token" }, url: "/admin/github/status" } as unknown as IncomingMessage;
    await handleGitHubStatus(req, res, sb, {} as RuntimeConfig);
    expect(result().status).toBe(403);
    expect(result().body.error).toBe(BOT_FORBIDDEN_CODE);
  });
});

describe("a human admin still passes the sites gate", () => {
  it("is not refused as a bot on provision or publish", async () => {
    for (const action of ["provision", "publish"] as const) {
      const { sb } = humanClient();
      const { res, result } = capture();
      await handleSitesRoute(post(`/admin/sites/${action}`, {}), res, sb, {} as RuntimeConfig, action);
      expect(result().status).not.toBe(403);
      expect(result().body.error).not.toBe(BOT_FORBIDDEN_CODE);
    }
  });

  it("fails closed on provision when the profile lookup errors", async () => {
    const { sb } = authClient({
      profileSteps: [{ data: null, error: { message: "timeout", code: "57014" } }],
    });
    const { res, result } = capture();
    await handleSitesRoute(post("/admin/sites/provision", { clientId: CLIENT, repo: "harbour" }), res, sb, {} as RuntimeConfig, "provision");
    expect(result().status).toBe(503);
    expect(result().body.ok).toBe(false);
    expect(result().body.error).not.toBe(BOT_FORBIDDEN_CODE);
  });
});

describe("write_rows", () => {
  function writer() {
    const inserts: Array<{ table: string; row: unknown }> = [];
    const sb = {
      from: (table: string) => ({
        insert: (row: unknown) => {
          inserts.push({ table, row });
          return { select: async () => ({ data: [row], error: null }) };
        },
      }),
    } as unknown as SupabaseClient;
    return { sb, inserts };
  }

  function ctx(sb: SupabaseClient, flags: { isBot?: boolean; humanAdmin?: boolean } = {}): ToolContext {
    return {
      sb,
      scope: { kind: "company" },
      conversationId: "conv-1",
      actorId: USER,
      lastUserMessageAt: "2026-11-15T00:00:00.000Z",
      isBot: flags.isBot ?? false,
      humanAdmin: flags.humanAdmin ?? true,
    };
  }

  it("returns 403 bot_forbidden for a bot and does not write", async () => {
    const { sb, inserts } = writer();
    await expect(runTool(ctx(sb, { isBot: true, humanAdmin: false }), "write_rows", {
      table: "campaigns",
      op: "insert",
      values: { name: "Spring" },
    })).rejects.toMatchObject({ status: 403, code: BOT_FORBIDDEN_CODE });
    expect(inserts).toHaveLength(0);
  });

  it("returns 403 bot_forbidden for run_agent", async () => {
    const rpc = vi.fn();
    const sb = { rpc } as unknown as SupabaseClient;
    await expect(runTool(ctx(sb, { isBot: true }), "run_agent", {
      agent_key: "icp",
      client_id: CLIENT,
    })).rejects.toMatchObject({ status: 403, code: BOT_FORBIDDEN_CODE });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("lets a human admin insert a normal row", async () => {
    const { sb, inserts } = writer();
    const outcome = await runTool(ctx(sb), "write_rows", {
      table: "campaigns",
      op: "insert",
      values: { name: "Spring" },
    });
    expect(inserts).toEqual([{ table: "campaigns", row: { name: "Spring" } }]);
    expect(outcome.audit.mutating).toBe(true);
  });

  it("lets a human admin write a sensitive table", async () => {
    const { sb, inserts } = writer();
    await runTool(ctx(sb, { humanAdmin: true }), "write_rows", {
      table: "client_integrations",
      op: "insert",
      values: { provider: "meta" },
    });
    expect(inserts.map((row) => row.table)).toEqual(["client_integrations"]);
  });

  it("refuses a sensitive table when the caller is not a human admin", async () => {
    const { sb, inserts } = writer();
    await expect(runTool(ctx(sb, { isBot: false, humanAdmin: false }), "write_rows", {
      table: "client_billing",
      op: "insert",
      values: { monthly_amount: 1 },
    })).rejects.toThrow(/human admin/);
    expect(inserts).toHaveLength(0);
  });

  it("refuses profiles.is_bot and profiles.bot_key even for a human admin", async () => {
    for (const values of [{ is_bot: false }, { bot_key: null }, { Bot_Key: "bot-cos" }]) {
      const { sb, inserts } = writer();
      await expect(runTool(ctx(sb, { humanAdmin: true }), "write_rows", {
        table: "profiles",
        op: "update",
        values,
        filters: [{ column: "id", op: "eq", value: USER }],
      })).rejects.toThrow(/profiles\.is_bot or profiles\.bot_key/);
      expect(inserts).toHaveLength(0);
    }
  });
});

describe("sensitive service-role denylist", () => {
  it("names the real integration, contract, billing, finance, token, spend and sales tables", () => {
    expect(SENSITIVE_SERVICE_ROLE_TABLES).toEqual(expect.arrayContaining([
      "client_integrations",
      "client_contracts",
      "contract_payments",
      "client_billing",
      "finance_entries",
      "finance_periods",
      "mcp_bot_tokens",
      "mcp_bot_token_audit",
      "client_engine_budgets",
      "client_marketing_spend",
      "client_sales_entitlements",
      "client_users",
      "github_app_installations",
    ]));
    expect([...SENSITIVE_SERVICE_ROLE_TABLES]).not.toContain("invoices");
    expect([...SENSITIVE_SERVICE_ROLE_TABLES]).not.toContain("subscriptions");
    expect([...SENSITIVE_SERVICE_ROLE_TABLES]).not.toContain("campaigns");
  });

  it("matches schema-qualified token tables and ignores ordinary ones", () => {
    expect(isSensitiveServiceRoleTable("mcp_internal.mcp_bot_tokens")).toBe(true);
    expect(isSensitiveServiceRoleTable("public.client_billing")).toBe(true);
    expect(isSensitiveServiceRoleTable("campaigns")).toBe(false);
  });

  it("treats only profiles.is_bot and profiles.bot_key as bot identity", () => {
    expect(BOT_IDENTITY_COLUMNS).toEqual(["is_bot", "bot_key"]);
    expect(writeTouchesBotIdentity("profiles", { is_bot: false })).toBe(true);
    expect(writeTouchesBotIdentity("profiles", { full_name: "Ada" })).toBe(false);
    expect(writeTouchesBotIdentity("campaigns", { is_bot: true })).toBe(false);
  });
});

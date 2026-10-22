import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

import { handleCampaignActionRequest } from "./request-route.js";

/**
 * The door, not the work.
 *
 * This route exists because the request has to be built by the database from
 * the real package rather than by a browser from whatever it believes. So
 * what is worth asserting is who gets through it: an unauthenticated caller,
 * someone who is neither an admin nor this client's assigned manager, and —
 * the one that would be a real breach — somebody with authority over one
 * client passing another client's campaign id.
 */

const CLIENT = "00000000-0000-0000-0000-000000000001";
const OTHER = "00000000-0000-0000-0000-000000000002";
const CAMPAIGN = "00000000-0000-0000-0000-00000000000a";
const USER = "00000000-0000-0000-0000-0000000000ff";

async function call(
  sb: SupabaseClient,
  body: Record<string, unknown> = { clientId: CLIENT, campaignId: CAMPAIGN, actionKey: "proof_publish" },
) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]) as IncomingMessage;
  req.method = "POST";
  req.url = "/admin/campaign-actions/request";
  req.headers = { authorization: "Bearer test" };

  let code = 0;
  let payload: { ok?: boolean; error?: string; approvalId?: string } = {};
  const res = {
    writeHead: (c: number) => {
      code = c;
    },
    end: (text: string) => {
      payload = JSON.parse(text) as typeof payload;
    },
  } as unknown as ServerResponse;

  await handleCampaignActionRequest(req, res, sb);
  return { code, payload };
}

/** A caller who is an admin, and a campaign that belongs to CLIENT. */
function database(
  options: {
    role?: string;
    manager?: string | null;
    campaignClient?: string | null;
    requestError?: string;
  } = {},
) {
  const rpc = vi.fn(async (name: string) => {
    if (name === "active_video_approval_manager") {
      return { data: options.manager ?? null, error: null };
    }
    if (name === "request_campaign_proof_publish_v6") {
      return options.requestError
        ? { data: null, error: { message: options.requestError } }
        : { data: "approval-1", error: null };
    }
    return { data: null, error: null };
  });
  const from = vi.fn((table: string) => {
    const chain: Record<string, unknown> = {};
    Object.assign(chain, {
      select: () => chain,
      eq: () => chain,
      maybeSingle: async () =>
        table === "profiles"
          ? { data: { role: options.role ?? "admin" }, error: null }
          : {
              data:
                "campaignClient" in options && options.campaignClient === null
                  ? null
                  : { id: CAMPAIGN, client_id: options.campaignClient ?? CLIENT },
              error: null,
            },
    });
    return chain;
  });
  return {
    sb: {
      auth: { getUser: async () => ({ data: { user: { id: USER } }, error: null }) },
      from,
      rpc,
    } as unknown as SupabaseClient,
    rpc,
  };
}

describe("who may ask", () => {
  it("refuses a caller with no valid session", async () => {
    const sb = {
      auth: { getUser: async () => ({ data: { user: null }, error: new Error("nope") }) },
      from: vi.fn(),
      rpc: vi.fn(),
    } as unknown as SupabaseClient;
    const { code } = await call(sb);
    expect(code).toBe(401);
  });

  it("refuses somebody who is neither an admin nor this client's manager", async () => {
    const { sb, rpc } = database({ role: "smm", manager: "somebody-else" });
    const { code, payload } = await call(sb);
    expect(code).toBe(403);
    expect(payload.error).toContain("assigned manager");
    expect(rpc).not.toHaveBeenCalledWith("request_campaign_proof_publish_v6", expect.anything());
  });

  it("lets the assigned manager through without being an admin", async () => {
    const { sb, rpc } = database({ role: "smm", manager: USER });
    const { code, payload } = await call(sb);
    expect(code).toBe(200);
    expect(payload.approvalId).toBe("approval-1");
    expect(rpc).toHaveBeenCalledWith("request_campaign_proof_publish_v6", {
      p_campaign_id: CAMPAIGN,
      // Who asked, so the placement approvals record a person rather than
      // "the system".
      p_actor: USER,
    });
  });
});

describe("what may be asked for", () => {
  it("refuses a campaign belonging to a different client", async () => {
    // Authority over one client is not authority over any campaign id
    // somebody can guess.
    const { sb, rpc } = database({ campaignClient: OTHER });
    const { code, payload } = await call(sb);
    expect(code).toBe(404);
    expect(payload.error).toContain("does not belong to this client");
    expect(rpc).not.toHaveBeenCalledWith("request_campaign_proof_publish_v6", expect.anything());
  });

  it("refuses an action it cannot build a request for", async () => {
    const { sb } = database();
    const { code, payload } = await call(sb, {
      clientId: CLIENT,
      campaignId: CAMPAIGN,
      actionKey: "meta_ad_build",
    });
    expect(code).toBe(400);
    expect(payload.error).toContain("Only proof publication");
  });

  it("refuses anything that is not a pair of ids", async () => {
    const { sb } = database();
    const { code } = await call(sb, { clientId: "not-a-uuid", campaignId: CAMPAIGN });
    expect(code).toBe(400);
  });

  it("passes the database's own refusal back to whoever pressed the button", async () => {
    const { sb } = database({
      requestError: "This campaign has no drafted proof placements to publish.",
    });
    const { code, payload } = await call(sb);
    expect(code).toBe(400);
    expect(payload.error).toBe("This campaign has no drafted proof placements to publish.");
  });
});

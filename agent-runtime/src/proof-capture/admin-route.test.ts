import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { RuntimeConfig } from "../config.js";
import { expect, it, vi } from "vitest";
import { handleProofCaptureAdmin } from "./admin-route.js";
const clientId = "00000000-0000-0000-0000-000000000001";
async function call(
  sb: SupabaseClient,
  path = "/admin/proof-capture",
  token = "test",
  body: Record<string, unknown> = { clientId, action: "create_link" },
) {
  const req = Readable.from([
    Buffer.from(JSON.stringify(body)),
  ]) as IncomingMessage;
  req.method = "POST";
  req.url = path;
  req.headers = { authorization: `Bearer ${token}` };
  let code = 0;
  const res = {
    writeHead: (c: number) => {
      code = c;
    },
    end: () => {},
  } as unknown as ServerResponse;
  await handleProofCaptureAdmin(req, res, sb, {
    mcpServiceSecret: "internal-secret",
  } as RuntimeConfig);
  return code;
}
it("requires a valid session for console access", async () => {
  const from = vi.fn();
  expect(
    await call({
      auth: {
        getUser: async () => ({ data: { user: null }, error: new Error() }),
      },
      from,
    } as unknown as SupabaseClient),
  ).toBe(401);
  expect(from).not.toHaveBeenCalled();
});
it("rejects users who are neither admins nor assigned managers", async () => {
  const chain = {
    select: () => chain,
    eq: () => chain,
    maybeSingle: async () => ({ data: { role: "smm" }, error: null }),
  };
  const sb = {
    auth: {
      getUser: async () => ({ data: { user: { id: "other" } }, error: null }),
    },
    from: () => chain,
    rpc: async () => ({ data: "assigned-manager", error: null }),
  } as unknown as SupabaseClient;
  expect(await call(sb)).toBe(403);
});
it("rejects incorrect internal secrets before reading client data", async () => {
  const from = vi.fn();
  expect(
    await call(
      { from } as unknown as SupabaseClient,
      "/internal/proof-capture/event",
      "incorrect",
    ),
  ).toBe(401);
  expect(from).not.toHaveBeenCalled();
});

it("refuses an outcome request when consent no longer matches the lead contact", async () => {
  const leadId = "00000000-0000-0000-0000-000000000002";
  const consentId = "00000000-0000-0000-0000-000000000003";
  const configId = "00000000-0000-0000-0000-000000000004";
  const eventId = "00000000-0000-0000-0000-000000000005";
  const from = vi.fn((table: string) => {
    const rows: Record<string, unknown> = {
      profiles: { role: "admin" },
      proof_capture_configs: {
        id: configId, method: "outcome_followup", trigger_event: "sale",
        message_template: "Please share your experience: {{capture_link}}",
      },
      client_leads: { id: leadId, name: "Customer", stage: "sale", email: "current@example.invalid" },
      proof_outcome_followup_consents_v7: {
        id: consentId, lead_id: leadId, channel: "email",
        recipient: "old@example.invalid", withdrawn_at: null,
      },
      proof_service_outcomes_v7: {
        id: eventId, lead_id: leadId, verified_at: new Date().toISOString(),
        withdrawn_at: null,
      },
    };
    const chain = {
      select: () => chain,
      eq: () => chain,
      maybeSingle: async () => ({ data: rows[table], error: null }),
    };
    return chain;
  });
  const sb = {
    auth: { getUser: async () => ({ data: { user: { id: "admin" } }, error: null }) },
    from,
    rpc: async () => ({ data: null, error: null }),
  } as unknown as SupabaseClient;
  expect(await call(sb, "/admin/proof-capture", "test", {
    clientId, action: "queue_delivery", configId, leadId, consentId, eventId,
  })).toBe(400);
  expect(from).not.toHaveBeenCalledWith("proof_capture_links");
  expect(from).not.toHaveBeenCalledWith("proof_request_deliveries");
});

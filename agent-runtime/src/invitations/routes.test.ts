import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import type { RuntimeConfig } from "../config.js";
import { existingAuthEmail, handleInvitationAccept, handleInvitationRequest, handleInvitationSend, sendApprovedInvitation } from "./routes.js";

const REQUEST = "11111111-1111-4111-8111-111111111111";
const ADMIN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const INVITED = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const HASH = "a".repeat(64);
const ORIGIN = "https://console.attractacq.com";
const SENDER = "auth@attractacq.com";
const PROJECT_ORIGIN = "https://project.supabase.co";
const EMAIL = "new@example.com";
const VERIFICATION = "55555555-5555-4555-8555-555555555555";
const TEMPLATE_SUBJECT = "Your AA Console invitation";
const TEMPLATE_BODY = "Accept your invitation using the secure link.";
const TEMPLATE_HASH = "c".repeat(64);
const redirect = `${ORIGIN}/invite/accept?request=${REQUEST}`;
const config = {
  authInviteSenderEmail: SENDER, consoleUrl: ORIGIN,
  supabaseUrl: "https://project.supabase.co",
} as RuntimeConfig;

function fakeRequest(status = "approved") {
  return {
    id: REQUEST, idempotency_key: "22222222-2222-4222-8222-222222222222",
    recipient_email: EMAIL, target_role: "employee",
    target_member_id: "33333333-3333-4333-8333-333333333333", target_client_id: null,
    sender_account: SENDER, redirect_origin: ORIGIN, requested_by: ADMIN,
    payload_hash: HASH, payload: {
      recipient_email: EMAIL, sender_account: SENDER, redirect_url: redirect,
      auth_project_origin: PROJECT_ORIGIN, sender_verification_id: VERIFICATION,
      smtp_evidence_sha256: "b".repeat(64), template_subject: TEMPLATE_SUBJECT,
      template_body: TEMPLATE_BODY, template_sha256: TEMPLATE_HASH,
    }, status,
  };
}

function fakeService(row = fakeRequest(), senderVerified = true,
  verificationOverrides: Record<string,unknown> = {}) {
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
    if (name === "claim_console_invitation_send_v6") row.status = "sending";
    if (name === "finish_console_invitation_send_v6") row.status = String(args.p_outcome);
    if (name === "mark_console_invitation_conflict_v6") row.status = "conflict";
    return { data: row, error: null };
  });
  const listUsers = vi.fn(async () => ({ data: { users: [] }, error: null }));
  const inviteUserByEmail = vi.fn(async () => ({
    data: { user: { id: INVITED, email: EMAIL } }, error: null,
  }));
  const sb = {
    from: vi.fn((table: string) => {
      const query = {
        eq: () => query, gt: () => query, order: () => query, limit: () => query,
        maybeSingle: async () => ({ data: table === "console_auth_sender_verifications_v6"
          ? senderVerified ? { id: VERIFICATION, verified_at: new Date().toISOString(),
            template_subject: TEMPLATE_SUBJECT, template_body: TEMPLATE_BODY,
            template_sha256: TEMPLATE_HASH, evidence_sha256: "b".repeat(64),
            ...verificationOverrides } : null : row, error: null }),
      };
      return { select: () => query };
    }),
    rpc, auth: { admin: { listUsers, inviteUserByEmail } },
  } as unknown as SupabaseClient;
  return { sb, rpc, listUsers, inviteUserByEmail, row };
}

describe("trusted Auth invitation runtime", () => {
  function bodyRequest(value: Record<string,unknown>): IncomingMessage {
    const request = Readable.from([JSON.stringify(value)]) as IncomingMessage;
    request.method = "POST";
    request.headers = { authorization: "Bearer token" };
    return request;
  }

  function responseCapture(): { res: ServerResponse; result: () => { status: number; body: string } } {
    let status = 0;
    let body = "";
    return {
      res: { writeHead(code: number) { status = code; }, end(value: string) { body = value; } } as unknown as ServerResponse,
      result: () => ({ status, body }),
    };
  }

  it("keeps every send path inert, even with approval and provider configuration", async () => {
    const service = fakeService();
    await expect(sendApprovedInvitation(service.sb, config, REQUEST, ADMIN, HASH))
      .rejects.toThrow(/sending is disabled/i);
    expect(service.rpc).not.toHaveBeenCalled();
    expect(service.inviteUserByEmail).not.toHaveBeenCalled();
    expect(service.sb.auth.admin.generateLink).toBeUndefined();
  });

  it("returns 503 from the authenticated send route without a claim or provider call", async () => {
    const { res, result } = responseCapture();
    const service = fakeService();
    const from = vi.fn((table: string) => ({ select: () => ({
      eq: () => ({ maybeSingle: async () => ({ data: table === "profiles"
        ? { role: "admin" } : null, error: null }) }),
    }) }));
    const sb = { ...service.sb, from, auth: { ...service.sb.auth,
      getUser: async () => ({ data: { user: { id: ADMIN, email: "admin@example.com" } }, error: null }),
      getClaims: async () => ({ data: { claims: { sub: ADMIN, role: "authenticated", aal: "aal2" } }, error: null }),
    } } as unknown as SupabaseClient;
    await handleInvitationSend(bodyRequest({ requestId: REQUEST, expectedHash: HASH }), res, sb, config);
    expect(result().status).toBe(503);
    expect(result().body).toContain("sending is disabled");
    expect(service.rpc).not.toHaveBeenCalled();
    expect(service.inviteUserByEmail).not.toHaveBeenCalled();
  });

  it("fails closed when Auth Admin lookup fails", async () => {
    const service = fakeService();
    service.listUsers.mockRejectedValueOnce(new Error("Auth offline"));
    await expect(existingAuthEmail(service.sb, EMAIL)).rejects.toThrow(/Could not verify existing Auth accounts/);
    expect(service.inviteUserByEmail).not.toHaveBeenCalled();
  });

  it.each([
    ["forged subject", { sub: OTHER, role: "authenticated", aal: "aal2" }],
    ["AAL1 session", { sub: ADMIN, role: "authenticated", aal: "aal1" }],
  ])("rejects %s before reading a request body or writing a card", async (_label, claims) => {
    const rpc = vi.fn();
    const sb = {
      auth: {
        getUser: vi.fn(async () => ({ data: { user: { id: ADMIN, email: "admin@example.com" } }, error: null })),
        getClaims: vi.fn(async () => ({ data: { claims }, error: null })),
      }, rpc,
    } as unknown as SupabaseClient;
    let status = 0;
    let body = "";
    const req = { method: "POST", headers: { authorization: "Bearer token" } } as IncomingMessage;
    const res = {
      writeHead(code: number) { status = code; },
      end(value: string) { body = value; },
    } as unknown as ServerResponse;
    await handleInvitationRequest(req, res, sb, config);
    expect(status).toBe(401);
    expect(JSON.parse(body).ok).toBe(false);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("redacts raw request RPC errors from the browser response", async () => {
    const { res, result } = responseCapture();
    const rpc = vi.fn(async () => ({ data: null,
      error: { message: "duplicate user new@example.com, internal table and token secret" } }));
    const from = vi.fn((table: string) => {
      const query = {
        eq: () => query, gt: () => query, order: () => query, limit: () => query,
        maybeSingle: async () => ({ data: table === "profiles" ? { role: "admin" }
          : table === "console_auth_sender_verifications_v6" ? {
            id: VERIFICATION, verified_at: new Date().toISOString(),
            template_subject: TEMPLATE_SUBJECT, template_body: TEMPLATE_BODY,
            template_sha256: TEMPLATE_HASH, evidence_sha256: "b".repeat(64),
          }
            : null, error: null }),
      };
      return { select: () => query };
    });
    const sb = { from, rpc, auth: {
      getUser: async () => ({ data: { user: { id: ADMIN, email: "admin@example.com" } }, error: null }),
      getClaims: async () => ({ data: { claims: { sub: ADMIN, role: "authenticated", aal: "aal2" } }, error: null }),
      admin: { listUsers: async () => ({ data: { users: [] }, error: null }) },
    } } as unknown as SupabaseClient;
    await handleInvitationRequest(bodyRequest({ email: EMAIL, targetRole: "employee",
      memberId: "33333333-3333-4333-8333-333333333333",
      idempotencyKey: "44444444-4444-4444-8444-444444444444" }), res, sb, config);
    expect(result().status).toBe(409);
    expect(result().body).not.toContain("secret");
    expect(result().body).not.toContain(EMAIL);
  });

  it("redacts raw acceptance RPC errors from an invited user", async () => {
    const { res, result } = responseCapture();
    const sb = { rpc: vi.fn(async () => ({ data: null,
      error: { message: "auth.users internal detail and token secret" } })), auth: {
      getUser: async () => ({ data: { user: { id: INVITED, email: EMAIL } }, error: null }),
      getClaims: async () => ({ data: { claims: { sub: INVITED, role: "authenticated", aal: "aal1" } }, error: null }),
    } } as unknown as SupabaseClient;
    await handleInvitationAccept(bodyRequest({ requestId: REQUEST }), res, sb);
    expect(result().status).toBe(409);
    expect(result().body).not.toContain("secret");
    expect(result().body).not.toContain("auth.users");
  });
});

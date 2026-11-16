import type { SupabaseClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { reconcileUncertainGoogleReply } from "./reply-reconciler.js";

const target = { attempt_id: "attempt-1", client_id: "client-1", reply_id: "reply-1",
  location_ref: "accounts/a1/locations/l2", review_ref: "r3" };
const body = "Approved words";
const name = "accounts/a1/locations/l2/reviews/r3";
const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });

function db(options: { targetClient?: string; tokenAfter?: string } = {}) {
  let secrets = 0;
  const rpc = vi.fn(async (method: string, args?: Record<string, unknown>) => {
    if (method === "google_reply_reconciliation_target_v6") return {
      data: { ...target, client_id: options.targetClient ?? target.client_id }, error: null };
    if (method === "google_reply_credential_eligible_v6") return { data: true, error: null };
    if (method === "integration_secret") return {
      data: ++secrets === 2 ? options.tokenAfter ?? "token" : "token", error: null };
    if (method === "record_google_reply_reconciliation_v6") return {
      data: args?.p_provider_state === "APPROVED" ? "matched" : "pending", error: null };
    throw new Error(`Unexpected RPC ${method}`);
  });
  return { sb: { rpc } as unknown as SupabaseClient, rpc };
}

function provider(state = "APPROVED") {
  return vi.fn(async (url: RequestInfo | URL) => json(String(url).endsWith("/accounts/a1")
    ? { name: "accounts/a1" }
    : { name, reviewReply: { comment: body, reviewReplyState: state } })) as unknown as typeof fetch;
}

describe("uncertain Google reply readback", () => {
  it("records exact bytes and state with two GETs and no PUT", async () => {
    const { sb, rpc } = db();
    const fetchImpl = provider();
    await expect(reconcileUncertainGoogleReply(sb, "attempt-1", "client-1", fetchImpl))
      .resolves.toEqual({ status: "matched" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(rpc).toHaveBeenCalledWith("record_google_reply_reconciliation_v6", {
      p_attempt_id: "attempt-1", p_client_id: "client-1", p_review_ref: name,
      p_observed_body_hash: createHash("sha256").update(body).digest("hex"),
      p_provider_update_time: null, p_provider_state: "APPROVED",
    });
  });

  it("holds a cross-client target before reading a credential", async () => {
    const { sb, rpc } = db({ targetClient: "client-2" });
    const fetchImpl = provider();
    await expect(reconcileUncertainGoogleReply(sb, "attempt-1", "client-1", fetchImpl))
      .resolves.toMatchObject({ status: "held" });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("records pending moderation without claiming public success", async () => {
    const { sb } = db();
    await expect(reconcileUncertainGoogleReply(sb, "attempt-1", "client-1", provider("PENDING")))
      .resolves.toEqual({ status: "pending" });
  });

  it("does not record under a rotated credential", async () => {
    const { sb, rpc } = db({ tokenAfter: "rotated" });
    await expect(reconcileUncertainGoogleReply(sb, "attempt-1", "client-1", provider()))
      .resolves.toMatchObject({ status: "held" });
    expect(rpc).not.toHaveBeenCalledWith("record_google_reply_reconciliation_v6", expect.anything());
  });
});

import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { sendApprovedGoogleReply } from "./reply-sender.js";

const body = "Thank you for the review.";
const hash = createHash("sha256").update(body).digest("hex");
const name = "accounts/a1/locations/l2/reviews/r3";
const claim = {
  attempt_id: "attempt-1", claim_key: "key-1", reply_id: "reply-1",
  client_id: "client-1", exact_body: body, body_hash: hash,
  location_ref: "accounts/a1/locations/l2", review_ref: "r3",
};
const json = (value: unknown) => new Response(JSON.stringify(value), {
  status: 200, headers: { "Content-Type": "application/json" },
});

function database(options: { token?: string | null; eligible?: boolean; begin?: boolean; claim?: typeof claim | null } = {}) {
  const calls: string[] = [];
  const rpc = vi.fn(async (name: string) => {
    calls.push(name);
    if (name === "google_reply_credential_eligible_v6") return { data: options.eligible ?? true, error: null };
    if (name === "integration_secret") return { data: options.token === undefined ? "token" : options.token, error: null };
    if (name === "claim_google_reply_execution_v6") return { data: options.claim === undefined ? claim : options.claim, error: null };
    if (name === "begin_google_reply_write_v6") return { data: options.begin ?? true, error: null };
    if (name === "finish_google_reply_execution_v6") return { data: true, error: null };
    throw new Error(`Unexpected RPC ${name}`);
  });
  const sb = {
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({
      data: { id: "reply-1", client_id: "client-1" }, error: null,
    }) }) }) }),
    rpc,
  } as unknown as SupabaseClient;
  return { sb, rpc, calls };
}

describe("trusted Google reply sender", () => {
  it("does not reserve an attempt without a usable credential", async () => {
    const { sb, calls } = database({ token: null });
    const result = await sendApprovedGoogleReply(sb, "reply-1");
    expect(result).toMatchObject({ status: "held" });
    expect(calls).toEqual(["google_reply_credential_eligible_v6", "integration_secret"]);
  });

  it("holds a legacy or read-only credential before reading its token", async () => {
    const { sb, calls } = database({ eligible: false });
    const result = await sendApprovedGoogleReply(sb, "reply-1");
    expect(result).toMatchObject({ status: "held" });
    expect(calls).toEqual(["google_reply_credential_eligible_v6"]);
  });

  it("claims once, rechecks the credential and approval, and records provider readback", async () => {
    const { sb, rpc, calls } = database();
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(json({ name: "accounts/a1" }))
      .mockResolvedValueOnce(json({ name }))
      .mockResolvedValueOnce(json({ comment: body }))
      .mockResolvedValueOnce(json({ name, reviewReply: { comment: body, reviewReplyState: "APPROVED" } })) as unknown as typeof fetch;
    const result = await sendApprovedGoogleReply(sb, "reply-1", fetchImpl);
    expect(result).toMatchObject({ status: "confirmed", attemptId: "attempt-1" });
    expect(calls).toEqual(["google_reply_credential_eligible_v6", "integration_secret",
      "claim_google_reply_execution_v6", "google_reply_credential_eligible_v6",
      "integration_secret", "begin_google_reply_write_v6", "finish_google_reply_execution_v6"]);
    expect(rpc).toHaveBeenLastCalledWith("finish_google_reply_execution_v6",
      expect.objectContaining({ p_outcome: "confirmed", p_observed_body_hash: hash }));
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it("records a prewrite refusal without calling PUT", async () => {
    const { sb, rpc } = database({ begin: false });
    const fetchImpl = vi.fn(async (url: string) => json({ name: url.includes("accountmanagement")
      ? "accounts/a1" : name })) as unknown as typeof fetch;
    const result = await sendApprovedGoogleReply(sb, "reply-1", fetchImpl);
    expect(result).toMatchObject({ status: "refused" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(rpc).toHaveBeenLastCalledWith("finish_google_reply_execution_v6",
      expect.objectContaining({ p_outcome: "refused" }));
  });

  it("records a dropped write response as uncertain and does not retry", async () => {
    const { sb, rpc } = database();
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(json({ name: "accounts/a1" }))
      .mockResolvedValueOnce(json({ name }))
      .mockRejectedValueOnce(new Error("network dropped")) as unknown as typeof fetch;
    const result = await sendApprovedGoogleReply(sb, "reply-1", fetchImpl);
    expect(result).toMatchObject({ status: "uncertain" });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(rpc).toHaveBeenLastCalledWith("finish_google_reply_execution_v6",
      expect.objectContaining({ p_outcome: "uncertain" }));
  });

  it("does not mark a read-back reply posted while moderation is pending", async () => {
    const { sb, rpc } = database();
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(json({ name: "accounts/a1" }))
      .mockResolvedValueOnce(json({ name }))
      .mockResolvedValueOnce(json({ comment: body }))
      .mockResolvedValueOnce(json({ name, reviewReply: {
        comment: body, reviewReplyState: "PENDING",
      } })) as unknown as typeof fetch;
    const result = await sendApprovedGoogleReply(sb, "reply-1", fetchImpl);
    expect(result).toMatchObject({ status: "uncertain" });
    expect(rpc).toHaveBeenLastCalledWith("finish_google_reply_execution_v6",
      expect.objectContaining({ p_outcome: "uncertain" }));
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });
});

import { beforeEach, expect, it, vi } from "vitest";

import { loadApprovalExecutionEvidence } from "./approvalExecutionEvidence";

const from = vi.fn();
const rows = new Map<string, { data: unknown[]; error: { message: string } | null }>();
vi.mock("./supabase", () => ({ supabase: { from: (...args: unknown[]) => from(...args) } }));

beforeEach(() => {
  rows.clear();
  from.mockReset();
  from.mockImplementation((table: string) => ({
    select: () => ({ in: () => Promise.resolve(rows.get(table) ?? { data: [], error: null }) }),
  }));
});

it("joins only same-client attempt evidence to approved cards", async () => {
  rows.set("campaign_action_due", { data: [
    { approval_id: "action-a", client_id: "client-a", execution_status: "executed",
      blocker: null, external_id: "provider-1", external_url: null },
    { approval_id: "action-b", client_id: "other-client", execution_status: "executed",
      blocker: null, external_id: "provider-2", external_url: null },
  ], error: null });
  rows.set("google_reply_execution_overview_v6", { data: [
    { approval_request_id: "reply-card", client_id: "client-a", status: "uncertain",
      reconciliation_result: "different", provider_state: null },
  ], error: null });
  const evidence = await loadApprovalExecutionEvidence([
    { id: "card-a", client_id: "client-a", source_kind: "campaign_action",
      source_id: "action-a", status: "approved" },
    { id: "card-b", client_id: "client-a", source_kind: "campaign_action",
      source_id: "action-b", status: "revoked" },
    { id: "reply-card", client_id: "client-a", source_kind: "google_review_reply",
      source_id: "reply-1", status: "approved" },
    { id: "pending", client_id: "client-a", source_kind: "meta_profile_change",
      source_id: "change-1", status: "pending" },
  ]);
  expect(evidence.get("card-a")).toMatchObject({ state: "executed", externalRef: "provider-1" });
  expect(evidence.get("card-b")).toMatchObject({ state: "unknown", externalRef: null });
  expect(evidence.get("reply-card")?.detail).toContain("Readback: different");
  expect(evidence.has("pending")).toBe(false);
});

it("shows unknown when an execution ledger read fails", async () => {
  rows.set("google_profile_execution_overview_v6", {
    data: [], error: { message: "ledger unavailable" },
  });
  const evidence = await loadApprovalExecutionEvidence([
    { id: "profile-card", client_id: "client-a", source_kind: "google_profile_change",
      source_id: "change-1", status: "approved" },
  ]);
  expect(evidence.get("profile-card")).toMatchObject({ state: "unknown",
    detail: "Execution ledger could not be read. Check the owning source." });
});

it("keeps proof placement and delivery outcomes tied to their own exact requests", async () => {
  rows.set("proof_approval_execution_evidence_v6", { data: [
    { request_id: "placement-card", client_id: "client-a", source_kind: "proof_placement",
      state: "retraction_required", detail: "Proof must be removed.", external_ref: "page-1" },
    { request_id: "delivery-card", client_id: "client-a", source_kind: "proof_delivery",
      state: "sent", detail: "A provider send is recorded for this delivery. The attempt is not bound to this exact approval request; recipient receipt is not proved.",
      external_ref: "message-1" },
    { request_id: "other-card", client_id: "other-client", source_kind: "proof_placement",
      state: "placed", detail: "Other tenant", external_ref: "page-2" },
  ], error: null });
  const evidence = await loadApprovalExecutionEvidence([
    { id: "placement-card", client_id: "client-a", source_kind: "proof_placement",
      source_id: "approval-1", status: "revoked" },
    { id: "delivery-card", client_id: "client-a", source_kind: "proof_delivery",
      source_id: "review-1", status: "approved" },
    { id: "other-card", client_id: "client-a", source_kind: "proof_placement",
      source_id: "approval-2", status: "approved" },
  ]);
  expect(evidence.get("placement-card")).toMatchObject({ state: "retraction_required",
    externalRef: "page-1" });
  expect(evidence.get("delivery-card")?.detail).toContain("recipient receipt is not proved");
  expect(evidence.get("other-card")?.state).toBe("unknown");
});

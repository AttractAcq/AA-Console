import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { reconcileUncertainGoogleProfileField } from "./google-profile-reconciler.js";

const target = { attempt_id: "attempt-1", client_id: "client-1", change_id: "change-1",
  location_ref: "accounts/123/locations/456", field: "description", proposed_value: "After" };
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

function db(options: { targetClient?: string; tokenAfter?: string } = {}) {
  let secrets = 0;
  const rpc = vi.fn(async (name: string, args?: Record<string, unknown>) => {
    if (name === "google_profile_reconciliation_target_v6") return {
      data: { ...target, client_id: options.targetClient ?? target.client_id }, error: null };
    if (name === "google_reply_credential_eligible_v6") return { data: true, error: null };
    if (name === "integration_secret") return {
      data: ++secrets === 2 ? options.tokenAfter ?? "google-token" : "google-token", error: null };
    if (name === "record_google_profile_reconciliation_v6") return {
      data: args?.p_observed_value === "After" ? "matched" : "different", error: null };
    throw new Error(`Unexpected RPC ${name}`);
  });
  return { sb: { rpc } as unknown as SupabaseClient, rpc };
}

function provider(fieldValue = "After") {
  return vi.fn(async (url: RequestInfo | URL) => {
    const path = String(url);
    if (path.endsWith("/accounts/123")) return json({ name: "accounts/123" });
    if (path.includes("/accounts/123/locations?")) return json({ locations: [{ name: "locations/456" }] });
    return json({ name: "locations/456", profile: { description: fieldValue } });
  }) as unknown as typeof fetch;
}

describe("read-only Google location reconciliation", () => {
  it("records an exact merchant readback without another PATCH", async () => {
    const { sb, rpc } = db();
    const fetchImpl = provider();
    await expect(reconcileUncertainGoogleProfileField(sb, "attempt-1", "client-1", fetchImpl))
      .resolves.toEqual({ status: "matched" });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(rpc).toHaveBeenCalledWith("record_google_profile_reconciliation_v6", {
      p_attempt_id: "attempt-1", p_client_id: "client-1",
      p_observed_value: "After", p_provider_ref: "locations/456#description",
    });
  });

  it("refuses another client before credential access", async () => {
    const { sb, rpc } = db({ targetClient: "client-2" });
    const fetchImpl = provider();
    await expect(reconcileUncertainGoogleProfileField(sb, "attempt-1", "client-1", fetchImpl))
      .resolves.toMatchObject({ status: "held" });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("leaves a changed merchant value for review", async () => {
    const { sb, rpc } = db();
    await expect(reconcileUncertainGoogleProfileField(sb, "attempt-1", "client-1", provider("Still old")))
      .resolves.toEqual({ status: "different" });
    expect(rpc).toHaveBeenCalledWith("record_google_profile_reconciliation_v6",
      expect.objectContaining({ p_observed_value: "Still old" }));
  });

  it("does not record under a changed credential", async () => {
    const { sb, rpc } = db({ tokenAfter: "different-token" });
    await expect(reconcileUncertainGoogleProfileField(sb, "attempt-1", "client-1", provider()))
      .resolves.toMatchObject({ status: "held" });
    expect(rpc).not.toHaveBeenCalledWith("record_google_profile_reconciliation_v6", expect.anything());
  });
});

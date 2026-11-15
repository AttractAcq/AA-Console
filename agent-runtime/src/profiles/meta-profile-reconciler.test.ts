import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

import { reconcileUncertainMetaPageField } from "./meta-profile-reconciler.js";

const target = { attempt_id: "attempt-1", client_id: "client-1", change_id: "change-1",
  page_id: "123456", field: "about", proposed_value: "After" };
const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });

function db(options: { tokenAfter?: string; targetClient?: string } = {}) {
  let secrets = 0;
  const rpc = vi.fn(async (name: string, args?: Record<string, unknown>) => {
    if (name === "meta_profile_reconciliation_target_v6") return {
      data: { ...target, client_id: options.targetClient ?? target.client_id }, error: null };
    if (name === "meta_profile_write_credential_eligible_v6") return { data: true, error: null };
    if (name === "integration_secret") return {
      data: ++secrets === 2 ? options.tokenAfter ?? "page-token" : "page-token", error: null };
    if (name === "record_meta_profile_reconciliation_v6") return {
      data: args?.p_observed_value === "After" ? "matched" : "different", error: null };
    throw new Error(`Unexpected RPC ${name}`);
  });
  return { sb: { rpc } as unknown as SupabaseClient, rpc };
}

describe("read-only Meta Page reconciliation", () => {
  it("records a same-client observed field without a second POST", async () => {
    const { sb, rpc } = db();
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) =>
      String(url).includes("/me?") ? json({ id: "123456" })
        : json({ id: "123456", about: "After" })) as unknown as typeof fetch;
    await expect(reconcileUncertainMetaPageField(sb, "attempt-1", "client-1", fetchImpl))
      .resolves.toEqual({ status: "matched" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(rpc).toHaveBeenCalledWith("record_meta_profile_reconciliation_v6", {
      p_attempt_id: "attempt-1", p_client_id: "client-1",
      p_observed_value: "After", p_provider_ref: "facebook_page:123456#about",
    });
  });

  it("refuses another client before credential access", async () => {
    const { sb, rpc } = db({ targetClient: "client-2" });
    const fetchImpl = vi.fn();
    await expect(reconcileUncertainMetaPageField(sb, "attempt-1", "client-1", fetchImpl))
      .resolves.toMatchObject({ status: "held" });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("records a different live value without claiming a second write", async () => {
    const { sb, rpc } = db();
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) =>
      String(url).includes("/me?") ? json({ id: "123456" })
        : json({ id: "123456", about: "Still old" })) as unknown as typeof fetch;
    await expect(reconcileUncertainMetaPageField(sb, "attempt-1", "client-1", fetchImpl))
      .resolves.toEqual({ status: "different" });
    expect(rpc).toHaveBeenCalledWith("record_meta_profile_reconciliation_v6",
      expect.objectContaining({ p_observed_value: "Still old" }));
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("refuses to record a read under a changed credential", async () => {
    const { sb, rpc } = db({ tokenAfter: "different-token" });
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) =>
      String(url).includes("/me?") ? json({ id: "123456" })
        : json({ id: "123456", about: "After" })) as unknown as typeof fetch;
    await expect(reconcileUncertainMetaPageField(sb, "attempt-1", "client-1", fetchImpl))
      .resolves.toMatchObject({ status: "held" });
    expect(rpc).not.toHaveBeenCalledWith("record_meta_profile_reconciliation_v6", expect.anything());
  });
});

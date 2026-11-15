import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { writeApprovedGoogleProfileField } from "./google-profile-writer.js";

const claim = {
  attempt_id: "attempt-1", claim_key: "key-1", change_id: "change-1",
  client_id: "client-1", location_ref: "accounts/123/locations/456",
  field: "description", before_value: "Before", proposed_value: "After",
};
const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });

function database(options: { token?: string | null; claim?: typeof claim | null; begin?: boolean } = {}) {
  const calls: string[] = [];
  const rpc = vi.fn(async (name: string) => {
    calls.push(name);
    if (name === "integration_secret") return {
      data: options.token === undefined ? "token" : options.token, error: null,
    };
    if (name === "claim_google_profile_execution_v6") return {
      data: options.claim === undefined ? claim : options.claim, error: null,
    };
    if (name === "begin_google_profile_write_v6") return { data: options.begin ?? true, error: null };
    if (name === "finish_google_profile_execution_v6") return { data: true, error: null };
    throw new Error(`Unexpected RPC: ${name}`);
  });
  const sb = {
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({
      data: { id: "change-1", client_id: "client-1" }, error: null,
    }) }) }) }), rpc,
  } as unknown as SupabaseClient;
  return { sb, rpc, calls };
}

function provider(url: RequestInfo | URL, init?: RequestInit, readback = "After") {
  const target = String(url);
  if (target.includes("accountmanagement")) return json({ name: "accounts/123" });
  if (target.includes("/v1alpha/accounts/123/locations")) {
    return json({ locations: [{ name: "locations/456" }] });
  }
  return json({ name: "locations/456", profile: {
    description: init?.method === "PATCH" ? "After" : readback,
  } });
}

describe("disconnected one-shot Google profile writer", () => {
  it("does not reserve without a credential", async () => {
    const { sb, calls } = database({ token: null });
    await expect(writeApprovedGoogleProfileField(sb, "change-1"))
      .resolves.toMatchObject({ status: "held" });
    expect(calls).toEqual(["integration_secret"]);
  });

  it("holds an already reserved or stale proposal", async () => {
    const { sb, calls } = database({ claim: null });
    await expect(writeApprovedGoogleProfileField(sb, "change-1"))
      .resolves.toMatchObject({ status: "held" });
    expect(calls).toEqual(["integration_secret", "claim_google_profile_execution_v6"]);
  });

  it("begins once immediately before PATCH and records exact readback", async () => {
    const { sb, rpc, calls } = database();
    let reads = 0;
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).includes("/v1/locations/456") && init?.method === "GET") {
        reads += 1;
        return provider(url, init, reads === 1 ? "Before" : "After");
      }
      return provider(url, init);
    }) as unknown as typeof fetch;
    await expect(writeApprovedGoogleProfileField(sb, "change-1", fetchImpl))
      .resolves.toMatchObject({ status: "confirmed", providerRef: "locations/456#description" });
    expect(calls).toEqual(["integration_secret", "claim_google_profile_execution_v6",
      "integration_secret", "begin_google_profile_write_v6", "finish_google_profile_execution_v6"]);
    expect(rpc).toHaveBeenLastCalledWith("finish_google_profile_execution_v6",
      expect.objectContaining({ p_outcome: "confirmed", p_observed_value: "After" }));
    expect(fetchImpl).toHaveBeenCalledTimes(5);
  });

  it("records a failed prewrite before PATCH as refused", async () => {
    const { sb, rpc } = database({ begin: false });
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) =>
      provider(url, init, "Before")) as unknown as typeof fetch;
    await expect(writeApprovedGoogleProfileField(sb, "change-1", fetchImpl))
      .resolves.toMatchObject({ status: "refused" });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(rpc).toHaveBeenLastCalledWith("finish_google_profile_execution_v6",
      expect.objectContaining({ p_outcome: "refused" }));
  });

  it("records a dropped PATCH outcome as uncertain without retrying", async () => {
    const { sb, rpc } = database();
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PATCH") throw new Error("socket dropped");
      return provider(url, init, "Before");
    }) as unknown as typeof fetch;
    await expect(writeApprovedGoogleProfileField(sb, "change-1", fetchImpl))
      .resolves.toMatchObject({ status: "uncertain" });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(rpc).toHaveBeenLastCalledWith("finish_google_profile_execution_v6",
      expect.objectContaining({ p_outcome: "uncertain" }));
  });
});

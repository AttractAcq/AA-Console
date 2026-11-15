import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { writeApprovedMetaPageField } from "./meta-profile-writer.js";

const claim = { attempt_id: "attempt-1", claim_key: "key-1",
  change_id: "change-1", client_id: "client-1", page_id: "123456",
  field: "about", before_value: "Before", proposed_value: "After" };
const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });

function database(options: { eligible?: boolean; token?: string | null;
  claim?: typeof claim | null; begin?: boolean } = {}) {
  const calls: string[] = [];
  const rpc = vi.fn(async (name: string) => {
    calls.push(name);
    if (name === "meta_profile_write_credential_eligible_v6") return {
      data: options.eligible ?? true, error: null };
    if (name === "integration_secret") return {
      data: options.token === undefined ? "page-token" : options.token, error: null };
    if (name === "claim_meta_profile_execution_v6") return {
      data: options.claim === undefined ? claim : options.claim, error: null };
    if (name === "begin_meta_profile_write_v6") return { data: options.begin ?? true, error: null };
    if (name === "finish_meta_profile_execution_v6") return { data: true, error: null };
    throw new Error(`Unexpected RPC ${name}`);
  });
  const sb = {
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({
      data: { id: "change-1", client_id: "client-1" }, error: null,
    }) }) }) }), rpc,
  } as unknown as SupabaseClient;
  return { sb, rpc, calls };
}

function provider(url: RequestInfo | URL, init?: RequestInit, readback = "After") {
  if (String(url).includes("/me?")) return json({ id: "123456" });
  if (init?.method === "POST") return json({ success: true });
  return json({ id: "123456", about: readback });
}

describe("disconnected one-shot Meta Page writer", () => {
  it("holds an unreviewed credential before reserving an attempt", async () => {
    const { sb, calls } = database({ eligible: false });
    await expect(writeApprovedMetaPageField(sb, "change-1", "client-1"))
      .resolves.toMatchObject({ status: "held" });
    expect(calls).toEqual(["meta_profile_write_credential_eligible_v6"]);
  });

  it("rejects a cross-client job before reading a credential", async () => {
    const { sb, calls } = database();
    await expect(writeApprovedMetaPageField(sb, "change-1", "other-client"))
      .resolves.toMatchObject({ status: "held" });
    expect(calls).toEqual([]);
  });

  it("begins once before Page POST and records exact readback", async () => {
    const { sb, rpc, calls } = database();
    let reads = 0;
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (!String(url).includes("/me?") && init?.method === "GET") {
        reads += 1;
        return provider(url, init, reads === 1 ? "Before" : "After");
      }
      return provider(url, init);
    }) as unknown as typeof fetch;
    await expect(writeApprovedMetaPageField(sb, "change-1", "client-1", fetchImpl))
      .resolves.toMatchObject({ status: "confirmed",
        providerRef: "facebook_page:123456#about" });
    expect(calls).toEqual([
      "meta_profile_write_credential_eligible_v6", "integration_secret",
      "claim_meta_profile_execution_v6",
      "meta_profile_write_credential_eligible_v6", "integration_secret",
      "begin_meta_profile_write_v6", "finish_meta_profile_execution_v6",
    ]);
    expect(rpc).toHaveBeenLastCalledWith("finish_meta_profile_execution_v6",
      expect.objectContaining({ p_outcome: "confirmed", p_observed_value: "After" }));
  });

  it("records a failed prewrite before POST as refused", async () => {
    const { sb, rpc } = database({ begin: false });
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) =>
      provider(url, init, "Before")) as unknown as typeof fetch;
    await expect(writeApprovedMetaPageField(sb, "change-1", "client-1", fetchImpl))
      .resolves.toMatchObject({ status: "refused" });
    expect(rpc).toHaveBeenLastCalledWith("finish_meta_profile_execution_v6",
      expect.objectContaining({ p_outcome: "refused" }));
  });

  it("records a dropped POST outcome as uncertain", async () => {
    const { sb, rpc } = database();
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") throw new Error("socket dropped");
      return provider(url, init, "Before");
    }) as unknown as typeof fetch;
    await expect(writeApprovedMetaPageField(sb, "change-1", "client-1", fetchImpl))
      .resolves.toMatchObject({ status: "uncertain" });
    expect(rpc).toHaveBeenLastCalledWith("finish_meta_profile_execution_v6",
      expect.objectContaining({ p_outcome: "uncertain" }));
  });
});

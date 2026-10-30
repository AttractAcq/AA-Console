import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import type { RuntimeConfig } from "../config.js";
import type { AgentRow } from "../orchestration/registry.js";
import type { AgentJobRow } from "../queue.js";
import { resolvePayload, runProofPlacerJob, type ClaimedPlacement } from "./placer.js";

/**
 * The sweep's own behaviour, with the database and Google faked.
 *
 * The one assertion this file exists for is the hash check: the sweep asks
 * the database what the payload would hash to now, and refuses to post when
 * that differs from the hash the approval was given against. Everything
 * else here is about never recording a placement that did not happen, and
 * never retrying one that might have.
 */

const agent = { agent_key: "proof_placer" } as unknown as AgentRow;
const job = { id: "job-1", params: { limit: 5 } } as unknown as AgentJobRow;
const on = { proofPublishEnabled: true } as RuntimeConfig;
const off = { proofPublishEnabled: false } as RuntimeConfig;

const HASH = "c".repeat(64);

const PLACEMENT: ClaimedPlacement = {
  placement_id: "pl-1",
  client_id: "client-1",
  destination_key: "google_business_profile",
  provider: "google_business",
  artifact_version_id: "art-1",
  proof_id: null,
  asset_id: null,
  payload_hash: HASH,
  account_ref: "accounts/123/locations/456",
  attempt: 1,
};

function database(
  options: {
    claimed?: ClaimedPlacement[];
    currentHash?: string;
    token?: string | null;
    artifact?: { content?: string } | null;
    status?: number;
    body?: unknown;
    recordError?: string;
  } = {},
) {
  const events: Record<string, unknown>[] = [];
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
    calls.push({ name, args });
    if (name === "claim_proof_placements") return { data: options.claimed ?? [PLACEMENT], error: null };
    if (name === "proof_placement_payload_hash_v6") {
      return { data: options.currentHash ?? HASH, error: null };
    }
    if (name === "integration_secret") {
      return { data: "token" in options ? options.token : "a-token", error: null };
    }
    if (name === "record_proof_placed" && options.recordError) {
      return { data: null, error: { message: options.recordError } };
    }
    return { data: null, error: null };
  });
  const from = vi.fn((table: string) => {
    if (table === "agent_job_events") {
      return {
        insert: vi.fn(async (row: Record<string, unknown>) => {
          events.push(row);
          return { error: null };
        }),
      };
    }
    const chain: Record<string, unknown> = {};
    Object.assign(chain, {
      select: () => chain,
      eq: () => chain,
      maybeSingle: async () => ({
        data:
          "artifact" in options
            ? options.artifact
            : { content: "They said it took half as long.", supported_claim: "Halved it" },
        error: null,
      }),
    });
    return chain;
  });
  const fetchImpl = vi.fn(async () =>
    new Response(JSON.stringify(options.body ?? { name: "accounts/1/locations/2/localPosts/3" }), {
      status: options.status ?? 200,
    }),
  );
  vi.stubGlobal("fetch", fetchImpl);
  return { sb: { rpc, from, storage: { from: () => ({}) } } as unknown as SupabaseClient, events, calls, fetchImpl };
}

const callsTo = (calls: Array<{ name: string; args: Record<string, unknown> }>, name: string) =>
  calls.filter((call) => call.name === name).map((call) => call.args);

describe("the runtime switch", () => {
  it("claims nothing when proof placement is off", async () => {
    const { sb, calls, events } = database();
    const result = await runProofPlacerJob(sb, off, agent, job);

    expect(result).toEqual({ ok: true, retryable: false });
    expect(callsTo(calls, "claim_proof_placements")).toHaveLength(0);
    expect(String(events[0]?.description)).toContain("PROOF_PUBLISH_ENABLED");
  });
});

describe("the exact version, re-checked at the write", () => {
  it("uses the fixed provider fetch lifetime for a proof image", async () => {
    const createSignedUrl = vi.fn(async () => ({
      data: { signedUrl: "https://storage.example/a.png" }, error: null,
    }));
    const query: Record<string, unknown> = {};
    Object.assign(query, {
      select: () => query,
      eq: () => query,
      maybeSingle: async () => ({ data: { storage_path: "client-1/a.png", caption: "Proof" }, error: null }),
    });
    const sb = {
      from: () => query,
      storage: { from: () => ({ createSignedUrl }) },
    } as unknown as SupabaseClient;
    const result = await resolvePayload(sb, { ...PLACEMENT, artifact_version_id: null, asset_id: "asset-1" });
    expect(result.mediaUrl).toBe("https://storage.example/a.png");
    expect(createSignedUrl).toHaveBeenCalledWith("client-1/a.png", 3600);
  });

  it("refuses to post when the payload would now hash differently", async () => {
    const { sb, calls, fetchImpl } = database({ currentHash: "d".repeat(64) });
    await runProofPlacerJob(sb, on, agent, job);

    // Nothing left the building.
    expect(fetchImpl).not.toHaveBeenCalled();
    const failure = callsTo(calls, "record_proof_placement_failure")[0]!;
    expect(String(failure.p_reason)).toContain("changed since it was approved");
    expect(failure.p_retryable).toBe(false);
    expect(callsTo(calls, "record_proof_placed")).toHaveLength(0);
  });

  it("posts, and records the external id, when the hash still matches", async () => {
    const { sb, calls, fetchImpl } = database();
    await runProofPlacerJob(sb, on, agent, job);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(callsTo(calls, "record_proof_placed")).toEqual([
      {
        p_placement_id: "pl-1",
        p_external_id: "accounts/1/locations/2/localPosts/3",
        p_external_url: null,
      },
    ]);
  });

  it("refuses when the hash cannot be computed at all", async () => {
    const { sb, calls, fetchImpl } = database({ currentHash: "" });
    await runProofPlacerJob(sb, on, agent, job);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(String(callsTo(calls, "record_proof_placement_failure")[0]!.p_reason)).toContain(
      "no way to tell",
    );
  });

  it("does not persist a Google error that echoes a signed Storage URL", async () => {
    const { sb, calls, events } = database({
      status: 400,
      body: { error: "https://storage.example/storage/v1/object/sign/client-media/a.png?token=secret" },
    });
    await runProofPlacerJob(sb, on, agent, job);
    expect(String(callsTo(calls, "record_proof_placement_failure")[0]!.p_reason)).toContain("details withheld");
    expect(JSON.stringify({ calls, events })).not.toContain("token=secret");
  });
});

describe("what stops a placement before the transport", () => {
  it("fails non-retryably with no credential", async () => {
    const { sb, calls, fetchImpl } = database({ token: null });
    await runProofPlacerJob(sb, on, agent, job);

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(callsTo(calls, "record_proof_placement_failure")[0]).toMatchObject({
      p_retryable: false,
    });
  });

  it("fails non-retryably with no recorded location", async () => {
    const { sb, calls } = database({ claimed: [{ ...PLACEMENT, account_ref: null }] });
    await runProofPlacerJob(sb, on, agent, job);
    expect(String(callsTo(calls, "record_proof_placement_failure")[0]!.p_reason)).toContain(
      "no Business Profile location",
    );
  });

  it("fails loudly for a destination with no transport in this runtime", async () => {
    // Only reachable by marking a destination supported with nothing behind
    // it, which is the mistake worth a loud failure rather than silence.
    const { sb, calls } = database({
      claimed: [{ ...PLACEMENT, destination_key: "organic_social", provider: "meta" }],
    });
    await runProofPlacerJob(sb, on, agent, job);
    expect(String(callsTo(calls, "record_proof_placement_failure")[0]!.p_reason)).toContain(
      "no transport in this runtime for organic_social",
    );
  });

  it("fails non-retryably when the artifact has no words left in it", async () => {
    const { sb, calls, fetchImpl } = database({ artifact: { content: "  " } });
    await runProofPlacerJob(sb, on, agent, job);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(String(callsTo(calls, "record_proof_placement_failure")[0]!.p_reason)).toContain(
      "no content to post",
    );
  });
});

describe("placed but not recorded", () => {
  it("says the post may be live, and does not offer a retry", async () => {
    const { sb, calls } = database({ recordError: "deadlock detected" });
    await runProofPlacerJob(sb, on, agent, job);

    const failure = callsTo(calls, "record_proof_placement_failure")[0]!;
    expect(String(failure.p_reason)).toContain("Placed, but could not record it");
    expect(failure.p_retryable).toBe(false);
  });
});

describe("one placement's failure is its own", () => {
  it("carries on to the next and reports both", async () => {
    const { sb, calls, events } = database({
      claimed: [
        { ...PLACEMENT, placement_id: "pl-bad", account_ref: null },
        { ...PLACEMENT, placement_id: "pl-good" },
      ],
    });
    await runProofPlacerJob(sb, on, agent, job);

    expect(callsTo(calls, "record_proof_placement_failure")[0]).toMatchObject({
      p_placement_id: "pl-bad",
    });
    expect(callsTo(calls, "record_proof_placed")[0]).toMatchObject({ p_placement_id: "pl-good" });
    expect(events.map((event) => String(event.description))).toContain("1 placed, 1 not.");
  });
});

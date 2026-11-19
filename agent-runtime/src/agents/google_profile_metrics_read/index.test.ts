import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AgentJobRow } from "../../queue.js";
import type { AgentRow } from "../../orchestration/registry.js";
import type { RuntimeConfig } from "../../config.js";

const { readProfilePerformance, appendEvent } = vi.hoisted(() => ({
  readProfilePerformance: vi.fn(), appendEvent: vi.fn(),
}));
vi.mock("../../google-profile/performance-read.js", () => ({ readProfilePerformance }));
vi.mock("../../queue.js", () => ({ appendEvent }));

import { runGoogleProfileMetricsReadJob } from "./index.js";

const job = { id: "job-1", client_id: "client-1",
  input_table: "client_google_locations", input_id: "location-1" } as AgentJobRow;
const config = {} as RuntimeConfig;
const agent = {} as AgentRow;
let location: unknown;
let integration: unknown;
const rpc = vi.fn();
const from = vi.fn();
const db = { from, rpc } as unknown as SupabaseClient;

beforeEach(() => {
  vi.clearAllMocks();
  location = { id: "location-1", client_id: "client-1",
    location_ref: "accounts/123/locations/456", verification_state: "verified" };
  integration = { id: "integration-1", status: "active",
    credential_secret_id: "secret-1", token_expires_at: null };
  from.mockImplementation((table: string) => {
    const chain: Record<string, unknown> = {};
    Object.assign(chain, { select: () => chain, eq: () => chain,
      maybeSingle: async () => ({ data: table === "client_google_locations"
        ? location : integration, error: null }) });
    return chain;
  });
  rpc.mockImplementation(async (name: string) => ({
    data: name === "integration_secret" ? "token" : "run-1", error: null,
  }));
  readProfilePerformance.mockResolvedValue({
    locationRef: "accounts/123/locations/456", from: "2026-11-01",
    through: "2026-11-02", observedMetrics: ["WEBSITE_CLICKS"],
    points: [{ metric: "WEBSITE_CLICKS", day: "2026-11-01", value: "4" }],
  });
  appendEvent.mockResolvedValue(undefined);
});

describe("Business Profile performance job", () => {
  it("refuses a route-free job before any provider or credential access", async () => {
    const result = await runGoogleProfileMetricsReadJob(db, config, agent,
      { ...job, input_id: null } as AgentJobRow);
    expect(result.ok).toBe(false);
    expect(from).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("records only the exact location read and its dated provider points", async () => {
    const result = await runGoogleProfileMetricsReadJob(db, config, agent, job);
    expect(result.ok).toBe(true);
    expect(readProfilePerformance).toHaveBeenCalledWith(expect.objectContaining({
      locationRef: "accounts/123/locations/456", accessToken: "token",
    }));
    expect(rpc).toHaveBeenCalledWith("record_google_profile_performance_read_v8",
      expect.objectContaining({ p_client_id: "client-1", p_location_id: "location-1",
        p_integration_id: "integration-1", p_credential_secret_id: "secret-1",
        p_job_id: "job-1", p_points: [{ metric: "WEBSITE_CLICKS",
          day: "2026-11-01", value: "4" }] }));
  });

  it("holds an unverified location before resolving its credential", async () => {
    location = { ...(location as object), verification_state: "unverified" };
    const result = await runGoogleProfileMetricsReadJob(db, config, agent, job);
    expect(result.ok).toBe(false);
    expect(rpc).not.toHaveBeenCalled();
    expect(readProfilePerformance).not.toHaveBeenCalled();
  });

  it("does not claim success when the current-account recorder rejects the observation", async () => {
    rpc.mockImplementation(async (name: string) => name === "integration_secret"
      ? { data: "token", error: null }
      : { data: null, error: { message: "credential changed" } });
    const result = await runGoogleProfileMetricsReadJob(db, config, agent, job);
    expect(result).toMatchObject({ ok: false, retryable: false });
  });
});

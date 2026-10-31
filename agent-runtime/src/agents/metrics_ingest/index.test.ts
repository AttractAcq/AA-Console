import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import type { RuntimeConfig } from "../../config.js";
import type { AgentRow } from "../../orchestration/registry.js";
import type { AgentJobRow } from "../../queue.js";
import { runMetricsIngestJob } from "./index.js";
import { SourceError, type MetricsSource } from "./types.js";

const agent = { agent_key: "metrics_ingest" } as AgentRow;
const config = {} as RuntimeConfig;
const job = {
  id: "job-1", client_id: "client-1", params: { surface: "organic", since: "2026-10-01", until: "2026-10-02" },
} as unknown as AgentJobRow;

function database(status: string, secret: string | null) {
  const patches: Array<{ values: Record<string, unknown>; filters: Record<string, unknown> }> = [];
  const integration = {
    id: "integration-1", credential_label: "ig-123", ad_account_id: null, status,
  };
  const rpc = vi.fn(async (name: string) => {
    if (name === "integration_secret") return { data: secret, error: null };
    return { data: null, error: { message: `Unexpected RPC ${name}` } };
  });
  const from = vi.fn((table: string) => {
    if (table === "agent_job_events") return { insert: vi.fn(async () => ({ error: null })) };
    if (table !== "client_integrations") throw new Error(`Unexpected table ${table}`);
    const query = {
      select: () => query,
      eq: () => query,
      maybeSingle: async () => ({ data: integration, error: null }),
      update: (values: Record<string, unknown>) => {
        const filters: Record<string, unknown> = {};
        const update = {
          eq: (column: string, value: unknown) => {
            filters[column] = value;
            if (Object.keys(filters).length === 2) {
              patches.push({ values, filters });
              return Promise.resolve({ error: null });
            }
            return update;
          },
        };
        return update;
      },
    };
    return query;
  });
  return { sb: { from, rpc } as unknown as SupabaseClient, rpc, patches };
}

function source(fetch: MetricsSource["fetch"]): MetricsSource {
  return { name: "fake Meta Graph", fetch };
}

describe("metrics execution-time credential gate", () => {
  it("uses a future expiring token and preserves its warning after a successful pull", async () => {
    const { sb, rpc, patches } = database("expiring", "usable-token");
    const fetch = vi.fn<MetricsSource["fetch"]>(async () => []);
    const result = await runMetricsIngestJob(sb, config, agent, job, 0, source(fetch));
    expect(result.ok).toBe(true);
    expect(rpc).toHaveBeenCalledWith("integration_secret", {
      p_client_id: "client-1", p_provider: "instagram",
    });
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]?.[2]).toMatchObject({ accessToken: "usable-token", accountId: "ig-123" });
    expect(patches).toHaveLength(1);
    expect(patches[0]).toMatchObject({
      values: { status: "expiring" }, filters: { id: "integration-1", status: "expiring" },
    });
  });

  it("promotes only connected to active, with a compare-and-swap on the integration row", async () => {
    const { sb, patches } = database("connected", "usable-token");
    await runMetricsIngestJob(sb, config, agent, job, 0, source(async () => []));
    expect(patches[0]).toMatchObject({
      values: { status: "active" }, filters: { id: "integration-1", status: "connected" },
    });
  });

  it.each(["error", "revoked", "expired", "expiring"])(
    "never calls the provider if the SQL credential gate rejects %s",
    async (status) => {
      const { sb } = database(status, null);
      const fetch = vi.fn(async () => []);
      const result = await runMetricsIngestJob(sb, config, agent, job, 0, source(fetch));
      expect(result).toMatchObject({ ok: false, retryable: false });
      expect(result.failureMessage).toMatch(/no currently usable instagram integration/);
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("marks only the failing integration row as error after a provider credential rejection", async () => {
    const { sb, patches } = database("expiring", "usable-token");
    const result = await runMetricsIngestJob(sb, config, agent, job, 0,
      source(async () => { throw new SourceError("revoked at provider", false); }));
    expect(result).toMatchObject({ ok: false, retryable: false, failureMessage: "revoked at provider" });
    expect(patches[0]).toMatchObject({
      values: { status: "error" }, filters: { id: "integration-1", status: "expiring" },
    });
  });
});

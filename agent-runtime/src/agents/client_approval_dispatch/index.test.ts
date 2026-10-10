import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, expect, it, vi } from "vitest";
import type { RuntimeConfig } from "../../config.js";
import type { AgentRow } from "../../orchestration/registry.js";
import type { AgentJobRow } from "../../queue.js";
import { runClientApprovalDispatchJob } from "./index.js";

const job: AgentJobRow = { id: "job-1", agent_key: "client_approval_dispatch", client_id: "client-1",
  input_table: "video_client_approval_requests", input_id: "video-1", params: { asset_id: "video-1" },
  status: "running", attempts: 1, max_attempts: 3, lease_owner: null, lease_until: null };
const config = { resendApiKey: null, resendFrom: "AA Console <hello@example.com>",
  consoleUrl: "https://console.example.com" } as RuntimeConfig;

function harness(over: { job_id?: string; rejected_at?: string | null; email?: string | null } = {}) {
  const request = { asset_id: "video-1", client_user_id: "user-1", job_id: over.job_id ?? "job-1",
    email_status: "pending", rejected_at: over.rejected_at ?? null };
  const stamps: Record<string, unknown>[] = [];
  const events: Record<string, unknown>[] = [];
  const rows: Record<string, unknown> = {
    video_client_approval_requests: request,
    profiles: { email: over.email === undefined ? "client@example.com" : over.email, full_name: "Sam <Client>" },
    client_media_assets: { title: "Launch <reel>", client_id: "client-1" },
    clients: { name: "Harbour & Co" },
  };
  const sb = { from(table: string) {
    const query: Record<string, unknown> = {};
    Object.assign(query, {
      select: () => query,
      eq: () => query,
      maybeSingle: async () => ({ data: rows[table] ?? null, error: null }),
      update: (value: Record<string, unknown>) => { stamps.push(value); return query; },
      insert: async (value: Record<string, unknown>) => { events.push(value); return { error: null }; },
      then: (resolve: (value: unknown) => unknown) => Promise.resolve({ error: null }).then(resolve),
    });
    return query;
  } } as unknown as SupabaseClient;
  return { sb, stamps, events };
}

afterEach(() => { vi.unstubAllGlobals(); });

it("keeps the dashboard request and reports when Resend is not configured", async () => {
  const { sb, stamps, events } = harness();
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  const result = await runClientApprovalDispatchJob(sb, config, {} as AgentRow, job);
  expect(result).toMatchObject({ ok: true });
  expect(stamps[0]).toMatchObject({ email_status: "skipped" });
  expect(events[0]).toMatchObject({ level: "warn" });
  expect(fetchMock).not.toHaveBeenCalled();
});

it("emails a dashboard link without exposing the private video", async () => {
  const { sb, stamps } = harness();
  const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => ({ ok: true }));
  vi.stubGlobal("fetch", fetchMock);
  const result = await runClientApprovalDispatchJob(sb,
    { ...config, resendApiKey: "test-key" }, {} as AgentRow, job);
  expect(result).toMatchObject({ ok: true });
  expect(stamps[0]).toMatchObject({ email_status: "sent" });
  const payload = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string);
  expect(payload.to).toEqual(["client@example.com"]);
  expect(payload.html).toContain("https://console.example.com/client/dashboard");
  expect(payload.html).toContain("Launch &lt;reel&gt;");
  expect(payload.html).not.toContain(".mp4");
});

it("does not email a superseded client request", async () => {
  const { sb, stamps } = harness({ job_id: "newer-job" });
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  expect(await runClientApprovalDispatchJob(sb,
    { ...config, resendApiKey: "test-key" }, {} as AgentRow, job)).toMatchObject({ ok: true });
  expect(stamps).toHaveLength(0);
  expect(fetchMock).not.toHaveBeenCalled();
});

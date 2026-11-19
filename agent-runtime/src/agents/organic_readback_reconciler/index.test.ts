import { expect, test, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { RuntimeConfig } from "../../config.js";
import type { AgentRow } from "../../orchestration/registry.js";
import type { AgentJobRow } from "../../queue.js";

vi.mock("../../queue.js", () => ({ appendEvent: vi.fn().mockResolvedValue(undefined) }));
import { runOrganicReadbackReconciliationJob } from "./index.js";

const target = {
  post_id: "post-1", client_id: "client-1", platform: "facebook",
  frame_position: 0, external_id: "123_456", expected_account_ref: "123",
};
const job = { id: "job-1", agent_key: "organic_readback_reconciler",
  client_id: null } as AgentJobRow;

function fakeDb(account = "123") {
  const due = { select: vi.fn(), order: vi.fn(), limit: vi.fn(), eq: vi.fn(),
    then: (done: (value: unknown) => unknown) => Promise.resolve({ data: [target], error: null }).then(done) };
  due.select.mockReturnValue(due); due.order.mockReturnValue(due);
  due.limit.mockReturnValue(due); due.eq.mockReturnValue(due);
  const integration = { select: vi.fn(), eq: vi.fn(), maybeSingle: vi.fn().mockResolvedValue({
    data: { credential_label: null, meta_page_id: account,
      credential_secret_id: "secret-version", status: "active" }, error: null,
  }) };
  integration.select.mockReturnValue(integration); integration.eq.mockReturnValue(integration);
  const rpc = vi.fn().mockImplementation((name: string) => Promise.resolve(name === "integration_secret"
    ? { data: "token", error: null } : { data: "event-1", error: null }));
  const from = vi.fn((name: string) => name === "organic_provider_readback_retry_due_v8"
    ? due : integration);
  return { sb: { from, rpc } as unknown as SupabaseClient, rpc, from };
}

test("rechecks the exact acknowledged ID and records verified account without a publish call", async () => {
  const { sb, rpc, from } = fakeDb();
  const read = vi.fn().mockResolvedValue({ status: "verified",
    observedAccountRef: "123", providerUrl: "https://facebook.com/123_456" });
  const result = await runOrganicReadbackReconciliationJob(sb, {} as RuntimeConfig,
    {} as AgentRow, job, undefined, { read });
  expect(result).toEqual({ ok: true, retryable: false });
  expect(read).toHaveBeenCalledWith({ platform: "facebook",
    accountId: "123", accessToken: "token" }, "123_456");
  expect(rpc.mock.calls.map(([name]) => name)).toEqual([
    "integration_secret", "record_organic_provider_readback_v8",
  ]);
  expect(from.mock.calls.map(([name]) => name)).toEqual([
    "organic_provider_readback_retry_due_v8", "client_integrations",
  ]);
});

test("holds a changed account before credential or provider access", async () => {
  const { sb, rpc } = fakeDb("999");
  const read = vi.fn();
  const result = await runOrganicReadbackReconciliationJob(sb, {} as RuntimeConfig,
    {} as AgentRow, job, undefined, { read });
  expect(result.ok).toBe(true);
  expect(read).not.toHaveBeenCalled();
  expect(rpc).not.toHaveBeenCalled();
});

test("records an unavailable read without asking to publish again", async () => {
  const { sb, rpc } = fakeDb();
  const read = vi.fn().mockRejectedValue(new Error("provider unavailable"));
  const result = await runOrganicReadbackReconciliationJob(sb, {} as RuntimeConfig,
    {} as AgentRow, job, undefined, { read });
  expect(result.ok).toBe(true);
  expect(rpc.mock.calls[1]?.[1]).toMatchObject({ p_state: "unavailable",
    p_observed_account_ref: null, p_provider_url: null });
});

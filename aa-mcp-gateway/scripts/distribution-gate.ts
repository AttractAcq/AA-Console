import assert from "node:assert/strict";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { distributionManager as config } from "../src/onboarding/distribution-manager.js";
import { assertAuthorizationDenial } from "./onboarding-denial.js";

export function assertDistributionDiscovery(actual: Iterable<string>) {
  assert.deepEqual([...new Set(actual)].sort(), [...config.expectedDiscovery].sort(),
    "Gate 10 requires exact discovery set equality");
}
export type DistributionFixtures = {
  approved_safe_fixtures: true;
  client_id: string; brief_id: string;
  approved_asset_id: string; pending_asset_id: string;
  denied_client_id: string; denied_task_id: string; denied_asset_id: string;
  assignee: string;
};
type Invoke = (name: string, args: Record<string, unknown>) => Promise<any>;

/** Gate 10 happy path: approved asset -> schedule -> record publication -> read. */
export async function runDistributionGate(invoke: Invoke, f: DistributionFixtures) {
  assert.equal(f.approved_safe_fixtures, true, "Only approved disposable fixtures may be mutated");
  assert.notEqual(f.client_id, f.denied_client_id);
  assert.notEqual(f.approved_asset_id, f.pending_asset_id);
  z.object({
    approved_safe_fixtures: z.literal(true),
    client_id: z.string().uuid(),
    brief_id: z.string().uuid(),
    approved_asset_id: z.string().uuid(),
    pending_asset_id: z.string().uuid(),
    denied_client_id: z.string().uuid(),
    denied_task_id: z.string().uuid(),
    denied_asset_id: z.string().uuid(),
    assignee: z.string().min(1),
  }).strict().parse(f);
  const client_id = f.client_id;
  const call = async (name: string, args: Record<string, unknown>, status = "completed") => {
    const r = await invoke(name, { client_id, ...args });
    assert.equal(r.status, status, `${name}: unexpected result`);
    return r;
  };
  // Read-only identity probe: the next activity read must contain this request's authenticated bot.
  const probe = await call("workflow.get_activity", { limit: 100 });
  const evidence = (await call("workflow.get_activity", { limit: 100 })).data.activity;
  assert.ok(evidence.some((a: any) => a.request_id === probe.request_id &&
    a.bot === config.bot_id && a.client_id === client_id && a.execution_result === "completed"),
    "Distribution identity must be verified before any writes");
  const write = async (name: string, args: Record<string, unknown>, status = "completed") => {
    const input = { ...args, idempotency_key: randomUUID() };
    const r = await call(name, input, status);
    const replay = await call(name, input, status);
    assert.deepEqual(replay.data, r.data);
    const activity = (await call("workflow.get_activity", { limit: 100 })).data.activity;
    assert.ok(activity.some((a: any) => a.request_id === r.request_id &&
      a.bot === config.bot_id && a.tool === name && a.execution_result === status &&
      a.authorization === "allowed"), `${name}: missing Distribution audit identity/result`);
    return r;
  };

  await call("content.get_brief", { brief_id: f.brief_id });
  await call("content.get_production_status", { asset_id: f.approved_asset_id });

  // Approved-asset happy path: schedule, then record publication (Alex CLEAR
  // #2: record_publication stands in for live platform publish).
  const scheduled_for = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
  const scheduled = await write("content.queue_distribution", {
    asset_id: f.approved_asset_id, scheduled_for, channel: "organic",
  });
  const schedule_id = scheduled.data.schedule_id;
  assert.ok(schedule_id, "Missing schedule_id");
  assert.equal(scheduled.data.publication_status, "scheduled");

  const afterSchedule = await call("content.get_production_status", { asset_id: f.approved_asset_id });
  assert.ok(afterSchedule.data.distribution.some((d: any) =>
    d.id === schedule_id && d.publication_status === "scheduled"), "Schedule not visible on read");

  const published = await write("content.record_publication", {
    schedule_id, status: "published", external_id: "gate-10-fixture",
  });
  assert.equal(published.data.publication_status, "published");

  const afterPublish = await call("content.get_production_status", { asset_id: f.approved_asset_id });
  assert.ok(afterPublish.data.distribution.some((d: any) =>
    d.id === schedule_id && d.publication_status === "published"), "Publication not visible on read");

  // Unapproved asset cannot be scheduled — a business-rule failure, not an
  // authorization denial (distinct from the three onboarding-denial categories).
  const unapproved = await invoke("content.queue_distribution", {
    client_id, asset_id: f.pending_asset_id, scheduled_for,
    idempotency_key: randomUUID(),
  });
  assert.equal(unapproved.status, "failed");
  assert.equal(unapproved.error?.code, "invalid_asset_status");

  const task = await write("workflow.create_task", { title: `Gate 10 onboarding fixture ${randomUUID()}` });
  const task_id = task.data.task.id;
  await write("workflow.assign_task", { task_id, assignee: f.assignee });
  assert.equal((await call("workflow.get_task", { task_id })).data.task.assignee, f.assignee);
  await write("workflow.complete_task", { task_id });
  assert.equal((await call("workflow.get_task", { task_id })).data.task.status, "complete");
  const pending = await write("workflow.create_approval", {
    summary: "Gate 10 informational fixture; no downstream action requested",
  }, "approval_required");
  const approvals = (await call("workflow.get_pending_approvals", { limit: 100 })).data.approvals;
  assert.ok(approvals.some((a: any) => a.approval_id === pending.approval_id &&
    a.requested_by_bot === config.bot_id && a.status === "pending" && a.execution_status === "not_started"));

  const deny = async (name: string, args: Record<string, unknown>, expected: Parameters<typeof assertAuthorizationDenial>[1]) =>
    assertAuthorizationDenial({ structuredContent: await invoke(name, { client_id, ...args }) }, expected);
  await deny("workflow.get_activity", { client_id: f.denied_client_id }, "client_scope");
  for (const [name, args] of [
    ["workflow.get_task", { task_id: f.denied_task_id }],
    ["content.get_production_status", { asset_id: f.denied_asset_id }],
  ] as const) await deny(name, args, "foreign_resource");
  // Granted-but-stub (content.get_performance, attribution.get_content_performance,
  // migration 65/75): documents the honest Phase 10 gap (no live Meta/etc.
  // publish or performance read yet). Behind MCP_DISCOVER_STUBS=false (the
  // default), a granted stub is indistinguishable from an ungranted tool —
  // same forbidden_tool denial as everything else in this loop.
  for (const name of ["economics.get_client_economics", "security.get_system_status",
    "engineering.get_deployment_status", "pipeline.list_leads", "sales_agents.list",
    "finance.read", "deploy.run", "infra.read", "secrets.read", "admin.read",
    ...config.forbidden.filter(n => n.includes(".")), ...config.stubs,
    "campaign.list", "campaign.get", "content.list_ideas", "content.get_idea"])
    await deny(name, { idempotency_key: randomUUID() }, "forbidden_tool");
}

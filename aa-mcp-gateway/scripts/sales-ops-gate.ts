import assert from "node:assert/strict";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { salesOps as config } from "../src/onboarding/sales-ops.js";
import { assertAuthorizationDenial } from "./onboarding-denial.js";

export function assertSalesOpsDiscovery(actual: Iterable<string>) {
  assert.deepEqual([...new Set(actual)].sort(), [...config.expectedDiscovery].sort(),
    "Gate 11 requires exact discovery set equality");
}
export type SalesOpsFixtures = {
  approved_safe_fixtures: true;
  client_id: string;
  lead_id: string;
  sales_agent_id: string;
  denied_client_id: string;
  denied_lead_id: string;
  denied_task_id: string;
  assignee: string;
};
type Invoke = (name: string, args: Record<string, unknown>) => Promise<any>;

/** Gate 11 happy path: lead reads -> stage move -> follow-up -> workflow task suite -> read back. */
export async function runSalesOpsGate(invoke: Invoke, f: SalesOpsFixtures) {
  assert.equal(f.approved_safe_fixtures, true, "Only approved disposable fixtures may be mutated");
  assert.notEqual(f.client_id, f.denied_client_id);
  assert.notEqual(f.lead_id, f.denied_lead_id);
  z.object({
    approved_safe_fixtures: z.literal(true),
    client_id: z.string().uuid(),
    lead_id: z.string().uuid(),
    sales_agent_id: z.string().uuid(),
    denied_client_id: z.string().uuid(),
    denied_lead_id: z.string().uuid(),
    denied_task_id: z.string().uuid(),
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
    "Sales Ops identity must be verified before any writes");
  const write = async (name: string, args: Record<string, unknown>, status = "completed") => {
    const input = { ...args, idempotency_key: randomUUID() };
    const r = await call(name, input, status);
    const replay = await call(name, input, status);
    assert.deepEqual(replay.data, r.data);
    const activity = (await call("workflow.get_activity", { limit: 100 })).data.activity;
    assert.ok(activity.some((a: any) => a.request_id === r.request_id &&
      a.bot === config.bot_id && a.tool === name && a.execution_result === status &&
      a.authorization === "allowed"), `${name}: missing Sales Ops audit identity/result`);
    return r;
  };

  // Reads: leads, stalled leads, pipeline summary, sales agent roster + conversations.
  await call("pipeline.list_leads", {});
  const lead = await call("pipeline.get_lead", { lead_id: f.lead_id });
  assert.equal(lead.data.id, f.lead_id);
  await call("pipeline.get_stalled_leads", {});
  await call("pipeline.get_pipeline_summary", {});
  await call("sales_agents.list", {});
  const agent = await call("sales_agents.get", { sales_agent_id: f.sales_agent_id });
  assert.equal(agent.data.id, f.sales_agent_id);
  await call("sales_agents.get_conversations", { sales_agent_id: f.sales_agent_id });

  // Safe writes: durable stage move + follow-up, both with audit + replay.
  const staged = await write("pipeline.update_stage", { lead_id: f.lead_id, stage: "conversation" });
  assert.equal(staged.data.lead_id, f.lead_id);
  assert.equal(staged.data.stage, "conversation");
  const followup = await write("pipeline.create_followup", {
    lead_id: f.lead_id, next_action: "Gate 11 onboarding fixture follow-up",
  });
  assert.equal(followup.data.lead_id, f.lead_id);

  // Money-adjacent guard: sale/cash target stages are rejected before AA, not
  // silently accepted -- record_sale stays the only path to a revenue stage.
  for (const stage of ["sale", "cash"]) {
    const denied = await invoke("pipeline.update_stage", {
      client_id, lead_id: f.lead_id, stage, idempotency_key: randomUUID(),
    });
    assert.equal(denied.status, "rejected", `stage=${stage} must be rejected, not routed to AA`);
  }

  // Workflow coordination suite.
  const task = await write("workflow.create_task", { title: `Gate 11 onboarding fixture ${randomUUID()}` });
  const task_id = task.data.task.id;
  await write("workflow.assign_task", { task_id, assignee: f.assignee });
  assert.equal((await call("workflow.get_task", { task_id })).data.task.assignee, f.assignee);
  await write("workflow.complete_task", { task_id });
  assert.equal((await call("workflow.get_task", { task_id })).data.task.status, "complete");
  const pending = await write("workflow.create_approval", {
    summary: "Gate 11 informational fixture; no downstream action requested",
  }, "approval_required");
  const approvals = (await call("workflow.get_pending_approvals", { limit: 100 })).data.approvals;
  assert.ok(approvals.some((a: any) => a.approval_id === pending.approval_id &&
    a.requested_by_bot === config.bot_id && a.status === "pending" && a.execution_status === "not_started"));

  const deny = async (name: string, args: Record<string, unknown>, expected: Parameters<typeof assertAuthorizationDenial>[1]) =>
    assertAuthorizationDenial({ structuredContent: await invoke(name, { client_id, ...args }) }, expected);
  await deny("workflow.get_activity", { client_id: f.denied_client_id }, "client_scope");
  for (const [name, args] of [
    ["pipeline.get_lead", { lead_id: f.denied_lead_id }],
    ["workflow.get_task", { task_id: f.denied_task_id }],
  ] as const) await deny(name, args, "foreign_resource");
  // Absent by design (Alex CLEAR #5 / SEC_BAR #2/#3): deferred money/deploy
  // actions, dropped proof.*, and every hard-denied domain outside Sales Ops.
  for (const name of ["pipeline.record_sale", "sales_agents.create", "sales_agents.update_knowledge",
    "sales_agents.update_qualification_rules", "sales_agents.test", "sales_agents.deploy",
    "proof.search", "proof.get",
    "content.select_idea", "content.approve_asset", "content.queue_distribution",
    "content.record_publication", "content.generate_brief", "content.list_ideas",
    "campaign.create", "campaign.update", "campaign.request_approval", "campaign.list",
    "economics.get_client_economics", "security.get_system_status",
    "engineering.get_deployment_status", "engineering.create_issue",
    "workflow.record_decision"])
    await deny(name, { idempotency_key: randomUUID() }, "forbidden_tool");
}

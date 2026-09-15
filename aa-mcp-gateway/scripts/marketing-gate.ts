import assert from "node:assert/strict";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { marketingDirector as config } from "../src/onboarding/marketing-director.js";
import { assertAuthorizationDenial } from "./onboarding-denial.js";

export function assertMarketingDiscovery(actual: Iterable<string>) {
  assert.deepEqual([...new Set(actual)].sort(), [...config.expectedDiscovery].sort(),
    "Gate 9/16 requires exact discovery set equality");
}
export type MarketingFixtures = {
  approved_safe_fixtures: true;
  client_id: string; campaign_id: string; ad_campaign_id: string;
  generation_idea_id: string;
  revision_brief_id: string; pending_asset_id: string; approved_asset_id: string;
  page_id: string; finding_ids: string[]; revision_number: number;
  denied_client_id: string; denied_task_id: string; denied_campaign_id: string;
  denied_asset_id: string; denied_page_id: string; assignee: string;
};
type Invoke = (name: string, args: Record<string, unknown>) => Promise<any>;
export async function runMarketingGate(invoke: Invoke, f: MarketingFixtures) {
  assert.equal(f.approved_safe_fixtures, true, "Only approved disposable fixtures may be mutated");
  assert.notEqual(f.client_id, f.denied_client_id);
  assert.notEqual(f.pending_asset_id, f.approved_asset_id);
  z.object({
    approved_safe_fixtures: z.literal(true),
    client_id: z.string().uuid(),
    campaign_id: z.string().uuid(),
    ad_campaign_id: z.string().uuid(),
    generation_idea_id: z.string().uuid(),
    revision_brief_id: z.string().uuid(),
    pending_asset_id: z.string().uuid(),
    approved_asset_id: z.string().uuid(),
    page_id: z.string().uuid(),
    finding_ids: z.array(z.string().uuid()).min(1).max(50),
    revision_number: z.number().int().min(1),
    denied_client_id: z.string().uuid(),
    denied_task_id: z.string().uuid(),
    denied_campaign_id: z.string().uuid(),
    denied_asset_id: z.string().uuid(),
    denied_page_id: z.string().uuid(),
    assignee: z.string().min(1),
  }).strict().parse(f);
  const client_id = f.client_id;
  const call = async (name: string, args: Record<string, unknown>, status = "completed") => {
    const r = await invoke(name, { client_id, ...args });
    assert.equal(r.status, status, `${name}: unexpected result`);
    return r;
  };
  const probe = await call("workflow.get_activity", { limit: 100 });
  const evidence = (await call("workflow.get_activity", { limit: 100 })).data.activity;
  assert.ok(evidence.some((a: any) => a.request_id === probe.request_id &&
    a.bot === config.bot_id && a.client_id === client_id && a.execution_result === "completed"),
    "Marketing identity must be verified before any writes");
  const write = async (name: string, args: Record<string, unknown>, status = "completed") => {
    const input = { ...args, idempotency_key: randomUUID() };
    const r = await call(name, input, status);
    const replay = await call(name, input, status);
    assert.deepEqual(replay.data, r.data);
    assert.equal(replay.approval_id, r.approval_id);
    const activity = (await call("workflow.get_activity", { limit: 100 })).data.activity;
    assert.ok(activity.some((a: any) => a.request_id === r.request_id &&
      a.bot === config.bot_id && a.tool === name && a.execution_result === status &&
      a.authorization === "allowed"), `${name}: missing Marketing audit identity/result`);
    return r;
  };
  for (const name of ["delivery.get_client", "delivery.get_status", "delivery.get_client_health",
    "workflow.get_pending_approvals", "workflow.get_activity", "content.list_ideas",
    "conversion.list_pages"])
    await call(name, {});
  for (const name of ["campaign.list", "workflow.list_tasks"]) {
    let after: string | undefined;
    const seen = new Set<string>();
    do {
      const r = await call(name, after ? { after } : {});
      after = r.data.next_cursor ?? undefined;
      if (after) { assert.ok(!seen.has(after), "Repeated pagination cursor"); seen.add(after); }
    } while (after);
  }
  for (const name of ["campaign.get", "campaign.get_status", "campaign.get_readiness"])
    await call(name, { campaign_id: f.campaign_id });
  await call("attribution.get_campaign_performance", { campaign_id: f.ad_campaign_id });
  await call("conversion.get_page", { page_id: f.page_id });
  await call("conversion.get_performance", { page_id: f.page_id });
  await call("content.get_idea", { idea_id: f.generation_idea_id });
  await call("content.get_brief", { brief_id: f.revision_brief_id });
  await call("content.get_production_status", { asset_id: f.pending_asset_id });
  const generated = await write("content.generate_brief", { idea_id: f.generation_idea_id }, "accepted");
  assert.ok(generated.data.job_id, "Missing durable brief job");
  const revision = await write("content.request_revision", {
    brief_id: f.revision_brief_id, summary: "Gate 9 disposable fixture revision",
  });
  assert.equal(revision.data.brief_status, "draft");
  assert.equal((await call("content.get_brief", { brief_id: f.revision_brief_id })).data.status, "draft");
  const approval = await write("content.request_approval", { asset_id: f.pending_asset_id });
  assert.equal(approval.data.queue, "console_approvals");
  const repurpose = await write("content.create_repurpose_plan", {
    asset_id: f.approved_asset_id, formats: ["text_post"],
  }, "accepted");
  assert.ok(repurpose.data.job_id, "Missing durable repurpose job");
  const page = await write("conversion.create_page", {
    title: `Gate 16 page ${randomUUID().slice(0, 8)}`,
    brief: "Gate 16 disposable page brief",
    page_type: "landing",
  }, "accepted");
  assert.ok(page.data.job_id, "Missing durable landing_page job");
  const page_id = page.data.page?.id ?? f.page_id;
  await write("conversion.generate_structure", { page_id }, "accepted");
  await write("conversion.generate_copy", { page_id }, "accepted");
  await write("conversion.audit_page", { page_id: f.page_id }, "accepted");
  await write("conversion.revise_page", { page_id: f.page_id, finding_ids: f.finding_ids }, "accepted");
  await write("conversion.revert_page", { page_id: f.page_id, revision_number: f.revision_number });
  const pageApproval = await write("conversion.request_approval", {
    page_id, summary: "Gate 16 page review fixture",
  });
  assert.equal(pageApproval.data.queue, "console_page_review");
  const campaign = await write("campaign.create", {
    name: `Gate 16 campaign ${randomUUID().slice(0, 8)}`,
    brief: "Gate 16 disposable campaign brief",
  }, "accepted");
  assert.ok(campaign.data.job_id, "Missing durable campaign_plan job");
  const campaign_id = campaign.data.campaign?.id ?? f.campaign_id;
  await write("campaign.plan", { campaign_id }, "accepted");
  await write("campaign.update", { campaign_id, name: "Gate 16 renamed campaign" });
  const campApproval = await write("campaign.request_approval", {
    campaign_id: f.campaign_id, summary: "Gate 16 launch review fixture",
  });
  assert.equal(campApproval.data.queue, "console_campaign_launch");
  await write("campaign.provision", { campaign_id: f.campaign_id });
  await write("campaign.launch", { campaign_id: f.campaign_id });
  const task = await write("workflow.create_task", { title: `Gate 16 onboarding fixture ${randomUUID()}` });
  const task_id = task.data.task.id;
  await write("workflow.assign_task", { task_id, assignee: f.assignee });
  assert.equal((await call("workflow.get_task", { task_id })).data.task.assignee, f.assignee);
  await write("workflow.complete_task", { task_id });
  assert.equal((await call("workflow.get_task", { task_id })).data.task.status, "complete");
  const pending = await write("workflow.create_approval", {
    summary: "Gate 16 informational fixture; no downstream action requested",
  }, "approval_required");
  const approvals = (await call("workflow.get_pending_approvals", { limit: 100 })).data.approvals;
  assert.ok(approvals.some((a: any) => a.approval_id === pending.approval_id &&
    a.requested_by_bot === config.bot_id && a.status === "pending" && a.execution_status === "not_started"));
  const deny = async (name: string, args: Record<string, unknown>, expected: Parameters<typeof assertAuthorizationDenial>[1]) =>
    assertAuthorizationDenial({ structuredContent: await invoke(name, { client_id, ...args }) }, expected);
  await deny("delivery.get_status", { client_id: f.denied_client_id }, "client_scope");
  for (const [name, args] of [
    ["workflow.get_task", { task_id: f.denied_task_id }],
    ["campaign.get", { campaign_id: f.denied_campaign_id }],
    ["conversion.get_page", { page_id: f.denied_page_id }],
    ["content.get_production_status", { asset_id: f.denied_asset_id }],
  ] as const) await deny(name, args, "foreign_resource");
  for (const name of ["economics.get_client_economics", "security.get_system_status",
    "engineering.get_deployment_status", "pipeline.list_leads", "sales_agents.list",
    "finance.read", "deploy.run", "infra.read", "secrets.read", "admin.read",
    ...config.forbidden.filter(n => n.includes(".")), ...config.future.filter(n => !n.includes("*"))])
    await deny(name, { idempotency_key: randomUUID() }, "forbidden_tool");
}

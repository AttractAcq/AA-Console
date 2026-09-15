import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { securityDevops } from "../src/onboarding/security-devops.js";
import { assertAuthorizationDenial } from "./onboarding-denial.js";
export const securityFixtureSchema = z
  .object({
    approved_safe_fixtures: z.literal(true),
    client_id: z.string().uuid(),
    denied_client_id: z.string().uuid(),
    denied_client_name: z.literal("Attract Acquisition"),
    assignee: z.string().regex(/^bot_[a-z0-9_]+$/),
  })
  .strict();
export type SecurityFixtures = z.infer<typeof securityFixtureSchema>;
export function assertSecurityDiscovery(names: Iterable<string>) {
  const actual = [...names];
  assert.equal(actual.length, 14);
  assert.deepEqual(
    actual.sort(),
    [...securityDevops.expectedDiscovery].sort(),
  );
}
type Invoke = (name: string, args: Record<string, unknown>) => Promise<any>;
export async function runSecurityGate(invoke: Invoke, raw: SecurityFixtures) {
  const f = securityFixtureSchema.parse(raw);
  assert.notEqual(f.client_id, f.denied_client_id);
  const client_id = f.client_id;
  const call = async (
    name: string,
    args: Record<string, unknown> = {},
    status = "completed",
  ) => {
    const result = await invoke(name, { client_id, ...args });
    assert.equal(result.status, status, `${name} status`);
    return result;
  };
  const probe = await call("workflow.get_activity");
  const activity = (await call("workflow.get_activity", { limit: 100 })).data
    .activity;
  assert.ok(
    activity.some(
      (a: any) =>
        a.request_id === probe.request_id &&
        a.bot === "bot_security_devops" &&
        a.client_id === client_id,
    ),
  );
  await call("security.get_system_status");
  await call("security.get_open_findings");
  await call("security.get_incident_status");
  await call("engineering.get_release_status");
  await call("engineering.get_deployment_status");
  await call("workflow.list_tasks");
  await call("workflow.get_pending_approvals");
  for (const name of [
    "pipeline.record_sale",
    "economics.get_costs",
    "admin.create_event",
    "content.select_idea",
    "content.approve_asset",
    "content.queue_distribution",
    "sales_agents.deploy",
    "sales_agents.create",
    "delivery.list_clients",
    "engineering.create_issue",
    "engineering.get_issue",
    "workflow.record_decision",
    "sites.provision",
    "sites.publish_page",
    "brand.get_profile",
  ]) {
    assertAuthorizationDenial(
      {
        structuredContent: await invoke(name, {
          client_id,
          idempotency_key: randomUUID(),
        }),
      },
      "forbidden_tool",
    );
  }
  assertAuthorizationDenial(
    {
      structuredContent: await invoke("security.get_system_status", {
        client_id: f.denied_client_id,
      }),
    },
    "client_scope",
  );
  let taskId: string | undefined;
  let findingId: string | undefined;
  const write = async (name: string, args: Record<string, unknown>) => {
    const input = { ...args, idempotency_key: randomUUID() };
    const first = await call(name, input);
    const again = await call(name, input);
    const logical = (r: any) => {
      const { replayed, ...data } = r.data;
      return data;
    };
    assert.deepEqual(logical(again), logical(first));
    return first;
  };
  try {
    const created = await write("security.create_finding", {
      title: `Gate 15 reversible fixture ${randomUUID()}`,
      notes: null,
      severity: "low",
    });
    findingId = created.data.finding.id;
    await call("security.get_open_findings", { finding_id: findingId });
    const task = await write("workflow.create_task", {
      title: `Gate 15 reversible fixture ${randomUUID()}`,
    });
    taskId = task.data.task.id;
    await write("workflow.assign_task", {
      task_id: taskId,
      assignee: f.assignee,
    });
    await call("workflow.get_task", { task_id: taskId });
  } finally {
    if (taskId)
      await call("workflow.complete_task", {
        task_id: taskId,
        idempotency_key: randomUUID(),
      });
  }
  void findingId;
}

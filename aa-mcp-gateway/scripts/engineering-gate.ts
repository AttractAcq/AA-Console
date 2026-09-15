import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { engineeringOps } from "../src/onboarding/engineering-ops.js";
import { assertAuthorizationDenial } from "./onboarding-denial.js";
export const engineeringFixtureSchema = z
  .object({
    approved_safe_fixtures: z.literal(true),
    client_id: z.string().uuid(),
    denied_client_id: z.string().uuid(),
    denied_client_name: z.literal("Attract Acquisition"),
    assignee: z.string().regex(/^bot_[a-z0-9_]+$/),
  })
  .strict();
export type EngineeringFixtures = z.infer<typeof engineeringFixtureSchema>;
export function assertEngineeringDiscovery(names: Iterable<string>) {
  const actual = [...names];
  assert.equal(actual.length, 12);
  assert.deepEqual(
    actual.sort(),
    [...engineeringOps.expectedDiscovery].sort(),
  );
}
type Invoke = (name: string, args: Record<string, unknown>) => Promise<any>;
export async function runEngineeringGate(invoke: Invoke, raw: EngineeringFixtures) {
  const f = engineeringFixtureSchema.parse(raw);
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
        a.bot === "bot_engineering" &&
        a.client_id === client_id,
    ),
  );
  await call("engineering.get_release_status");
  await call("engineering.get_deployment_status");
  await call("workflow.list_tasks");
  await call("workflow.get_pending_approvals");
  for (const name of [
    "pipeline.record_sale",
    "security.get_system_status",
    "economics.get_costs",
    "admin.create_event",
    "content.select_idea",
    "content.approve_asset",
    "content.queue_distribution",
    "sales_agents.deploy",
    "sales_agents.create",
    "delivery.list_clients",
    "workflow.record_decision",
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
      structuredContent: await invoke("engineering.get_release_status", {
        client_id: f.denied_client_id,
      }),
    },
    "client_scope",
  );
  let taskId: string | undefined;
  let issueId: string | undefined;
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
    const created = await write("engineering.create_issue", {
      title: `Gate 14 reversible fixture ${randomUUID()}`,
      notes: null,
    });
    issueId = created.data.issue.id;
    await call("engineering.get_issue", { issue_id: issueId });
    const task = await write("workflow.create_task", {
      title: `Gate 14 reversible fixture ${randomUUID()}`,
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
}

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { financeController } from "../src/onboarding/finance-controller.js";
import { assertAuthorizationDenial } from "./onboarding-denial.js";
export const financeFixtureSchema = z
  .object({
    approved_safe_fixtures: z.literal(true),
    client_id: z.string().uuid(),
    denied_client_id: z.string().uuid(),
    denied_client_name: z.literal("Attract Acquisition"),
    assignee: z.string().regex(/^bot_[a-z0-9_]+$/),
  })
  .strict();
export type FinanceFixtures = z.infer<typeof financeFixtureSchema>;
export function assertFinanceDiscovery(names: Iterable<string>) {
  const actual = [...names];
  assert.equal(actual.length, 14);
  assert.deepEqual(actual.sort(), [...financeController.expectedDiscovery].sort());
}
type Invoke = (name: string, args: Record<string, unknown>) => Promise<any>;
export async function runFinanceGate(invoke: Invoke, raw: FinanceFixtures) {
  const f = financeFixtureSchema.parse(raw);
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
        a.bot === "bot_finance" &&
        a.client_id === client_id,
    ),
  );
  await call("economics.get_client_economics");
  await call("economics.get_campaign_economics");
  await call("economics.get_costs");
  await call("economics.get_revenue");
  await call("economics.get_roi");
  await call("attribution.get_revenue_attribution");
  await call("workflow.list_tasks");
  await call("workflow.get_pending_approvals");
  for (const name of [
    "pipeline.record_sale",
    "security.get_system_status",
    "engineering.create_issue",
    "admin.create_event",
    "content.select_idea",
    "content.approve_asset",
    "content.queue_distribution",
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
      structuredContent: await invoke("economics.get_costs", {
        client_id: f.denied_client_id,
      }),
    },
    "client_scope",
  );
  let taskId: string | undefined;
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
    const task = await write("workflow.create_task", {
      title: `Gate 13 reversible fixture ${randomUUID()}`,
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

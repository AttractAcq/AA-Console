import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { adminCalendar } from "../src/onboarding/admin-calendar.js";
import { assertAuthorizationDenial } from "./onboarding-denial.js";
export const adminFixtureSchema = z
  .object({
    approved_safe_fixtures: z.literal(true),
    client_id: z.string().uuid(),
    allowed_client_name: z.literal("Harbour Dental"),
    denied_client_id: z.string().uuid(),
    denied_client_name: z.literal("Attract Acquisition"),
    denied_event_id: z.string().uuid(),
    assignee: z.string().regex(/^bot_[a-z0-9_]+$/),
  })
  .strict();
export type AdminFixtures = z.infer<typeof adminFixtureSchema>;
export function assertAdminDiscovery(names: Iterable<string>) {
  const actual = [...names];
  assert.equal(actual.length, 15);
  assert.deepEqual(actual.sort(), [...adminCalendar.expectedDiscovery].sort());
}
type Invoke = (name: string, args: Record<string, unknown>) => Promise<any>;
export async function runAdminGate(invoke: Invoke, raw: AdminFixtures) {
  const f = adminFixtureSchema.parse(raw);
  assert.notEqual(f.client_id, f.denied_client_id);
  const client_id = f.client_id;
  const call = async (
    name: string,
    args: Record<string, unknown> = {},
    status = "completed",
  ) => {
    const result = await invoke(
      name,
      name === "delivery.list_clients" ? args : { client_id, ...args },
    );
    assert.equal(result.status, status, `${name} status`);
    return result;
  };
  const read = await call("delivery.get_client");
  assert.equal(read.data.client.name, f.allowed_client_name);
  // The second read proves which authenticated identity issued the first read.
  const probe = await call("workflow.get_activity");
  const activity = (await call("workflow.get_activity", { limit: 100 })).data
    .activity;
  assert.ok(
    activity.some(
      (a: any) =>
        a.request_id === probe.request_id &&
        a.bot === "bot_admin" &&
        a.client_id === client_id,
    ),
  );
  let after: string | undefined;
  const seen = new Set<string>();
  do {
    const page = await call("delivery.list_clients", {
      limit: 100,
      ...(after ? { after } : {}),
    });
    assert.ok(page.data.clients.every((c: any) => c.id === client_id));
    after = page.data.next_cursor;
    if (after) {
      assert.ok(!seen.has(after));
      seen.add(after);
    }
  } while (after);
  await call("delivery.get_status");
  await call("workflow.list_tasks");
  await call("workflow.get_pending_approvals");
  await call("admin.list_events");
  for (const name of [
    "economics.get_costs",
    "security.get_system_status",
    "engineering.create_issue",
    "pipeline.update_stage",
    "sales_agents.create",
    "content.select_idea",
    "content.approve_asset",
    "content.queue_distribution",
    "content.record_publication",
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
  let taskId: string | undefined;
  let saved: any;
  const write = async (
    name: string,
    args: Record<string, unknown>,
    capture?: (result: any) => void,
  ) => {
    const input = { ...args, idempotency_key: randomUUID() };
    const first = await call(name, input);
    capture?.(first);
    const again = await call(name, input);
    // Durable replay may add replayed=true; logical data must be identical.
    const logical = (r: any) => {
      const { replayed, ...data } = r.data;
      return data;
    };
    assert.deepEqual(logical(again), logical(first));
    return first;
  };
  try {
    const task = await write(
      "workflow.create_task",
      {
        title: `Gate 12 reversible fixture ${randomUUID()}`,
      },
      (result) => {
        taskId = result.data.task.id;
      },
    );
    taskId = task.data.task.id;
    await write("workflow.assign_task", {
      task_id: taskId,
      assignee: f.assignee,
    });
    await call("workflow.get_task", { task_id: taskId });
    const createInput = {
      title: `Gate 12 reversible fixture ${randomUUID()}`,
      notes: null,
      event_type: "reminder",
      starts_at: new Date().toISOString(),
      ends_at: null,
      idempotency_key: "gate12-" + randomUUID(),
    };
    saved = (await call("admin.create_event", createInput)).data.event;
    assert.deepEqual(
      (await call("admin.create_event", createInput)).data.event,
      saved,
    );
    await call("admin.get_event", { event_id: saved.id });
    const updateInput = {
      event_id: saved.id,
      expected_version: saved.version,
      title: saved.title,
      notes: null,
      starts_at: saved.starts_at,
      ends_at: null,
      status: "scheduled",
      idempotency_key: randomUUID(),
    };
    saved = (await call("admin.update_event", updateInput)).data.event;
    assert.deepEqual(
      (await call("admin.update_event", updateInput)).data.event,
      saved,
    );
    for (const name of ["admin.get_event", "admin.update_event"]) {
      const args =
        name === "admin.get_event"
          ? { event_id: f.denied_event_id }
          : {
              event_id: f.denied_event_id,
              expected_version: 1,
              title: "Denied fixture",
              notes: null,
              starts_at: saved.starts_at,
              ends_at: null,
              status: "cancelled",
              idempotency_key: randomUUID(),
            };
      const denial = await invoke(name, { client_id, ...args });
      assert.equal(denial.status, "failed");
      assert.equal(denial.error?.code, "event_not_found");
      assertAuthorizationDenial(
        {
          structuredContent: await invoke(name, {
            ...args,
            client_id: f.denied_client_id,
          }),
        },
        "client_scope",
      );
    }
  } finally {
    try {
      if (saved)
        await call("admin.update_event", {
          event_id: saved.id,
          expected_version: saved.version,
          title: saved.title,
          notes: null,
          starts_at: saved.starts_at,
          ends_at: saved.ends_at,
          status: "cancelled",
          idempotency_key: randomUUID(),
        });
    } finally {
      if (taskId)
        await call("workflow.complete_task", {
          task_id: taskId,
          idempotency_key: randomUUID(),
        });
    }
  }
}

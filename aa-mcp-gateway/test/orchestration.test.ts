import { test } from "node:test";
import { assertAuthorizationDenial } from "../scripts/onboarding-denial.js";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { AAApiAdapter } from "../src/adapters/aa-api.js";
import { ActionEngine } from "../src/policy/engine.js";
import { Store } from "../src/audit/store.js";
import { chiefOfStaff } from "../src/onboarding/chief-of-staff.js";
import { grants } from "../src/policy/permissions.js";
import { registry } from "../src/registry/tools.js";

const client = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const idea = "33333333-3333-4333-8333-333333333333";
const brief = "44444444-4444-4444-8444-444444444444";
const asset = "55555555-5555-4555-8555-555555555555";
const job = "66666666-6666-4666-8666-666666666666";
const identity = { bot: "bot_chief_of_staff" as const, clients: [client] };

async function mockAa(
  t: any,
  handler: (req: { url?: string; body: any }) => {
    status: number;
    body: unknown;
  },
) {
  const received: { url?: string; method?: string; body: any }[] = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    received.push({ url: req.url, method: req.method, body });
    const result = handler({ url: req.url, body });
    res.writeHead(result.status, { "content-type": "application/json" });
    res.end(JSON.stringify(result.body));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  });
  const adapter = new AAApiAdapter({
    url: `http://127.0.0.1:${(server.address() as any).port}`,
    token: "service-secret",
    timeoutMs: 1000,
  });
  return { adapter, received };
}

const gateTools = registry.filter(
  (t) => t.dependency === "Scoped AA orchestration business API",
);
function input(name: string, client_id = client): Record<string, unknown> {
  if (name === "workflow.create_task")
    return { client_id, title: "Follow up", idempotency_key: "create-key" };
  if (name === "workflow.assign_task")
    return {
      client_id,
      task_id: job,
      assignee: "bot_client_delivery",
      idempotency_key: "assign-key",
    };
  if (name === "workflow.complete_task")
    return { client_id, task_id: job, idempotency_key: "complete-key" };
  if (name === "workflow.get_task") return { client_id, task_id: job };
  if (name === "campaign.list" || name === "workflow.list_tasks")
    return { client_id, limit: 1 };
  return { client_id, campaign_id: idea };
}
test("contract 4/8: CoS reference matches existing grants and discovers only allowed real tools", async (t) => {
  assert.deepEqual([...chiefOfStaff.grants], grants.bot_chief_of_staff);
  const store = new Store(":memory:");
  t.after(() => store.close());
  let calls = 0;
  const engine = new ActionEngine(store, registry, {
    execute: async (tool) => {
      calls++;
      return { status: "completed", capability: tool.name };
    },
  });
  const names = engine.discover(identity).map((t) => t.name);
  for (const name of [...chiefOfStaff.reads, ...chiefOfStaff.writes])
    assert.ok(names.includes(name), name);
  for (const tool of registry.filter((t) =>
    chiefOfStaff.forbidden.some((f) => t.name === f || t.domain === f),
  )) {
    assert.ok(!names.includes(tool.name));
    assertAuthorizationDenial(
      {
        structuredContent: await engine.call(identity, tool.name, {
          client_id: client,
          idempotency_key: "forbidden-key",
        }),
      },
      "forbidden_tool",
    );
  }
  for (const name of [
    "campaign.create",
    "campaign.update",
    "campaign.request_approval",
    "attribution.generate_report",
  ])
    assert.ok(!names.includes(name));
  assert.equal(calls, 0);
});
test("contract 7: all Gate 8 tools deny client scope before AA", async (t) => {
  const store = new Store(":memory:");
  t.after(() => store.close());
  let calls = 0;
  const engine = new ActionEngine(store, registry, {
    execute: async (tool) => {
      calls++;
      return { status: "completed", capability: tool.name };
    },
  });
  for (const tool of gateTools)
    assertAuthorizationDenial(
      {
        structuredContent: await engine.call(
          identity,
          tool.name,
          input(tool.name, other),
        ),
      },
      "client_scope",
    );
  assert.equal(calls, 0);
});
test("contract 5/6: all real adapters reach scoped HTTP; durable keys replay and conflict", async (t) => {
  const { adapter, received } = await mockAa(t, ({ body }) => ({
    status: 200,
    body: { client_id: body.client_id, task: { id: job } },
  }));
  const store = new Store(":memory:");
  t.after(() => store.close());
  const engine = new ActionEngine(store, registry, adapter);
  for (const tool of gateTools) {
    const body = input(tool.name);
    assert.equal(
      (await engine.call(identity, tool.name, body)).status,
      "completed",
      tool.name,
    );
    assert.equal(
      received.at(-1)?.url,
      `/internal/mcp/${tool.name.replace(".", "/").replaceAll("_", "-")}`,
    );
    assert.ok(!Object.hasOwn(received.at(-1)!.body, "idempotency_key"));
    if (tool.action === "write")
      assert.equal(
        (await engine.call(identity, tool.name, body)).status,
        "completed",
      );
  }
  assert.equal(received.length, 9);
  assert.equal(
    (
      await engine.call(identity, "workflow.create_task", {
        ...input("workflow.create_task"),
        title: "Changed",
      })
    ).status,
    "rejected",
  );
});
test("contract 7: adapters reject mismatched upstream client for every Gate 8 tool", async (t) => {
  const { adapter } = await mockAa(t, () => ({
    status: 200,
    body: { client_id: other },
  }));
  const store = new Store(":memory:");
  t.after(() => store.close());
  const engine = new ActionEngine(store, registry, adapter);
  for (const tool of gateTools)
    assert.equal(
      (await engine.call(identity, tool.name, input(tool.name))).error?.code,
      "malformed_response",
    );
});
test("contract 9/10: reference declares stdio header-file connector and complete smoke mapping", () => {
  assert.equal(chiefOfStaff.connector.command, "npx");
  assert.ok(chiefOfStaff.connector.args.includes("--header-file"));
  assert.deepEqual([...chiefOfStaff.contractSteps], [4, 5, 6, 7, 8, 9, 10]);
});

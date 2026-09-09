/** Operator-run Gate suite. No bearer input/output; secrets stay in the connector header file. */
import assert from "node:assert/strict";
import {
  assertAuthorizationDenial,
  type AuthorizationDenial,
} from "./onboarding-denial.js";
import { readFileSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { chiefOfStaff as config } from "../src/onboarding/chief-of-staff.js";

const [fixturePath, headerPath] = process.argv.slice(2);
if (!fixturePath || !headerPath)
  throw new Error(
    "Usage: npm run smoke:onboarding -- <nonsecret-fixtures.json> <private-header-file>",
  );
assert.equal(
  statSync(headerPath).mode & 0o077,
  0,
  "Header file must be private (0600)",
);
const fixtures = JSON.parse(readFileSync(fixturePath, "utf8")) as {
  clients: { client_id: string; campaign_id: string }[];
  denied_client_id: string;
  denied_task_id: string;
  denied_campaign_id: string;
  assignee: string;
};
assert.ok(
  fixtures.clients.length,
  "An approved Harbour tracking fixture is required",
);
const client = new Client({ name: "aa-bot-onboarding", version: "1.0.0" });
let calls = 0;
async function call(
  name: string,
  args: Record<string, unknown>,
  expected = "completed",
) {
  const response = await client.callTool({ name, arguments: args });
  calls++;
  const result = response.structuredContent as
    { status?: string; data?: Record<string, any> } | undefined;
  assert.equal(result?.status, expected, `${name}: unexpected result`);
  return result?.data ?? {};
}
async function denied(
  name: string,
  args: Record<string, unknown>,
  expected: AuthorizationDenial,
) {
  const response = await client.callTool({ name, arguments: args });
  calls++;
  assertAuthorizationDenial(
    { structuredContent: response.structuredContent },
    expected,
  );
}

try {
  // Step 9: exercise the same stdio bridge as Harbour, not direct HTTP authentication.
  await client.connect(
    new StdioClientTransport({
      command: config.connector.command,
      args: config.connector.args.map((arg) =>
        arg === "<private-header-file>" ? headerPath : arg,
      ),
      stderr: "ignore",
    }),
  );
  const names = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await client.listTools(cursor ? { cursor } : {});
    page.tools.forEach((t) => names.add(t.name));
    cursor = page.nextCursor;
  } while (cursor);
  // Step 4.
  for (const name of [...config.reads, ...config.writes])
    assert.ok(names.has(name), `${name}: missing discovery`);
  for (const name of names)
    assert.ok(
      !config.forbidden.some((f) => name === f || name.startsWith(`${f}.`)),
      "Forbidden discovery",
    );
  const granted = new Set<string>();
  let after: string | undefined;
  do {
    const page = await call("delivery.list_clients", after ? { after } : {});
    page.clients.forEach((c: { id: string }) => granted.add(c.id));
    after = page.next_cursor ?? undefined;
  } while (after);
  assert.deepEqual(
    [...granted].sort(),
    fixtures.clients.map((c) => c.client_id).sort(),
    "Fixtures must cover all and only granted clients",
  );
  for (const fixture of fixtures.clients) {
    const { client_id, campaign_id } = fixture;
    // Step 5: operating-loop backbone, including bounded projections and all list pages.
    for (const name of [
      "delivery.get_client",
      "delivery.get_status",
      "delivery.get_blockers",
      "delivery.get_next_action",
      "delivery.get_client_health",
      "workflow.get_pending_approvals",
      "workflow.get_activity",
    ])
      await call(name, { client_id });
    for (const name of ["campaign.list", "workflow.list_tasks"]) {
      let after: string | undefined;
      do {
        const page = await call(name, {
          client_id,
          ...(after ? { after } : {}),
        });
        after = page.next_cursor ?? undefined;
      } while (after);
    }
    for (const name of [
      "campaign.get",
      "campaign.get_status",
      "attribution.get_campaign_performance",
    ])
      await call(name, { client_id, campaign_id });
    // Step 6: safe durable tracking fixture, completed within the suite.
    const key = randomUUID();
    const create = {
      client_id,
      title: `Gate 8 onboarding fixture ${key}`,
      idempotency_key: key,
    };
    const created = await call("workflow.create_task", create);
    const task_id = created.task.id;
    assert.equal((await call("workflow.create_task", create)).task.id, task_id);
    const assign = {
      client_id,
      task_id,
      assignee: fixtures.assignee,
      idempotency_key: randomUUID(),
    };
    await call("workflow.assign_task", assign);
    await call("workflow.assign_task", assign);
    await call("workflow.get_task", { client_id, task_id });
    const complete = { client_id, task_id, idempotency_key: randomUUID() };
    await call("workflow.complete_task", complete);
    await call("workflow.complete_task", complete);
    assert.equal(
      (await call("workflow.get_task", { client_id, task_id })).task.status,
      "complete",
    );
    // Step 7: other-client and other-resource fixtures must be known to the operator.
    await denied(
      "delivery.get_status",
      {
        client_id: fixtures.denied_client_id,
      },
      "client_scope",
    );
    await denied(
      "workflow.get_task",
      {
        client_id,
        task_id: fixtures.denied_task_id,
      },
      "foreign_resource",
    );
    await denied(
      "campaign.get",
      {
        client_id,
        campaign_id: fixtures.denied_campaign_id,
      },
      "foreign_resource",
    );
    // Step 8: intentionally invoke forbidden domains even when absent from discovery.
    for (const name of [
      "economics.get_client_economics",
      "security.get_system_status",
      "engineering.get_deployment_status",
      "workflow.record_decision",
    ])
      await denied(
        name,
        { client_id, idempotency_key: randomUUID() },
        "forbidden_tool",
      );
  }
  // Step 10: sanitized evidence only; no tool bodies, client business data, or secrets.
  console.log(
    JSON.stringify({
      bot_id: config.bot_id,
      steps: [4, 5, 6, 7, 8, 9, 10],
      clients: granted.size,
      calls,
      status: "PASS",
      at: new Date().toISOString(),
    }),
  );
} catch {
  console.error(
    JSON.stringify({
      bot_id: config.bot_id,
      calls,
      status: "FAIL",
      message: "Inspect locally; no secret-bearing error output emitted.",
    }),
  );
  process.exitCode = 1;
} finally {
  await client.close();
}

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { AAApiAdapter } from "../src/adapters/aa-api.js";
import { allowed } from "../src/policy/permissions.js";
import { registry } from "../src/registry/tools.js";

const client = "11111111-1111-4111-8111-111111111111";
const source = "22222222-2222-4222-8222-222222222222";
const project = "33333333-3333-4333-8333-333333333333";
const job = "44444444-4444-4444-8444-444444444444";
const tool = registry.find((item) => item.name === "content.create_video_project")!;
const input = { client_id: client,
  idea: "Explain the reviewed service to prospective buyers.",
  audience: "Local buyers", tone: "confident", target_length_sec: 120,
  aspects: ["16:9", "9:16"], record_ids: [source],
  idempotency_key: "video-create-key-1" };

test("video start is Production-only and requires reviewed source IDs", () => {
  assert.equal(tool.implementation, "real");
  assert.equal(tool.action, "write");
  assert.equal(tool.reversible, false);
  assert.equal(allowed("bot_production", tool), true);
  assert.equal(allowed({ bot: "bot_chief_of_staff", clients: [client],
    permissions: ["content.*"] }, tool), false);
  assert.equal(allowed({ bot: "bot_marketing", clients: [client],
    permissions: ["content.*"] }, tool), false);
  assert.equal(tool.input.safeParse({ ...input, record_ids: [] }).success, false);
  assert.equal(tool.input.safeParse({ ...input, record_ids: [source, source] }).success, false);
  assert.equal(tool.input.safeParse({ ...input, campaign_id: project }).success, false);
  assert.equal(registry.some((item) => item.name === "content.approve_video_project"), false);
});

test("video start adapter sends exact inputs and rejects unbound result", async (t) => {
  let returnedClient = client;
  const received: unknown[] = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    received.push({ path: req.url, body: JSON.parse(raw) });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ client_id: returnedClient, project_id: project,
      job_id: job, stage: "queued" }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const adapter = new AAApiAdapter({
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    token: "test-only-secret",
  });
  const context = { bot: "bot_production" as const, clients: [client],
    request_id: "request-video-create", execution_id: "execution-video-create" };
  const result = await adapter.execute(tool, input, context);
  assert.equal(result.status, "completed");
  assert.deepEqual(received[0], { path: "/internal/mcp/content/create-video-project",
    body: { ...input, brief_id: null, campaign_id: null,
      route_package_id: null } });
  returnedClient = "55555555-5555-4555-8555-555555555555";
  const mismatch = await adapter.execute(tool, input, context);
  assert.equal(mismatch.status, "failed");
  assert.equal(mismatch.error?.code, "malformed_response");
});

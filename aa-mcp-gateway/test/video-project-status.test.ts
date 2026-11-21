import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { AAApiAdapter } from "../src/adapters/aa-api.js";
import { allowed } from "../src/policy/permissions.js";
import { registry } from "../src/registry/tools.js";

const client = "11111111-1111-4111-8111-111111111111";
const project = "22222222-2222-4222-8222-222222222222";
const other = "33333333-3333-4333-8333-333333333333";
const tool = registry.find((item) => item.name === "content.video_project_status")!;

test("video status is a read tool for Production and Chief of Staff only", () => {
  assert.equal(tool.implementation, "real");
  assert.equal(tool.action, "read");
  assert.equal(tool.risk, "LOW");
  assert.equal(allowed("bot_production", tool), true);
  assert.equal(allowed("bot_chief_of_staff", tool), true);
  assert.equal(allowed({ bot: "bot_marketing", clients: [client],
    permissions: ["content.*"] }, tool), false);
  assert.equal(allowed("bot_distribution", tool), false);
  assert.equal(tool.input.safeParse({ client_id: client }).success, false);
});

test("video status adapter binds exact project and refuses mismatched response", async (t) => {
  let returnedProject = project;
  const received: Array<{ path: string | undefined; body: unknown }> = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    received.push({ path: req.url, body: JSON.parse(raw) });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ client_id: client, project_id: returnedProject,
      stage: "draft", stage_error: null, ir_version: 0,
      cost_usd_estimate: 0, scenes: 0, audio_scenes: 0,
      render_candidates: 0, accepted_candidates: 0, critic_loops: 0,
      asset_id: null, asset_review_status: null, human_approved_at: null,
      scheduled_posts: 0, recorded_external_posts: 0,
      last_recorded_external_post_at: null, unconfirmed_published_rows: 0 }));
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
    request_id: "request-video-status", execution_id: "execution-video-status" };
  const result = await adapter.execute(tool, { client_id: client, project_id: project }, context);
  assert.equal(result.status, "completed");
  assert.deepEqual(received[0], { path: "/internal/mcp/content/video-project-status",
    body: { client_id: client, project_id: project } });
  returnedProject = other;
  const mismatch = await adapter.execute(tool,
    { client_id: client, project_id: project }, context);
  assert.equal(mismatch.status, "failed");
  assert.equal(mismatch.error?.code, "malformed_response");
});

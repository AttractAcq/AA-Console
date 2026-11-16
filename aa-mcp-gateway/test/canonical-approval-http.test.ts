import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { AaCanonicalApprovalBridge } from "../src/approvals/canonical-bridge.js";

const approval = "11111111-1111-4111-8111-111111111111";
const token = "22222222-2222-4222-8222-222222222222";
const canonical = "33333333-3333-4333-8333-333333333333";
const execution = "44444444-4444-4444-8444-444444444444";
const hash = "a".repeat(64);

test("gateway bridge posts fixed service routes and rejects mismatched attestation", async () => {
  const seen: string[] = [];
  let attestedId = canonical;
  const server = http.createServer(async (req, res) => {
    seen.push(req.url ?? "");
    assert.equal(req.headers.authorization, "Bearer private-service-secret");
    assert.equal(req.method, "POST");
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    res.writeHead(200, { "content-type": "application/json" });
    if (req.url?.endsWith("/register")) {
      assert.equal(body.approval_id, approval);
      res.end(JSON.stringify({ canonical_request_id: canonical, payload_hash: hash }));
    } else if (req.url?.endsWith("/attest")) {
      assert.equal(body.payload_hash, hash);
      res.end(JSON.stringify({ approved: true, state: "source_decided",
        canonical_request_id: attestedId }));
    } else if (req.url?.endsWith("/claim")) {
      assert.equal(body.execution_key, execution);
      res.end(JSON.stringify({ claimed: true, state: "claimed" }));
    } else {
      assert.equal(body.result_hash, hash);
      res.end(JSON.stringify({ status: "completed", execution_key: execution,
        result_hash: hash, finished_at: "2026-11-14T12:00:00Z" }));
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const bridge = new AaCanonicalApprovalBridge(`http://127.0.0.1:${address.port}/`,
      "private-service-secret");
    const result = await bridge.register({ approval_id: approval,
      client_id: approval, bot_id: "bot_production", token_id: token,
      tool: "workflow.create_approval", risk: "MEDIUM", summary: "Review",
      payload: { client_id: approval }, expires_at: "2030-01-01T00:00:00Z" });
    assert.equal(result.canonical_request_id, canonical);
    assert.equal(await bridge.attest(approval, token, hash, canonical), true);
    attestedId = "55555555-5555-4555-8555-555555555555";
    assert.equal(await bridge.attest(approval, token, hash, canonical), false);
    assert.equal(await bridge.claim(approval, token, hash, execution), true);
    await bridge.finish(approval, execution, "completed", hash);
    assert.deepEqual(seen, ["/internal/mcp/gateway-approval/register",
      "/internal/mcp/gateway-approval/attest", "/internal/mcp/gateway-approval/attest",
      "/internal/mcp/gateway-approval/claim", "/internal/mcp/gateway-approval/finish"]);
  } finally { server.close(); await once(server, "close"); }
});

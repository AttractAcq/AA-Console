import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/audit/store.js";
import { ActionEngine } from "../src/policy/engine.js";
import { registry } from "../src/registry/tools.js";
import { AAApiAdapter } from "../src/adapters/aa-api.js";
import type { CanonicalApprovalBridge, GatewayApprovalPacket } from "../src/approvals/canonical-bridge.js";

const client = "11111111-1111-4111-8111-111111111111";
const token = "22222222-2222-4222-8222-222222222222";
const identity = { bot: "bot_production" as const, clients: [client] };
const input = { client_id: client, idempotency_key: "canonical-approval-1",
  summary: "Review the production plan" };

test("connected gateway requires canonical registration and current decision", async () => {
  const store = new Store(":memory:");
  let packet: GatewayApprovalPacket | undefined;
  let approved = false;
  let attestCalls = 0;
  let claimCalls = 0;
  let finishCalls = 0;
  const bridge: CanonicalApprovalBridge = {
    async register(value) {
      packet = value;
      return { canonical_request_id: "33333333-3333-4333-8333-333333333333",
        payload_hash: "a".repeat(64) };
    },
    async attest(id, tokenId, payloadHash, canonicalId) {
      attestCalls++;
      assert.equal(id, packet?.approval_id);
      assert.equal(tokenId, token);
      assert.equal(payloadHash, "a".repeat(64));
      assert.equal(canonicalId, "33333333-3333-4333-8333-333333333333");
      return approved;
    },
    async claim(id, tokenId, payloadHash, executionKey) {
      claimCalls++;
      assert.equal(id, packet?.approval_id);
      assert.equal(tokenId, token);
      assert.equal(payloadHash, "a".repeat(64));
      assert.match(executionKey, /^[0-9a-f-]{36}$/);
      return true;
    },
    async finish(id, executionKey, status, resultHash) {
      finishCalls++;
      assert.equal(id, packet?.approval_id);
      assert.match(executionKey, /^[0-9a-f-]{36}$/);
      assert.equal(status, "completed");
      assert.match(resultHash, /^[0-9a-f]{64}$/);
    },
  };
  try {
    const tools = registry.map(tool => ({ ...tool }));
    const engine = new ActionEngine(store, tools, new AAApiAdapter(), false, bridge);
    const pending = await engine.call(identity, "workflow.create_approval", input, undefined, undefined, token);
    assert.equal(pending.status, "approval_required");
    const replay = await engine.call(identity, "workflow.create_approval", input, undefined, undefined, token);
    assert.equal(replay.approval_id, pending.approval_id);
    assert.equal(store.approvals().length, 1);
    assert.equal(packet?.client_id, client);
    assert.equal(packet?.token_id, token);
    assert.equal(store.getApproval(pending.approval_id!).canonical_request_id,
      "33333333-3333-4333-8333-333333333333");
    assert.throws(() => engine.decide(pending.approval_id!, "bearer-reviewer", "approved"),
      /canonical_decision_required/);
    await assert.rejects(() => engine.executeApproval(pending.approval_id!, [identity], token),
      /canonical_decision_required/);
    assert.equal(store.getApproval(pending.approval_id!).execution_status, "not_started");
    approved = true;
    const currentTool = tools.find(tool => tool.name === "workflow.create_approval")!;
    currentTool.risk = "HIGH";
    await assert.rejects(() => engine.executeApproval(pending.approval_id!, [identity], token),
      /invalid_transition/);
    currentTool.risk = "MEDIUM";
    const executed = await engine.executeApproval(pending.approval_id!, [identity], token);
    assert.equal(executed.status, "completed");
    assert.equal(executed.data?.decision, "informational_only");
    assert.ok(attestCalls >= 3);
    assert.equal(claimCalls, 1);
    assert.equal(finishCalls, 1);
    await assert.rejects(() => engine.executeApproval(pending.approval_id!, [identity], token),
      /invalid_transition/);
  } finally { store.close(); }
});

test("uncertain canonical registration retries the same frozen local card", async () => {
  const store = new Store(":memory:");
  let attempts = 0;
  const bridge: CanonicalApprovalBridge = {
    async register() {
      attempts++;
      if (attempts === 1) throw new Error("runtime response lost");
      return { canonical_request_id: "33333333-3333-4333-8333-333333333333",
        payload_hash: "a".repeat(64) };
    },
    async attest() { return false; },
    async claim() { return false; },
    async finish() { throw new Error("unreachable"); },
  };
  try {
    const engine = new ActionEngine(store, registry, new AAApiAdapter(), false, bridge);
    const result = await engine.call(identity, "workflow.create_approval", input, undefined, undefined, token);
    assert.equal(result.status, "indeterminate");
    assert.equal(store.approvals().length, 1);
    assert.equal(store.getApproval(result.approval_id!).status, "registration_pending");
    const retry = await engine.call(identity, "workflow.create_approval", input, undefined, undefined, token);
    assert.equal(retry.status, "approval_required");
    assert.equal(retry.approval_id, result.approval_id);
    assert.equal(store.getApproval(result.approval_id!).canonical_request_id,
      "33333333-3333-4333-8333-333333333333");
  } finally { store.close(); }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/audit/store.js";
import { auditApprovals } from "../scripts/audit-legacy-approvals.js";

test("read-only audit identifies legacy cards without exposing structured payloads", () => {
  const dir = mkdtempSync(join(tmpdir(), "aa-gateway-audit-"));
  const path = join(dir, "gateway.sqlite");
  const store = new Store(path);
  try {
    store.approval({ approval_id: "old", status: "approved", tool: "workflow.create_task",
      created_at: "2026-11-14T00:00:00Z", execution_status: "not_started",
      structured_payload: { secret: "never-output-this" } });
    store.approval({ approval_id: "current", status: "pending", tool: "workflow.create_task",
      canonical_request_id: "request", canonical_payload_hash: "a".repeat(64) });
  } finally { store.close(); }
  try {
    const audit = auditApprovals(path);
    assert.equal(audit.total, 2);
    assert.equal(audit.legacy, 1);
    assert.equal(audit.canonical, 1);
    assert.equal(audit.malformed, 0);
    assert.deepEqual(audit.legacy_cards, [{ approval_id: "old", status: "approved",
      tool: "workflow.create_task", created_at: "2026-11-14T00:00:00Z",
      execution_status: "not_started" }]);
    assert.doesNotMatch(JSON.stringify(audit), /never-output-this/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

/** Gate 11 uses the existing Harbour bridge, without changing any connector. */
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { salesOps as config } from "../src/onboarding/sales-ops.js";
import { assertSalesOpsDiscovery, runSalesOpsGate } from "./sales-ops-gate.js";
const client = new Client({ name: "aa-sales-ops-gate11", version: "1.0.0" });
let calls = 0;
try {
  const [fixturePath, headerPath] = process.argv.slice(2);
  assert.ok(fixturePath && headerPath, "Requires fixture and private header paths");
  assert.equal(statSync(headerPath).mode & 0o077, 0);
  const fixtures = JSON.parse(readFileSync(fixturePath, "utf8"));
  await client.connect(new StdioClientTransport({ command: config.connector.command,
    args: config.connector.args.map(a => a === "<private-header-file>" ? headerPath : a), stderr: "ignore" }));
  const names: string[] = [];
  let cursor: string | undefined;
  const seen = new Set<string>();
  do {
    const page = await client.listTools(cursor ? { cursor } : {});
    names.push(...page.tools.map(t => t.name)); cursor = page.nextCursor;
    if (cursor) { assert.ok(!seen.has(cursor)); seen.add(cursor); }
  } while (cursor);
  assertSalesOpsDiscovery(names);
  await runSalesOpsGate(async (name, args) => {
    calls++;
    return (await client.callTool({ name, arguments: args })).structuredContent;
  }, fixtures);
  console.log(JSON.stringify({ bot_id: config.bot_id, gate: 11, calls, discovery: names.length,
    status: "PASS", at: new Date().toISOString() }));
} catch {
  console.error(JSON.stringify({ bot_id: config.bot_id, gate: 11, calls, status: "FAIL",
    message: "Inspect locally; no secret-bearing error output emitted." }));
  process.exitCode = 1;
} finally { await client.close(); }

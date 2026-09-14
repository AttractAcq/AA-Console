/** Explicit local/staging target only. Never reads or prints header contents. */
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { adminCalendar } from "../src/onboarding/admin-calendar.js";
import { assertAdminDiscovery, runAdminGate } from "./admin-gate.js";
const client = new Client({ name: "aa-admin-gate12", version: "1.0.0" });
let calls = 0;
try {
  const [fixturePath, headerPath, endpoint] = process.argv.slice(2);
  assert.ok(
    fixturePath && headerPath && endpoint,
    "Requires fixtures, private header path and explicit staging/local MCP URL",
  );
  const url = new URL(endpoint);
  assert.ok(
    !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname === "/mcp",
  );
  assert.notEqual(
    url.hostname,
    "mcp.attractacq.com",
    "Production smoke is not enabled in this phase",
  );
  assert.ok(
    url.protocol === "https:" ||
      (url.protocol === "http:" &&
        ["localhost", "127.0.0.1"].includes(url.hostname)),
  );
  assert.equal(statSync(headerPath).mode & 0o077, 0);
  const fixtures = JSON.parse(readFileSync(fixturePath, "utf8"));
  // A known-invalid, nonsecret credential must fail at the MCP HTTP boundary.
  const bad = await fetch(url, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(10000),
    headers: {
      authorization: "Bearer gate12-invalid-test-credential",
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {},
    }),
  });
  assert.equal(bad.status, 401);
  await bad.body?.cancel();
  await client.connect(
    new StdioClientTransport({
      command: adminCalendar.connector.command,
      args: ["-y", "mcp-remote", endpoint, "--header-file", headerPath],
      stderr: "ignore",
    }),
  );
  const names: string[] = [];
  let cursor: string | undefined;
  const seen = new Set<string>();
  do {
    const page = await client.listTools(cursor ? { cursor } : {});
    names.push(...page.tools.map((t) => t.name));
    cursor = page.nextCursor;
    if (cursor) {
      assert.ok(!seen.has(cursor));
      seen.add(cursor);
    }
  } while (cursor);
  assertAdminDiscovery(names);
  await runAdminGate(async (name, args) => {
    calls++;
    return (await client.callTool({ name, arguments: args })).structuredContent;
  }, fixtures);
  console.log(
    JSON.stringify({
      bot_id: "bot_admin",
      gate: 12,
      status: "PASS",
      discovery: names.length,
      calls,
      at: new Date().toISOString(),
    }),
  );
} catch {
  console.error(
    JSON.stringify({
      bot_id: "bot_admin",
      gate: 12,
      status: "FAIL",
      calls,
      message:
        "Inspect sanitized fixture/audit evidence locally; reconcile interrupted fixtures.",
    }),
  );
  process.exitCode = 1;
} finally {
  await client.close();
}

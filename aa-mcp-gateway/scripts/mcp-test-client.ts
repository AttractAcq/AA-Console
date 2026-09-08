import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const [client_id, idea_id, idempotency_key] = process.argv.slice(2);
if (!client_id || !idea_id || !idempotency_key || !process.env.MCP_BOT_TOKEN)
  throw new Error(
    "Usage: MCP_BOT_TOKEN=<gateway Bot token> node --import tsx scripts/mcp-test-client.ts <client UUID> <idea UUID> <idempotency key>",
  );
const client = new Client({ name: "aa-local-test", version: "1.0.0" });
try {
  await client.connect(
    new StreamableHTTPClientTransport(
      new URL(process.env.MCP_URL ?? "http://localhost:3100/mcp"),
      {
        requestInit: {
          headers: { Authorization: `Bearer ${process.env.MCP_BOT_TOKEN}` },
        },
      },
    ),
  );
  console.log(JSON.stringify(await client.listTools(), null, 2));
  console.log(
    JSON.stringify(
      await client.callTool({
        name: "content.generate_brief",
        arguments: { client_id, idea_id, idempotency_key },
      }),
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify(
      await client.callTool({
        name: "workflow.get_activity",
        arguments: { client_id, limit: 10 },
      }),
      null,
      2,
    ),
  );
} finally {
  await client.close();
}

import { writeFileSync } from "node:fs";
import { registry } from "../src/registry/tools.js";
import { bots } from "../src/shared/types.js";
import { allowed, grants } from "../src/policy/permissions.js";
writeFileSync(
  "docs/tool-registry.md",
  `# Tool registry\n\n${registry.length} initial business contracts. Status is adapter availability, not evidence of live deployment. Brief generation is implemented and requires AA_INTERNAL_API_URL and AA_MCP_SERVICE_SECRET. Stub schemas reserve bounded business fields and must be versioned/refined before their adapters are enabled. All calls require an authorized client UUID; all writes require an idempotency key. HIGH/CRITICAL policy always requires human approval.\n\n| Tool | Status | Action | Risk | Approval | Reversible | Dependency |\n| --- | --- | --- | --- | --- | --- | --- |\n` +
    registry
      .map(
        (t) =>
          `| ${t.name} | ${t.implementation} | ${t.action} | ${t.risk} | ${t.approval ? "required" : t.name === "workflow.create_approval" ? "creates approval" : "no"} | ${t.reversible} | ${t.dependency} |`,
      )
      .join("\n") +
    "\n\n`workflow.record_decision` is reserved, denied to every Bot; human decisions use the reviewer API. Exact machine-readable input/output schemas and required permissions are in `src/registry/tools.ts`. Default MCP discovery and `call` expose only permitted tools with `implementation: real` (or `partial`). Stub contracts remain catalogued here and appear in `tools/list` only when `MCP_DISCOVER_STUBS=true`.\n",
);
writeFileSync(
  "docs/bot-permissions.md",
  "# Bot permissions\n\nDefault deny. Both discovery and calls use the same permission matrix. Default MCP `tools/list` and `ActionEngine.call` additionally hide stub (unimplemented) contracts unless `MCP_DISCOVER_STUBS=true`. Granted lists below are the full permission matrix, including stubs that stay in the registry. Every request is additionally restricted to the credential’s client UUID allowlist; there is no wildcard client grant. Human reviewer credentials are separate. Intelligence modules are not employee Bots.\n\n" +
    bots
      .map(
        (bot) =>
          `## ${bot}\n\nConfigured grants: ${grants[bot].map((g) => "`" + g + "`").join(", ")}.\n\nEffective tools (${registry.filter((t) => allowed(bot, t)).length}):\n\n` +
          registry
            .filter((t) => allowed(bot, t))
            .map((t) => "- `" + t.name + "`")
            .join("\n"),
      )
      .join("\n\n") +
    "\n\nAll Bots are denied `workflow.record_decision`, including wildcard workflow grants. No finance payment or production deployment capability is exposed. `sales_agents.deploy` is a CRITICAL stub behind mandatory approval. Production Manager (`bot_production`) default discovery is the real granted tools: `content.list_ideas`, `content.get_idea`, `content.generate_brief`, `content.get_brief`, `content.request_revision`, `content.get_production_status`, `content.create_repurpose_plan`, `content.request_approval`, `workflow.create_approval`, `workflow.get_pending_approvals`, and `workflow.get_activity`.\n",
);

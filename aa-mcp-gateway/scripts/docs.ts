import { writeFileSync, appendFileSync } from "node:fs";
import { registry } from "../src/registry/tools.js";
import { bots } from "../src/shared/types.js";
import {
  allowed,
  grants,
  PRODUCTION_ONLY_TOOLS,
  DISTRIBUTION_ONLY_TOOLS,
} from "../src/policy/permissions.js";
const status = (name: string, implementation: string) =>
  implementation === "real" && PRODUCTION_ONLY_TOOLS.has(name)
    ? "real (bot_production only)"
    : implementation === "real" && DISTRIBUTION_ONLY_TOOLS.has(name)
      ? "real (bot_distribution only)"
      : implementation === "real" && name.startsWith("admin.")
        ? "real (bot_admin only)"
        : implementation;
writeFileSync(
  "docs/tool-registry.md",
  `# Tool registry\n\n${registry.length} initial business contracts. Status is adapter availability, not evidence of live deployment. Brief generation is implemented and requires AA_INTERNAL_API_URL and AA_MCP_SERVICE_SECRET. Stub schemas reserve bounded business fields and must be versioned/refined before their adapters are enabled. All calls require an authorized client UUID; all writes require an idempotency key. HIGH/CRITICAL policy always requires human approval.\n\n| Tool | Status | Action | Risk | Approval | Reversible | Dependency |\n| --- | --- | --- | --- | --- | --- | --- |\n` +
    registry
      .map(
        (t) =>
          `| ${t.name} | ${status(t.name, t.implementation)} | ${t.action} | ${t.risk} | ${t.approval ? "required" : t.name === "workflow.create_approval" ? "creates approval" : "no"} | ${t.reversible} | ${t.dependency} |`,
      )
      .join("\n") +
    "\n\n`workflow.record_decision` is reserved, denied to every Bot; human decisions use the reviewer API. Exact machine-readable input/output schemas and required permissions are in `src/registry/tools.ts`. Default MCP discovery and `call` expose only permitted tools with `implementation: real` (or `partial`). Stub contracts remain catalogued here and appear in `tools/list` only when `MCP_DISCOVER_STUBS=true`.\n\n" +
    '`content.select_idea` and `content.approve_asset` are real for `bot_production` only ([Phase 9b](phase-9b-production-bot-decide.md)), hard-coded in `src/policy/permissions.ts` `allowed()` and in the AA RPCs themselves — not through the permission-grant matrix, since `bot_marketing` keeps a `content.*` wildcard for its other real content tools. `content.queue_distribution` and `content.record_publication` are real for `bot_distribution` only ([Phase 10](phase-10-distribution-manager.md)), same hard-coded pattern, since `bot_production` keeps a `content.*` wildcard for its other real content tools. Every other Bot gets `not_implemented`/"Tool unavailable or unauthorized." for all four.\n',
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
    "\n\nAll Bots are denied `workflow.record_decision`, including wildcard workflow grants. No finance payment or production deployment capability is exposed. `sales_agents.deploy` is a CRITICAL stub behind mandatory approval. Production Manager (`bot_production`) default discovery is the real granted tools: `content.list_ideas`, `content.get_idea`, `content.generate_brief`, `content.get_brief`, `content.request_revision`, `content.get_production_status`, `content.create_repurpose_plan`, `content.request_approval`, `workflow.create_approval`, `workflow.get_pending_approvals`, `workflow.get_activity`, and the five durable workflow task tools.\n\n" +
    "`content.select_idea` (idea approve) and `content.approve_asset` (asset decide) are real **only** for `bot_production` ([Phase 9b](phase-9b-production-bot-decide.md)). `bot_marketing` keeps its `content.*` grant — needed for its other real content tools — but is hard-denied on these two names in `src/policy/permissions.ts` `allowed()` and again inside the AA RPCs themselves, exactly like `workflow.record_decision`. `bot_chief_of_staff` and `bot_client_delivery` never held `content.*` or either exact name.\n\n" +
    "`content.queue_distribution` (schedule) and `content.record_publication` (Gate 10 publish record) are real **only** for `bot_distribution` ([Phase 10](phase-10-distribution-manager.md)), same hard-coded pattern. `bot_production` keeps its `content.*` grant — needed for its other real content tools — but is hard-denied on these two names. `content.get_performance` and `attribution.get_content_performance` remain stubs (no live performance read yet): granted to `bot_distribution` per the original migration 65 seed, but indistinguishable from an ungranted tool unless `MCP_DISCOVER_STUBS=true`.\n",
);

// Phase 12 exact Admin surface and AA-native provider boundary.
const adminNote =
  "\n\nPhase 12: `bot_admin` has an exact 15-tool ceiling (nine reads/six writes), including four AA-native `admin.*` event tools. Other Bots cannot invoke Admin tools even with stale wildcard grants. Admin has no Finance, Security, Engineering, pipeline, sales_agents or content tools, and `workflow.record_decision` remains universally denied. Events do not send invitations or notifications. See [Phase 12](phase-12-admin-calendar.md) for database objects, guarded RPCs, replay authorization and `smoke:admin`. Gate 12 is NOT YET CLOSED.\n";
for (const file of ["docs/tool-registry.md", "docs/bot-permissions.md"])
  appendFileSync(file, adminNote);

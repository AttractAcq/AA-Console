import { writeFileSync, appendFileSync } from "node:fs";
import { registry } from "../src/registry/tools.js";
import { bots } from "../src/shared/types.js";
import {
  allowed,
  grants,
  PRODUCTION_ONLY_TOOLS,
  DISTRIBUTION_ONLY_TOOLS,
  ENGINEERING_ISSUE_TOOLS,
  SECURITY_TOOLS,
} from "../src/policy/permissions.js";
const status = (name: string, implementation: string) =>
  implementation === "real" && PRODUCTION_ONLY_TOOLS.has(name)
    ? "real (bot_production only)"
    : implementation === "real" && DISTRIBUTION_ONLY_TOOLS.has(name)
      ? "real (bot_distribution only)"
      : implementation === "real" && name.startsWith("admin.")
        ? "real (bot_admin only)"
        : implementation === "real" && name.startsWith("economics.")
          ? "real (bot_finance only)"
          : implementation === "real" && ENGINEERING_ISSUE_TOOLS.has(name)
            ? "real (bot_engineering only)"
            : implementation === "real" && SECURITY_TOOLS.has(name)
              ? "real (bot_security_devops only)"
              : implementation === "real" && name.startsWith("engineering.")
                ? "real (bot_engineering; status also bot_security_devops)"
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
const financeNote =
  "\n\nPhase 13: `bot_finance` has an exact 14-tool ceiling (ten reads/four writes): five named `economics.*` Client Economics OS reads, `attribution.get_revenue_attribution`, and the eight-tool workflow suite. The seeded `economics.*` wildcard is replaced with exact rows. Other Bots cannot invoke `economics.*` even with stale wildcards. Money writes (`pipeline.record_sale`, payments, bank/Stripe/Xero) are not granted and stay stub. See [Phase 13](phase-13-finance-controller.md) for guarded RPCs and `smoke:finance`. Gate 13 is NOT YET CLOSED.\n";
const engineeringNote =
  "\n\nPhase 14: `bot_engineering` has an exact 12-tool ceiling (seven reads/five writes). The seeded `engineering.*` wildcard is replaced with four named engineering tools plus the eight workflow names. Issue create/get are bot_engineering only. Release and deployment status reads project client-scoped `client_pages` / `agent_jobs` (no HTML, params, costs or secrets) and remain callable by `bot_security_devops` via its existing exact grants. No Railway write, secret rotation or unrestricted deploy tools. See [Phase 14](phase-14-engineering-ops.md). Gate 14 is NOT YET CLOSED.\n";
const securityNote =
  "\n\nPhase 15: `bot_security_devops` has an exact 14-tool ceiling (nine reads/five writes). The seeded `security.*` wildcard is replaced with four named security tools, two engineering status reads, and the eight workflow names. Security tools are bot_security_devops only. System status is client-scoped counts (no HTML, params, costs, tokens or env). Findings/incidents are AA-native tracking records. No destroy, secret rotation, Railway write, unrestricted deploy or global/unscoped client tools. See [Phase 15](phase-15-security-devops.md). Gate 15 is NOT YET CLOSED.\n";
const conversionNote =
  "\n\nPhase 16: `bot_marketing` has an exact 40-tool ceiling (19 reads/21 writes). Ten `conversion.*` Page Builder tools are real against `client_pages` / polish jobs (no page publish). `campaign.list`/`get`/`get_status` plus create/update/request_approval/plan/provision/launch/get_readiness bind to Execution OS `client_campaigns`. Legacy `public.campaigns` remains the attribution spend tracker via `attribution.get_campaign_performance` only. Conversion tools are Marketing only. CoS keeps `campaign.*`. Production does not get conversion. See [Phase 16](phase-16-conversion-campaign.md). Gate 16 is NOT YET CLOSED.\n";
for (const file of ["docs/tool-registry.md", "docs/bot-permissions.md"]) {
  appendFileSync(file, adminNote);
  appendFileSync(file, financeNote);
  appendFileSync(file, engineeringNote);
  appendFileSync(file, securityNote);
  appendFileSync(file, conversionNote);
}

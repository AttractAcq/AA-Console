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
  name === "content.create_upload_url"
    ? "real (bot_production mint; CoS read-check only)"
    : implementation === "real" && PRODUCTION_ONLY_TOOLS.has(name)
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
    '`content.select_idea`, `content.approve_asset`, `content.assign_production`, `content.create_upload_url` and `content.submit_asset` are real for `bot_production` only ([Phase 9b](phase-9b-production-bot-decide.md), [Phase 16b](phase-16b-sales-proof-production.md), [content.create_upload_url](content-create-upload-url.md)), hard-coded in `src/policy/permissions.ts` `allowed()` and in the AA RPCs themselves — not through the permission-grant matrix, since `bot_marketing` keeps a `content.*` wildcard for its other real content tools. `content.create_upload_url` is the exception for `bot_chief_of_staff`: a read-check that returns eligibility and never an upload URL. `content.queue_distribution` and `content.record_publication` are real for `bot_distribution` only ([Phase 10](phase-10-distribution-manager.md)), same hard-coded pattern, since `bot_production` keeps a `content.*` wildcard for its other real content tools. Every other Bot gets `not_implemented`/"Tool unavailable or unauthorized." for those names.\n',
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
    "\n\nAll Bots are denied `workflow.record_decision`, including wildcard workflow grants. No finance payment or production deployment capability is exposed. `sales_agents.deploy` is a CRITICAL stub behind mandatory approval. Production Manager (`bot_production`) default discovery is the real granted tools: `content.list_ideas`, `content.get_idea`, `content.generate_brief`, `content.get_brief`, `content.request_revision`, `content.get_production_status`, `content.create_repurpose_plan`, `content.request_approval`, `content.select_idea`, `content.approve_asset`, `content.assign_production`, `content.create_upload_url`, `content.submit_asset`, all six `proof.*` tools, `workflow.create_approval`, `workflow.get_pending_approvals`, `workflow.get_activity`, and the five durable workflow task tools.\n\n" +
    "`content.select_idea` (idea approve), `content.approve_asset` (asset decide), `content.assign_production`, `content.create_upload_url` and `content.submit_asset` are real **only** for `bot_production` ([Phase 9b](phase-9b-production-bot-decide.md), [Phase 16b](phase-16b-sales-proof-production.md), [content.create_upload_url](content-create-upload-url.md)). `bot_chief_of_staff` may call `content.create_upload_url` as a read-check (eligible / brief status only; no URL, no storage path). `bot_marketing` keeps its `content.*` grant — needed for its other real content tools — but is hard-denied on these names in `src/policy/permissions.ts` `allowed()` and again inside the AA RPCs themselves, exactly like `workflow.record_decision`. `bot_client_delivery` never held `content.*` or these exact names.\n\n" +
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
  "\n\nPhase 16 (PR #48 / mig 89): `bot_marketing` post-#48 ceiling is **40** exact tools (19 reads/21 writes) via **additive** grants — Gate 9's 23 rows stay; this phase insert-only-owns 17 conversion + campaign execution names. This is **not** the final 45 (`brand.*` / `sites.*` / remaining attribution are out). After #48 then #46 then #47 the target is Marketing **45** / Sales Ops **28**; those PRs must APPEND, not replace. Registry length **97** is catalog size after #48 only. Ten `conversion.*` Page Builder tools are real against `client_pages` / polish jobs (no page publish). `campaign.launch` marks Execution OS `client_campaigns.status=live` only — no ad spend, Meta, or paid channels — so it stays MEDIUM without approval. CoS keeps `campaign.*` and is denied conversion. Production does not get conversion. See [Phase 16](phase-16-conversion-campaign.md). Gate 16 is NOT YET CLOSED.\n";
const salesProofNote =
  "\n\nPhase 16b: `bot_sales_ops` has an exact 25-tool ceiling after this PR (Phase 11b's 22 plus `sales_agents.attach_to_page`, `sales_agents.set_deployment_enabled`, `sales_agents.build`). Phase 16c (PR #46) additively grants `brand.get_profile`, `sites.provision`, `sites.publish_page` → final 28; it must append, not overwrite from the 22-tool baseline. `sales_agents.create` stays draft-only; `build` enqueues the Console `sales_agent` job. Attach inserts `client_sales_agent_deployments` with `enabled:false` and origin from the published URL. Enable is a kill-switch (one enabled deployment per page). `sales_agents.deploy` stays CRITICAL stub + ungranted. `approved_at` remains human-only. All six `proof.*` tools are real for `bot_production`; bots cannot set `usage_rights` clearance. `content.assign_production` and `content.submit_asset` are real for `bot_production` only; `content.approve_asset` stays Production-only. Catalog after #48 (97) + this PR's 3 sales_agents names: **100**. See [Phase 16b](phase-16b-sales-proof-production.md). Gate 16b is NOT YET CLOSED.\n";
const uploadUrlNote =
  "\n\n`content.create_upload_url` (migration 126): `bot_production` receives a 30-minute `client-media` reservation and a signed PUT URL minted by the Console runtime service role. Flow is `create_upload_url` → HTTP PUT bytes → `content.submit_asset` with `storage_path` or `pending_asset_id`. `bot_chief_of_staff` gets an eligibility read-check and never a URL. Marketing and every other bot are denied. No service-role key is added to a bot environment. Catalog **104**. See [content.create_upload_url](content-create-upload-url.md).\n";
const phase16cNote =
  "\n\nPhase 16c: Attribution funnel and content-performance reads are real (empty data returns zeros/null ratios or `items: []`, never invented numbers). `attribution.generate_report` stays stub. `attribution.get_revenue_attribution` remains Finance/CoS. `brand.get_profile` is read-only for Marketing, Sales Ops and Production. `sites.provision` / `sites.publish_page` call the same runtime orchestration as Console admin routes; GitHub App keys stay on the agent-runtime. Owners are `bot_marketing` and `bot_sales_ops` — not Engineering. Both sites writes require gateway approval (HIGH, irreversible GitHub write). Conversion and campaign execution tools stay **real** after this last-writer PR (merge order #48→#47→#46). Marketing ceiling is **45**; Sales Ops is **28**. Catalog after A+B+C: **103**. See [Phase 16c](phase-16c-attribution-brand-sites.md). Gate 16c is NOT YET CLOSED.\n";
for (const file of ["docs/tool-registry.md", "docs/bot-permissions.md"]) {
  appendFileSync(file, adminNote);
  appendFileSync(file, financeNote);
  appendFileSync(file, engineeringNote);
  appendFileSync(file, securityNote);
  appendFileSync(file, conversionNote);
  appendFileSync(file, salesProofNote);
  appendFileSync(file, phase16cNote);
  appendFileSync(file, uploadUrlNote);
}

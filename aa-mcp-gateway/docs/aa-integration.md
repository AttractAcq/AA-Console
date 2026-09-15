# Connecting to AA

## Source discovery and reuse map

Paths below refer to the existing AA Console repository. No live database or provider was accessed.

| Capability | Existing source | Gateway integration status |
| --- | --- | --- |
| Authentication/client scoping | `src/lib/supabase.ts`, foundation migration 01, RLS migrations 18/19, `agent-runtime/src/master/auth.ts` | Separate Bot credentials and UUID client allowlists; never mint human admin sessions |
| Idea → brief | `approve_idea_and_generate_brief` in migration 05; `agent-runtime/src/agents/brief/index.ts`, structured briefs migration 55 | Implemented fixed AA API adapter; AA endpoint proven live by supplied AA smoke test |
| Ideas (list/get) | `client_ideas`; MCP RPCs in migration 68 | Implemented: `content.list_ideas`, `content.get_idea` |
| Production status / revision / approval request | `client_briefs`, `client_media_assets`, `agent_jobs`; MCP RPCs in migration 68 | Implemented for Production Manager v1. `review_media_asset` stays human-only; `content.approve_asset` is implemented for `bot_production` only (migration 74, [Phase 9b](phase-9b-production-bot-decide.md)) |
| Idea approve (`content.select_idea`) | `client_ideas`; MCP RPC `mcp_approve_idea` in migration 74 | Implemented for `bot_production` only ([Phase 9b](phase-9b-production-bot-decide.md)). Sets status only; does not generate a brief |
| Distribution / repurpose | `schedule_asset`, migration 56 `repurpose_asset`, runtime `repurpose`; MCP `mcp_create_repurpose_plan` | `content.create_repurpose_plan` implemented (approved asset → derivative briefs). `content.queue_distribution` remains a stub |
| Campaigns | Migration 14 `campaigns`; `campaign_intel` worker; frontend campaign views; Phase 16 Execution OS `client_campaigns` | `campaign.list`/`get`/`get_status` remain orchestration reads. Create/update/plan/provision/launch/`get_readiness` are real against Execution OS (no ad spend) |
| Production | Migration 40 `build_brief_with_ai`, `dispatch_brief_to_members`; runtime `creative_build`, `brief_dispatch`; Phase 16b `mcp_assign_production` / `mcp_submit_asset` | Implemented for `bot_production` only. AI route refuses video. `content.approve_asset` stays Production-only. |
| Asset approval | Migration 05 `review_media_asset`, later review-trail migrations; `src/pages/approvals/ApprovalsPanel.tsx` | Human path unchanged. `bot_production` also has a direct decide path (`content.approve_asset`, migration 74) writing the same `client_asset_reviews` ledger with Bot attribution |
| Distribution / repurpose | `schedule_asset`, migration 56 `repurpose_asset`, runtime `repurpose` | Stub; preserve scheduling and source ownership checks |
| Conversion | `src/pages/conversion/PageBuilderPanel.tsx`, runtime `landing_page`, migration 59 page HTML; Phase 16 `mcp_conversion` | Real for `bot_marketing`. Page Builder tools against `client_pages` / polish jobs; no page publish |
| Leads / pipeline | Migration 61 `advance_lead`, `stalled_leads`; prospects/leads panel | Stub; reuse transition logic |
| Proof | Migrations 57/58, `client_proof_assets`; Phase 16b `mcp_proof_*` | Implemented for `bot_production`. Reads include uncleared rows; `get_for_avatar` / `get_for_claim` only return human-cleared unexpired proof. Bots cannot set `usage_rights`. |
| Attribution | Migration 62 `top_content_by_revenue`, `acquisition_funnel`; reporting `useMetrics.ts`, `metrics_period_summary`; Phase 13 `mcp_attribution_revenue`; Phase 16c funnel/content RPCs | `attribution.get_campaign_performance` real (observed paid metrics). `attribution.get_revenue_attribution` real (cohort campaign economics; Gate 13). `attribution.get_conversion_funnel` / `attribution.get_content_performance` real (empty zeros/`items: []`; Gate 16c). `attribution.generate_report` remains stub |
| Economics | Migration 79 Client Economics OS (`client_economics`, spend ledger); Phase 13 `mcp_economics_read` | Five named reads real for `bot_finance` only. Does not expose `finance_entries` / `client_billing` / payments |
| Workflow | Production `job_assignments`, worker `agent_jobs`, onboarding steps, review trails | These are distinct lifecycles, not a general task service. Only gateway approvals/activity are implemented |
| Sales agents | Factory RPCs (migration 84); attach/enable/build (migration 90); live Meta deploy remains stub | Implemented for `bot_sales_ops`. `sales_agents.deploy` stays CRITICAL stub. `approved_at` is human-only. |
| Engineering | Migration 86 `mcp_engineering_*`; `client_pages` / `agent_jobs` safe projections | Implemented for `bot_engineering` (issue create/get; status also `bot_security_devops`). No Railway write, secret rotation or unrestricted deploy |
| Security | Migration 87 `mcp_security_*`; AA-native findings plus client-scoped job/page counts | Implemented for `bot_security_devops` only. No secret dumps, destroy, Railway write, unrestricted deploy or global/unscoped clients |
| Brand | Migration 53 `client_brand_profiles`; Phase 16c `mcp_brand_get_profile` | Read-only for Marketing, Sales Ops, Production. Writes stay human/Console |
| Sites | Runtime `provisionSite` / `publishPage` (injectWidget); Phase 16c `mcp_sites_authorize` | Marketing/Sales Ops only. GitHub App keys stay on the agent-runtime. `sites.provision` and `sites.publish_page` require gateway approval |

Existing runtime HTTP exposes `/health`, `/status`, `/master/chat`. Do not route business actions through Master AI chat. No local `supabase/functions` directory exists. Local migrations extend beyond the stale migration count in `supabase/README.md`; verify deployed versions separately.

## Required AA-owned endpoint

The gateway implements these fixed outgoing routes:

`POST /internal/mcp/content/generate-brief` — unchanged. Request `{ "client_id", "idea_id" }`. Response `{ "job_id", "client_id" }` with HTTP 202 / 200 replay.

Phase 5 Production Manager (migration 68, **do not apply to production without Alex**):

| Route | Body (UUIDs unless noted) |
| --- | --- |
| `POST /internal/mcp/content/list-ideas` | `client_id`, optional `limit`, optional `status` |
| `POST /internal/mcp/content/get-idea` | `client_id`, `idea_id` |
| `POST /internal/mcp/content/get-brief` | `client_id` and `brief_id` and/or `idea_id` |
| `POST /internal/mcp/content/get-production-status` | `client_id` and at least one of `idea_id` / `brief_id` / `asset_id` |
| `POST /internal/mcp/content/request-revision` | `client_id`, `summary`, plus a resource id |
| `POST /internal/mcp/content/request-approval` | `client_id`, plus a resource id |
| `POST /internal/mcp/content/create-repurpose-plan` | `client_id`, `asset_id`, `formats` (1–6 known keys) |

Same headers as generate-brief. Binding Sec rules: [phase-5-production-manager.md](./phase-5-production-manager.md) (ping Sec before merge; `require_bot_client_grant` + active bot; never `can_access_client`; resource client match; gateway permissions + `workflow.record_decision` hard-deny; isolation tests before non-stub).

`POST /internal/mcp/auth/resolve` (Phase 3 dual-read)

Headers: server-to-server Bearer credential. Body: `{ "token_hash": "<sha256 hex>" }`. The gateway hashes the Bot Bearer first; plaintext never leaves the gateway. The hash is never logged. Railway private hop may be HTTP to `aa-console.railway.internal` (host-exact allowlist).

The AA-side live smoke test confirmed service authentication, supported Bot validation, bot/client authorization, client/idea matching, approved-state enforcement, durable idempotency, queue creation, attribution, and worker retry safety. These remain AA-owned; the gateway does not duplicate them or access Supabase. Dual-read still evaluates the code permission matrix; DB grants are compared and a mismatch denies. After cutover (`BOT_AUTH_MODE=db`) AA-resolved permission patterns on Identity are authoritative for discover/call (default deny; `workflow.record_decision` still hard-denied in code) and nonempty `BOT_CREDENTIALS_JSON` is refused.

The current gateway contains no Supabase dependency, service-role key, raw table adapter, or general URL tool. Enabling `AA_INTERNAL_API_URL` assumes the endpoint contract above has been implemented and verified. Without both AA variables, brief calls safely return `not_implemented`. Set `AA_MCP_SERVICE_SECRET` with the AA service secret. Tests exercise the real adapter against local HTTP mock servers; gateway-to-live-AA validation remains to be run with configured credentials.

## Console approval integration

Server-side Console integration must verify a human admin with Supabase Auth and current `profiles.role`, as the existing runtime does. Map that verified human to an individually provisioned gateway reviewer credential kept server-side. Never put reviewer credentials in Vite environment variables or the browser bundle. The gateway currently authenticates provisioned reviewers itself; native Supabase user-token verification is not implemented here.

`GET /admin/approvals` returns up to 1,000 latest records, including private payloads. `POST /admin/approvals/:id/decision` accepts `{ "decision": "approved" | "rejected", "reason"?: "..." }`. `POST /admin/approvals/:id/execute` accepts `{}` and explicitly executes the bound approved action. No Bot credential can access these endpoints. Decisions expire after 24 hours; expiration is enforced on decision/execution and pending-query paths. Decision and execution are separate. Approved actions execute only once, with current Bot configuration and client permissions rechecked. Approved stubs fail as unimplemented rather than claiming execution when `MCP_DISCOVER_STUBS=true`; in default mode stub tools are unavailable on both discovery and `call`.

Approval fields include ID, requester, action/tool, target/client, summary, private structured payload, risk, creation/expiry, status, approver/time, rejection reason, and execution status. `workflow.create_approval` is an informational review request and cannot smuggle another tool for execution. `workflow.record_decision` remains a documented reserved contract but is denied to all Bots.

# Connecting to AA

## Source discovery and reuse map

Paths below refer to the existing AA Console repository. No live database or provider was accessed.

| Capability | Existing source | Gateway integration status |
| --- | --- | --- |
| Authentication/client scoping | `src/lib/supabase.ts`, foundation migration 01, RLS migrations 18/19, `agent-runtime/src/master/auth.ts` | Separate Bot credentials and UUID client allowlists; never mint human admin sessions |
| Idea → brief | `approve_idea_and_generate_brief` in migration 05; `agent-runtime/src/agents/brief/index.ts`, structured briefs migration 55 | Implemented fixed AA API adapter; AA endpoint proven live by supplied AA smoke test |
| Ideas (list/get) | `client_ideas`; MCP RPCs in migration 68 | Implemented: `content.list_ideas`, `content.get_idea` |
| Production status / revision / approval request | `client_briefs`, `client_media_assets`, `agent_jobs`; MCP RPCs in migration 68 | Implemented for Production Manager v1. `content.approve_asset` and `review_media_asset` stay human-only |
| Distribution / repurpose | `schedule_asset`, migration 56 `repurpose_asset`, runtime `repurpose`; MCP `mcp_create_repurpose_plan` | `content.create_repurpose_plan` implemented (approved asset → derivative briefs). `content.queue_distribution` remains a stub |
| Campaigns | Migration 14 `campaigns`; `campaign_intel` worker; frontend campaign views | Data and generation exist; scoped lifecycle API missing |
| Production | Migration 40 `build_brief_with_ai`, `dispatch_brief_to_members`; runtime `creative_build`, `brief_dispatch` | Stub; reuse atomic RPCs, preserve admin/compensation rules |
| Asset approval | Migration 05 `review_media_asset`, later review-trail migrations; `src/pages/approvals/ApprovalsPanel.tsx` | Stub; human approval policy must precede AA review RPC |
| Distribution / repurpose | `schedule_asset`, migration 56 `repurpose_asset`, runtime `repurpose` | Stub; preserve scheduling and source ownership checks |
| Conversion | `src/pages/conversion/PageBuilderPanel.tsx`, runtime `landing_page`, migration 59 page HTML | Stub; no fabricated page/deployment API |
| Leads / pipeline | Migration 61 `advance_lead`, `stalled_leads`; prospects/leads panel | Stub; reuse transition logic |
| Proof | Migrations 57/58, runtime `proof_discovery`, proof modules | Stub; preserve provenance and claim matching |
| Attribution | Migration 62 `top_content_by_revenue`, `acquisition_funnel`; reporting `useMetrics.ts`, `metrics_period_summary` | Stub; reuse metric basis and attribution calculations |
| Economics | Migration 07 billing/finance tables, reporting metrics | Stub; no validated economics business API found |
| Workflow | Production `job_assignments`, worker `agent_jobs`, onboarding steps, review trails | These are distinct lifecycles, not a general task service. Only gateway approvals/activity are implemented |
| Sales agents, engineering, security | No matching complete business APIs found in inspected service surface | Stub |

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

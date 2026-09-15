# Phase 16b — Sales deployment ops + Proof Bank + production assign/submit

Status: implemented for Sec review; **do not merge, apply to production, or deploy to Railway without Alex via Chief of Staff.**
Base: latest `origin/main` (post #44/#45). Batch A (conversion/campaign) was not on main at branch time — start from main; rebase if it lands first.

The [Phase 3–4](phase-3-4-bot-auth-rls.md), [Phase 5](phase-5-production-manager.md), [Phase 9b](phase-9b-production-bot-decide.md), [Phase 11](phase-11-sales-ops.md) and [Phase 11b](phase-11b-sales-agent-factory.md) binding Sec rules remain binding. This phase realizes Bot-safe **page attach / kill-switch / enqueue**, **Proof Bank**, and **production assign/submit**. It does **not** realize live Meta/WhatsApp `sales_agents.deploy`, Bot `approved_at`, or Bot `usage_rights` clearance.

## What this phase realizes

### Sales Ops (`bot_sales_ops` only) — ceiling 22 → **25**

| Tool | Action | AA tables / jobs | Notes |
| --- | --- | --- | --- |
| `sales_agents.attach_to_page` | Write | `client_sales_agent_deployments` | Inserts `enabled:false`. Origin is scheme+host of `client_pages.published_url` (same rule as `originForPage` / `deployBlocker`). Requires agent `built_at`, `approved_at`, `status=live`, and page `publish_status=published` with a URL. Duplicate agent+page → `already_attached`. |
| `sales_agents.set_deployment_enabled` | Write | same | Kill-switch: `enabled` / `disabled_at` / `deployed_at`. Unique index: one enabled deployment per page (`deployment_conflict`). |
| `sales_agents.build` | Write (enqueue) | `enqueue_agent_job_internal('sales_agent')` | Console enqueue step. `sales_agents.create` stays draft-only (migration 84) so Gate 11b live smoke does not spend. |

**Not realized (unchanged posture):**

- `sales_agents.deploy` — CRITICAL stub, ungranted, no route. Live Meta/WhatsApp OAuth/webhook/send stays Phase 11c / Eng.
- No Bot tool sets `approved_at`. Human Console only.

### Proof Bank (`bot_production`)

All six catalog names are real against `client_proof_assets`:

| Tool | Notes |
| --- | --- |
| `proof.search` | Read of on-file rows (including uncleared). Does **not** enqueue `proof_discovery`. |
| `proof.get` | Single row; cross-client → `client_mismatch`. |
| `proof.get_for_avatar` / `proof.get_for_claim` | Same usable-proof rule as Console: `usage_rights=approved` and unexpired. |
| `proof.create` | Forces `usage_rights='not_cleared'`. There is no `usage_rights` input field. |
| `proof.attach_asset` | Updates `storage_path` only. Never writes clearance. |

Production already held the four proof **read** grants; this phase makes them discoverable (`implementation: real`) and adds `proof.create` / `proof.attach_asset`. Proof tools are not granted outside `bot_production` (`assert_cos_prohibitions`). Migration 90 deletes the leftover seed `proof.*` wildcard on `bot_marketing` (mig 65; Marketing's onboarding already listed proof as future-only).

### Production content (`bot_production` only)

| Tool | Notes |
| --- | --- |
| `content.assign_production` | `route=ai` inserts `creative_generations` and enqueues `creative_build` (video refused). `route=human` inserts `job_assignments` + `brief_dispatches` and enqueues `brief_dispatch` for active editors/avatars. |
| `content.submit_asset` | Inserts `client_media_assets` with `review_status=pending` and completes the assignment when one is supplied. |
| `content.approve_asset` | Unchanged: Production-only hard deny in `PRODUCTION_ONLY_TOOLS` and in the AA RPC. |

`content.assign_production` and `content.submit_asset` join `PRODUCTION_ONLY_TOOLS` because `bot_production` holds `content.*`. Marketing's exact ceiling already omits them; the hard gate is belt-and-suspenders like Phase 9b.

## Binding bars (unchanged)

- `require_active_bot` + `require_bot_client_grant` on every new Bot RPC. Never `can_access_client`.
- No `workflow.record_decision`. No SQL from Bots. Gateway is HTTP-only.
- Writes use existing ledgers (`mcp_sales_agent_requests`, `mcp_content_requests`) plus `mcp_proof_requests`.
- Public wrappers are `service_role` only. Internal functions revoked from `public`/`anon`/`authenticated`.
- Out of scope: conversion/campaign (batch A), `sites.*`, `brand.*`, attribution, money, `record_decision`, `sales_agents.deploy`.

## Database

Migration `supabase/migrations/20260916140000_90_mcp_sales_proof_production.sql` (number **90** — merges second after #48). Additive. Do not apply to production without Alex.

- Expands sales-agent and content ledger `tool` checks.
- Creates `mcp_internal.mcp_proof_requests` + `take_proof_request`.
- Helpers: `origin_for_page`, `enqueue_sales_agent_build`, `proof_json`, `deployment_json`.
- Public `mcp_*` wrappers.
- Inserts three Sales Ops grants (assert count **25**) and two proof write grants for production.
- Replaces `assert_cos_prohibitions` with a Phase 16b proof-outside-production check (prior 11–15 checks kept).

## Gateway / runtime

- Registry: `realSalesAgents` += attach/enable/build; `realProof` = all six; `realContent` += assign/submit. `sales_agents.deploy` stays stub.
- `sales-ops.ts` exact ceiling 25. `proof.search`/`proof.get` stay forbidden for Sales Ops.
- `permissions.ts`: production grants `proof.create` / `proof.attach_asset`; `PRODUCTION_ONLY_TOOLS` += assign/submit.
- AA adapter routes under `/internal/mcp/sales-agents/`, `/internal/mcp/proof/`, `/internal/mcp/content/assign-production|submit-asset`.
- Runtime: `sales-agents-route.ts`, `proof-route.ts`, `content-route.ts`; `server.ts` mounts `/internal/mcp/proof/`.

## Tests / smoke

- Gateway: discovery 25, factory writes + attach/enable/build through the mock AA, deploy never reaches AA, other-client deny-before-AA, Gate 16b attach cycle.
- Isolation: migration 90 on the partial PGlite fixture (80 is not loaded; deployments are stubbed without `extensions.gen_random_bytes`). Source assertions, same-client/cross-client, `usage_rights` forced `not_cleared`, AI video refuse, permission count 25.
- HTTP: attach origin, kill-switch, build enqueue, proof create rejects `usage_rights`, assign/submit.
- Live `smoke:sales-agent-factory` still runs Gate 11 + 11b (draft-only; **does not enqueue build**). `runSalesOpsDeploymentGate` runs only when fixtures include `page_id`.

## Rollback

1. Gateway: remove the three sales names from `realSalesAgents` / `salesOps.writes`, remove `realProof`, remove assign/submit from `realContent` and `PRODUCTION_ONLY_TOOLS`.
2. Do not apply migration 90. If already applied on a non-prod database, leave tables in place (additive) and stop granting the new names.

## Sec questions

1. **Is enqueue-via-`build` (not `create`) the right split?** Yes — Console is insert+enqueue; MCP `create` is already live as draft-only. Combining them would make Gate 11b spend.
2. **Does `proof.search` enqueue discovery?** No. Search is a read of `client_proof_assets`. Discovery stays a Console/human job.
3. **Can a Bot clear `usage_rights`?** No. No parameter, no RPC assignment, attach does not touch the column.
4. **Does attach enable the widget?** No. Insert is `enabled:false`, matching `AttachAgentControl`. Enable is a separate kill-switch tool.
5. **Ready for Sec:** yes, with isolation intended green before unstub. Draft PR only. No token, connector, prod migrate, or Railway deploy.

# Phase 16 — Conversion Page Builder + Campaign Execution MCP

Implemented for review on `cursor/phase-16-conversion-campaign-mcp-56ac`, based on latest `origin/main` after Phase 15 Security (PR #41 / mig 87) and Campaign Build One (mig 88). **Gate 16 = NOT YET CLOSED.** No production migration, deployment, token issuance or connector change has been performed.

## Objective

Make Marketing’s Page Builder tools real against Console `client_pages` / polish, and rebind `campaign.*` reads and writes to Campaign Execution OS (`client_campaigns`) instead of the legacy ad-tracker `public.campaigns` table.

Bots match Console: queue `landing_page` / `page_audit` / `page_revise` / `campaign_plan`, provision artifacts, derive readiness, request human review. **Bots cannot publish pages** (`sites.*` stays a later batch). Production does not receive conversion grants.

## Dual campaign tables

| Table | Owner | MCP tools |
|---|---|---|
| `public.client_campaigns` | Campaign Execution OS (plan / provision / launch) | `campaign.list`, `campaign.get`, `campaign.get_status`, `campaign.get_readiness`, `campaign.create`, `campaign.update`, `campaign.request_approval`, `campaign.plan`, `campaign.provision`, `campaign.launch` |
| `public.campaigns` | Ad-platform spend tracker | `attribution.get_campaign_performance` only (`mcp_campaign_read`). Economics spend linking stays here. |

Smoke fixtures must supply **both** `campaign_id` (execution row) and `ad_campaign_id` (tracker row).

## Explicit non-scope

`sites.*` / page publish, sales attach/enable, `proof.*`, `brand.*`, remaining attribution stubs, `workflow.record_decision`, `pipeline.record_sale`, `sales_agents.deploy`, bank/Stripe, Railway/secrets, bot `approved_at` approve/revoke, proof `usage_rights`, unrestricted Engineering deploy.

## Proposed MCP surface

All runtime routes use POST. Writes require an 8–128-character idempotency key. Reads need none. Every tool is client-scoped. Page projections omit HTML/body.

### Conversion (Marketing only)

| Tool | Action | Backend route | RPC action | Result |
|---|---|---|---|---|
| `conversion.list_pages` | Read | `/internal/mcp/conversion/list-pages` | `list_pages` | Page identity + `html_present` |
| `conversion.get_page` | Read | `/internal/mcp/conversion/get-page` | `get_page` | Page + findings + revision list (no HTML) |
| `conversion.get_performance` | Read | `/internal/mcp/conversion/get-performance` | `get_performance` | Operational finding counts only |
| `conversion.create_page` | Write / queue | `/internal/mcp/conversion/create-page` | `create_page` | Insert `client_pages` + `landing_page` job |
| `conversion.generate_structure` | Write / queue | `/internal/mcp/conversion/generate-structure` | `generate_structure` | `landing_page` job |
| `conversion.generate_copy` | Write / queue | `/internal/mcp/conversion/generate-copy` | `generate_copy` | `landing_page` job |
| `conversion.audit_page` | Write / queue | `/internal/mcp/conversion/audit-page` | `audit_page` | `page_audit` job; requires HTML |
| `conversion.revise_page` | Write / queue | `/internal/mcp/conversion/revise-page` | `revise_page` | Select FIXABLE findings + `page_revise` job |
| `conversion.revert_page` | Write | `/internal/mcp/conversion/revert-page` | `revert_page` | Append-only new revision |
| `conversion.request_approval` | Write | `/internal/mcp/conversion/request-approval` | `request_approval` | Queue `console_page_review` (no publish) |

### Campaign Execution (CoS wildcard + Marketing exact + CDM get/get_status)

| Tool | Action | Backend route | RPC action | Result |
|---|---|---|---|---|
| `campaign.list` / `get` / `get_status` | Read | `/internal/mcp/campaign/*` | `list` / `get` / `get_status` | `client_campaigns` |
| `campaign.get_readiness` | Read | `/internal/mcp/campaign/get-readiness` | `get_readiness` | Derived requirements |
| `campaign.create` | Write / queue | `/internal/mcp/campaign/create` | `create` | Insert + `campaign_plan` job |
| `campaign.plan` | Write / queue | `/internal/mcp/campaign/plan` | `plan` | `campaign_plan` job |
| `campaign.update` | Write | `/internal/mcp/campaign/update` | `update` | Name/brief, or `complete`/`cancelled` |
| `campaign.provision` | Write | `/internal/mcp/campaign/provision` | `provision` | Optional `kind` `landing_page` \| `sales_agent` |
| `campaign.launch` | Write | `/internal/mcp/campaign/launch` | `launch` | Sets `client_campaigns.status=live` only when derived readiness is met. **Does not spend ad budget or open paid channels** (no `public.campaigns`, Meta, or spend writes). MEDIUM, no approval. |
| `campaign.request_approval` | Write | `/internal/mcp/campaign/request-approval` | `request_approval` | Queue `console_campaign_launch` |

## Exact bot allowlist (post-#48, not final 45)

Mig 89 **additively** grants the 17 names this phase owns (delete+insert those names only). Gate 9 (mig 73) 23 rows stay with `granted_by = alex-locked:phase-9`.

**Post-#48 Marketing SQL + gateway ceiling: 40 exact rows** (19 reads / 21 writes). This PR does **not** claim the final 45: `brand.*`, `sites.*`, and remaining attribution tools are out of scope.

**Final target after all three PRs** (#48 then #46 then #47): Marketing **45**, Sales Ops **28**. Sibling PRs **must APPEND** (delete+insert only the names they own). They must not `DELETE FROM mcp_bot_permissions WHERE bot_id = 'bot_marketing'` and replace the whole list.

`conversion.*` / `campaign.*` / `content.*` wildcards are forbidden on Marketing. `src/onboarding/marketing-director.ts` is the post-#48 ceiling in `permissions.ts`.

CoS keeps `campaign.*` (covers the new real execution names) and is **denied conversion**. CDM keeps exact `campaign.get` / `campaign.get_status` (now Execution OS). Conversion tools are `bot_marketing` only, including overbroad `conversion.*` credentials. Production must not hold conversion grants. **Bots cannot publish pages.**

### Phase 16 owned grants (17, additive)

Reads: `campaign.get_readiness`, `conversion.list_pages`, `conversion.get_page`, `conversion.get_performance`.

Writes: `conversion.create_page`, `conversion.generate_structure`, `conversion.generate_copy`, `conversion.request_approval`, `conversion.audit_page`, `conversion.revise_page`, `conversion.revert_page`, `campaign.create`, `campaign.update`, `campaign.request_approval`, `campaign.plan`, `campaign.provision`, `campaign.launch`.

### Post-#48 full Marketing list (40)

Reads (19): `campaign.list`, `campaign.get`, `campaign.get_status`, `campaign.get_readiness`, `content.list_ideas`, `content.get_idea`, `content.get_brief`, `content.get_production_status`, `attribution.get_campaign_performance`, `delivery.get_client`, `delivery.get_status`, `delivery.get_client_health`, `workflow.get_pending_approvals`, `workflow.get_activity`, `workflow.list_tasks`, `workflow.get_task`, `conversion.list_pages`, `conversion.get_page`, `conversion.get_performance`.

Writes (21): `content.generate_brief`, `content.request_revision`, `content.request_approval`, `content.create_repurpose_plan`, `workflow.create_task`, `workflow.assign_task`, `workflow.complete_task`, `workflow.create_approval`, `conversion.create_page`, `conversion.generate_structure`, `conversion.generate_copy`, `conversion.request_approval`, `conversion.audit_page`, `conversion.revise_page`, `conversion.revert_page`, `campaign.create`, `campaign.update`, `campaign.request_approval`, `campaign.plan`, `campaign.provision`, `campaign.launch`.

## Database changes

Migration `supabase/migrations/20260916130000_89_mcp_conversion_campaign.sql`:

- Ledgers `mcp_internal.mcp_conversion_requests` and `mcp_internal.mcp_campaign_requests` (forced RLS, privileges revoked including `service_role`).
- `mcp_internal.page_json` / `campaign_json` / `campaign_readiness_rows` (no HTML, no job params/costs).
- `mcp_internal.require_conversion_permission` (hard-codes `bot_marketing`) and `require_campaign_execution_permission` (`bot_has_permission`).
- Dispatchers `mcp_internal.conversion` / `campaign_execution` and public wrappers `mcp_conversion` / `mcp_campaign_execution` (service_role only).
- Additive Marketing grants: delete+insert the 17 Phase 16 names only; assert post-#48 count **40** (not final 45). `assert_cos_prohibitions()` adds Phase 16 conversion wildcard / non-Marketing conversion denies.

Every Bot RPC: `require_active_bot` + `require_bot_client_grant`. No `can_access_client` on these paths. Fixed `pg_catalog,mcp_internal,public` search_path and UTC.

## Tests

Gateway: Marketing 19/21 discovery, conversion-campaign adapter routes, CoS campaign writes visible, conversion hidden from CoS/CDM, isolation before adapter, registry length **97** (catalog after #48 only; #46/#47 may add names and must update their own asserts).

Runtime: HTTP conversion/campaign routes, SQL isolation (no HTML leak, replay, CDM write deny, additive 23+17=40 allowlist, never `can_access_client`).

Validation commands:

```sh
# aa-mcp-gateway
npm ci
npm run check
npm test
npm run build
npm run docs
# agent-runtime
npm ci
npm test
npm test -- src/mcp/isolation-rls.test.ts
npm run typecheck
npm run build
```

## Smoke

```sh
npm run smoke:marketing -- fixtures.json <private-header-file> <staging-or-local-mcp-url>
```

Live fixtures need an execution `campaign_id` (and optional ready artifacts for `provision`/`launch`) plus `ad_campaign_id` for attribution, a page with HTML/findings/revision for polish verbs, and a denied page/campaign. The script refuses the known Production MCP hostname.

## Sec questions

1. Conversion is Marketing-only. Should CoS later get read-only `conversion.list_pages` / `get_page` for rollup, or stay denied?
2. `campaign.launch` is autonomous MEDIUM (derived readiness; sets `client_campaigns.status=live` only — no ad spend / paid channels). Confirm it should not sit behind `workflow.create_approval` / human `record_decision`. If Sec later treats live as a paid-channel open, it must become HIGH+approval.
3. `conversion.request_approval` queues `console_page_review` and does not publish. Is that the right human gate until `sites.*` exists?
4. Rebind of `campaign.list`/`get`/`get_status` from ad-tracker `public.campaigns` to Execution OS — CDM still has get/get_status. Confirm CDM should see plans, not spend trackers.
5. `conversion.get_performance` is operational findings only (no `metrics_daily.page_id`). Acceptable until site analytics exist?

Gate 16 is NOT YET CLOSED.

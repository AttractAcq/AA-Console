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
| `campaign.launch` | Write | `/internal/mcp/campaign/launch` | `launch` | Live only when derived readiness is met |
| `campaign.request_approval` | Write | `/internal/mcp/campaign/request-approval` | `request_approval` | Queue `console_campaign_launch` |

## Exact bot allowlist

Marketing is **40 exact rows** (19 reads / 21 writes): previous Gate 9 set plus ten conversion names and seven campaign execution names (`get_readiness` + six writes). `conversion.*` / `campaign.*` / `content.*` wildcards are forbidden on Marketing. `src/onboarding/marketing-director.ts` is the ceiling in `permissions.ts`.

CoS keeps `campaign.*` (covers the new real execution names). CDM keeps exact `campaign.get` / `campaign.get_status` (now Execution OS). Conversion tools are `bot_marketing` only, including overbroad `conversion.*` credentials. Production must not hold conversion grants.

## Database changes

Migration `supabase/migrations/20260916130000_89_mcp_conversion_campaign.sql`:

- Ledgers `mcp_internal.mcp_conversion_requests` and `mcp_internal.mcp_campaign_requests` (forced RLS, privileges revoked including `service_role`).
- `mcp_internal.page_json` / `campaign_json` / `campaign_readiness_rows` (no HTML, no job params/costs).
- `mcp_internal.require_conversion_permission` (hard-codes `bot_marketing`) and `require_campaign_execution_permission` (`bot_has_permission`).
- Dispatchers `mcp_internal.conversion` / `campaign_execution` and public wrappers `mcp_conversion` / `mcp_campaign_execution` (service_role only).
- Marketing permission replace to 40 exact names; `assert_cos_prohibitions()` adds Phase 16 conversion wildcard / non-Marketing conversion denies.

Every Bot RPC: `require_active_bot` + `require_bot_client_grant`. No `can_access_client` on these paths. Fixed `pg_catalog,mcp_internal,public` search_path and UTC.

## Tests

Gateway: Marketing 19/21 discovery, conversion-campaign adapter routes, CoS campaign writes visible, conversion hidden from CoS/CDM, isolation before adapter, registry length 97.

Runtime: HTTP conversion/campaign routes, SQL isolation (no HTML leak, replay, CDM write deny, 40-row allowlist, never `can_access_client`).

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
2. `campaign.launch` is autonomous MEDIUM (derived readiness, no money move). Confirm it should not sit behind `workflow.create_approval` / human `record_decision`.
3. `conversion.request_approval` queues `console_page_review` and does not publish. Is that the right human gate until `sites.*` exists?
4. Rebind of `campaign.list`/`get`/`get_status` from ad-tracker `public.campaigns` to Execution OS — CDM still has get/get_status. Confirm CDM should see plans, not spend trackers.
5. `conversion.get_performance` is operational findings only (no `metrics_daily.page_id`). Acceptable until site analytics exist?

Gate 16 is NOT YET CLOSED.

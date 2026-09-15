# Phase 13 — Finance Controller MCP

Implemented for review on `cursor/phase-13-finance-controller-b20a`, based on `origin/main`. **Gate 13 = NOT YET CLOSED.** No production migration, deployment, token issuance or connector change has been performed. Phases 14–15 are separate PRs.

## Objective

Activate `bot_finance` for read-only client acquisition economics and revenue attribution. Figures come from the existing Client Economics OS (migration 79 `client_marketing_spend` + cohort lead outcomes), not from AA's own P&L (`finance_entries` / `finance_periods`), client billing, contractor payments, bank, Stripe, Xero or any payment rail.

The window is the **acquisition cohort**, not an event-period revenue ledger: spend recorded in the window, leads acquired in the window, and the outcome of those leads as it stands today. That matches Console Client Economics and is forced by the schema (`client_leads` has no sale/cash dated ledger).

## Explicit non-scope

Bank/Stripe/Xero/payments, token mint, staging/prod migrate, Railway, merge, `pipeline.record_sale`, spend writes, `finance_entries`, `client_billing`, `contract_payments`, `campaigns.total_spend`, `finance_periods` (agency-wide), Meta spend import, event-period revenue, content-level `content_attribution` attention metrics, Engineering, Admin, Sales Agent Factory, and Phases 14–15.

## Existing primitives

- `mcp_internal.mcp_bots`, `mcp_internal.mcp_bot_permissions`, `public.mcp_bot_clients`, existing token registry/resolver.
- Migration 65 seeded `bot_finance` with `economics.*` plus `attribution.get_revenue_attribution` and the eight workflow names. Phase 13 replaces the wildcard with five exact economics names; workflow and attribution rows stay exact.
- Migration 79: `client_marketing_spend`, `lead_stage_rank`, `lead_progress`, `client_economics` / `_by_campaign` / `_by_channel` (human Console; `can_access_client`). Bot RPCs **inline** that maths and never call those functions.
- Workflow task/approval suite already real (migrations 71/72). Finance uses it for tracking only.
- Gateway SQLite receipts, approvals and audit. Reads need no mutation idempotency key.

## Proposed MCP surface

All runtime routes use POST. Every tool is client-scoped. Writes are the existing workflow suite only.

| Tool | Action | Backend route | RPC | Idempotency | Approval | Purpose |
|---|---|---|---|---|---|---|
| `economics.get_client_economics` | Read | `/internal/mcp/economics/get-client-economics` | `mcp_economics_read` | None | None | Cohort totals |
| `economics.get_campaign_economics` | Read | `/internal/mcp/economics/get-campaign-economics` | `mcp_economics_read` | None | None | Cohort by campaign |
| `economics.get_costs` | Read | `/internal/mcp/economics/get-costs` | `mcp_economics_read` | None | None | Spend / CPL / CPA / CAC slice |
| `economics.get_revenue` | Read | `/internal/mcp/economics/get-revenue` | `mcp_economics_read` | None | None | Revenue / cash slice |
| `economics.get_roi` | Read | `/internal/mcp/economics/get-roi` | `mcp_economics_read` | None | None | ROAS / cash ROAS slice |
| `attribution.get_revenue_attribution` | Read | `/internal/mcp/attribution/get-revenue-attribution` | `mcp_attribution_revenue` | None | None | Same campaign buckets; CoS may call via `attribution.*` |
| `workflow.create_task` | Write | existing | `mcp_workflow_task` | Gateway + durable task receipt | None | Tracking work |
| `workflow.assign_task` | Write | existing | `mcp_workflow_task` | Gateway + durable task receipt | None | Scoped coordination |
| `workflow.get_task` | Read | existing | `mcp_workflow_task` | None | None | Task detail |
| `workflow.list_tasks` | Read | existing | `mcp_workflow_task` | None | None | Paginated tasks |
| `workflow.complete_task` | Write | existing | `mcp_workflow_task` | Gateway + durable task receipt | None | Close work |
| `workflow.create_approval` | Write | Gateway WorkflowService | SQLite | Gateway receipt | Returns approval_required | Informational |
| `workflow.get_pending_approvals` | Read | Gateway WorkflowService | SQLite | None | None | Pending requests |
| `workflow.get_activity` | Read | Gateway WorkflowService | SQLite | None | None | Trace activity |

Optional `start_date` / `end_date` (ISO dates). `end_date` is **exclusive**, matching migration 79. Default window is last 30 calendar days through tomorrow (`current_date-29` .. `current_date+1`). Max span 366 days. `get_campaign_economics` and `attribution.get_revenue_attribution` accept optional `campaign_id` and `limit` (1–100, default 25). Missing and foreign campaign IDs both return `campaign_not_found`.

## Exact bot allowlist

The 14 rows above are the complete `bot_finance` discovery/call list: **ten reads and four writes**. `src/onboarding/finance-controller.ts` declares reads, writes, grants, expectedDiscovery and forbidden domains. `permissions.ts` applies the exact ceiling before credential matching and hard-denies the `economics` domain to every other bot. No wildcard grants, aliases or granted stubs. Registry realization is restricted to the five economics names plus `attribution.get_revenue_attribution`.

`attribution.get_revenue_attribution` is also callable by `bot_chief_of_staff` via the existing `attribution.*` grant (wildcard match in SQL `bot_has_permission`). It is not granted to Marketing/Distribution/Security.

## Explicit denies

Every tool outside the list denies for `bot_finance`, including `pipeline.record_sale`, `sales_agents.*`, `content.*`, `admin.*`, `delivery.*`, `campaign.*`, `security.*`, `engineering.*`, payment/banking capabilities and universally `workflow.record_decision`. Cross-client records deny. No implicit Attract Acquisition grant. Responses omit lead PII (no name/email/phone).

## Database changes

Migration `supabase/migrations/20260915180000_85_mcp_finance_controller.sql` adds no tables. It adds:

- `mcp_internal.require_finance_permission` — `bot_finance` plus exact permission row `FOR SHARE`.
- `mcp_internal.cohort_economics` / `cohort_economics_by_campaign` — inlined migration-79 maths.
- `mcp_internal.economics_read` + public `mcp_economics_read`.
- `mcp_internal.attribution_revenue` + public `mcp_attribution_revenue`.

Public wrappers require service role. Internal functions are not executable by PUBLIC/anon/authenticated/service_role. Every public/internal Bot RPC explicitly calls `require_active_bot` and `require_bot_client_grant`. No `can_access_client` on these paths. Fixed `pg_catalog,mcp_internal,public` search_path and UTC.

`assert_cos_prohibitions()` keeps every prior check and adds: `bot_finance` must not hold `economics.*` or payment/bank/Stripe/Xero patterns; `economics%` must not be granted outside `bot_finance`. Permission replace deletes all `bot_finance` rows and inserts the 14 exact names, then asserts count=14 and the wildcard is gone. No client grants, tokens, or other-bot permission changes.

## Backend changes

Gateway: `src/onboarding/finance-controller.ts`, registry, permissions ceiling, AA adapter routes, Finance tests, smoke scripts, package script and generated docs. Runtime: `src/mcp/economics-route.ts` and tests; route registration before the existing attribution/campaign handler so `get-revenue-attribution` is not dispatched to `mcp_campaign_read`. Database: migration 85 only.

Finance does **not** copy Admin's hosted-env denial / dual-mode no-fallback. Gate 13 is read-heavy; env credentials remain valid for non-Admin bots. Flagged as a Sec question.

## Tests

Mandatory coverage includes exact 14-name discovery, overbroad grants, unchanged stubs/other bots, all six new adapter routes, malformed cross-client responses, money-write denial, and smoke runner execution through a local engine.

Runtime/SQL tests cover migration-backed reads, cohort maths, campaign filter, invalid windows, ungranted clients, foreign/missing campaigns, suspended identity, revoked grants, exact permission revocation, wildcard insert denial, other-bot denial, CoS attribution-only access, direct anon/authenticated RPC denial and internal-function denial. Source assertions: `require_active_bot` + `require_bot_client_grant`, never `can_access_client`, `bot_finance` hard-code on economics.

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
# repository
git diff --check
```

## Smoke

```sh
npm run smoke:finance -- fixtures.json <private-header-file> <staging-or-local-mcp-url>
```

The endpoint must explicitly end in /mcp; HTTPS is required except localhost/127.0.0.1. The known Production MCP hostname is rejected. No connector configuration is changed.

Nonsecret fixture JSON fields: `approved_safe_fixtures=true`, `client_id`, `denied_client_id`, `denied_client_name="Attract Acquisition"`, `assignee` (active client-granted bot, normally `bot_finance`). Finance has no `delivery.get_client`, so the gate verifies bot identity via `workflow.get_activity` rather than a client display name.

## Audit

Existing gateway audit: bot, client, tool, request_id, execution_id, authorization and execution outcome. No raw spend ledgers, bearer material or contact PII in logs. SQL security-definer authority comes from the trusted runtime header, never caller JSON.

## Security self-review

Client-scoped SQL predicates, exact permissions and code ceilings, bounded date windows, direct-access revocations and CoS prohibition extensions are positive controls. No new wildcard grants, direct gateway SQL, external effects or secrets were introduced. Human Console `client_economics` is unchanged and still uses `can_access_client`.

## Deployment order

Design note → implementation → migration file/local validation → tests → draft PR → security review → human CLEAR → merge → staging migration → prod migration → Railway gateway/runtime → issue bot token → header-file connector → Gate 13 smoke → operator secret cleanup → ACTIVE.

All merge, deployment, live migration and credential/connector actions remain with Alex via Chief of Staff after approval. This implementation task stops at draft PR.

## Gate 13 PASS criteria

1. Approved exact 14-tool set; cohort semantics; no payment/bank claims.
2. Reviewed migration 85, security review and human CLEAR.
3. Verified bot_finance identity and Harbour-only initial grant (separate issuance); Attract Acquisition denied; other bot grants/connectors unchanged.
4. All baseline/new tests pass; exactly 14 callable/discoverable tools for Finance; unrelated stubs unchanged.
5. Safe Harbour economics reads and workflow fixture proven through the released connector.
6. Cross-client, forbidden-domain, record_decision, record_sale, suspended/revoked and direct SQL/RPC evidence reviewed.
7. Staging migration and existing-bot regression evidence accepted; operator authorizes ACTIVE only after Gate smoke.

## Rollback

Authorized operator disables Finance access/revokes only its new credential and connector, then rolls back gateway/runtime to the reviewed prior release if needed. Do not rotate other bots. Preserve additive permission-row history via a forward migration if needed; do not drop applied migrations. Do not restore credentials solely because code rolled back.

## Sec questions

1. **CoS attribution unstub.** Making `attribution.get_revenue_attribution` real also exposes it on default CoS discovery (`attribution.*`). Confirm that is intended, versus a Finance-only hard-deny like `economics.*`.
2. **Auth posture.** Admin requires DB identity on hosted origins and never falls back in dual mode. Finance is read-heavy client P&L. Should hosted Finance env credentials be refused the same way?
3. **Content-level attribution.** This phase returns campaign buckets from Client Economics OS, not `content_attribution` / `top_content_by_revenue` (those human RPCs still use `can_access_client`, and attention is zero until Meta). Confirm campaign-level cohort attribution is the Gate 13 contract.
4. **Default window.** Defaults match a 30-day exclusive-end Console window (`current_date-29` .. `current_date+1`). Confirm vs campaign performance's inclusive `current_date-29` .. `current_date`.
5. **No spend writes.** Gate 13 excludes all money writes. A later phase that lets Finance append `client_marketing_spend` would need HIGH approval and a separate CLEAR.

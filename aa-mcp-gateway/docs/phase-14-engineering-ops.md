# Phase 14 — Engineering Ops MCP

Implemented for review on `cursor/phase-14-engineering-ops-05ff`, based on `origin/main`. **Gate 14 = NOT YET CLOSED.** No production migration, deployment, token issuance or connector change has been performed. Independent of Phase 13 Finance (PR #33 / mig 85). Phase 15 is a separate PR.

## Objective

Activate `bot_engineering` for read-heavy, client-scoped engineering status and AA-native issue tracking, plus the existing workflow suite. Status figures come from safe projections of `client_pages` (release) and `agent_jobs` (deployment/runtime jobs) — never from Railway writes, GitHub App private keys, secret stores, or unrestricted deploy.

The seeded `engineering.*` wildcard is replaced with **12 exact permission rows**.

## Explicit non-scope

Railway write, secret rotation, unrestricted deploy, `sales_agents.deploy`, GitHub issue/PR writes, token mint, staging/prod migrate, merge, Finance/economics, Admin events, Security findings writes, page HTML/body, job `params` / cost / error text, `github_app_installations` (nullable client_id), and Phase 13 Finance code.

## Existing primitives

- `mcp_internal.mcp_bots`, `mcp_internal.mcp_bot_permissions`, `public.mcp_bot_clients`, existing token registry/resolver.
- Migration 65 seeded `bot_engineering` with `engineering.*` plus eight workflow names. Phase 14 replaces the wildcard with four exact engineering names; workflow rows stay exact.
- `public.client_pages` (migration 06): identity + `published_url` / `status` / `page_type`. Bot reads never return `body`, `brief` or `thumbnail_path`.
- `public.agent_jobs` (migration 03): operational job status. Bot reads never return `params`, `error`, tokens, `cost_usd`, `input_table` or `input_id`. Rows with `client_id` null are excluded (no implied global scope).
- Workflow task/approval suite already real (migrations 71/72). Engineering uses it for tracking only.
- `bot_security_devops` already holds exact `engineering.get_release_status` and `engineering.get_deployment_status` grants (unchanged).

## Proposed MCP surface

All runtime routes use POST. Issue create requires an 8–128-character idempotency key. Status/issue reads need none. Every tool is client-scoped.

| Tool | Action | Backend route | RPC | Idempotency | Approval | Purpose |
|---|---|---|---|---|---|---|
| `engineering.get_issue` | Read | `/internal/mcp/engineering/get-issue` | `mcp_engineering_get_issue` | None | None | Issue detail |
| `engineering.get_release_status` | Read | `/internal/mcp/engineering/get-release-status` | `mcp_engineering_get_release_status` | None | None | Safe `client_pages` projection |
| `engineering.get_deployment_status` | Read | `/internal/mcp/engineering/get-deployment-status` | `mcp_engineering_get_deployment_status` | None | None | Safe `agent_jobs` projection |
| `workflow.get_task` | Read | existing | `mcp_workflow_task` | None | None | Task detail |
| `workflow.list_tasks` | Read | existing | `mcp_workflow_task` | None | None | Paginated tasks |
| `workflow.get_pending_approvals` | Read | Gateway WorkflowService | SQLite | None | None | Pending requests |
| `workflow.get_activity` | Read | Gateway WorkflowService | SQLite | None | None | Trace activity |
| `engineering.create_issue` | Write | `/internal/mcp/engineering/create-issue` | `mcp_engineering_create_issue` | Gateway + durable receipt | None; MEDIUM | AA-native tracking issue |
| `workflow.create_task` | Write | existing | `mcp_workflow_task` | Gateway + durable task receipt | None | Tracking work |
| `workflow.assign_task` | Write | existing | `mcp_workflow_task` | Gateway + durable task receipt | None | Scoped coordination |
| `workflow.complete_task` | Write | existing | `mcp_workflow_task` | Gateway + durable task receipt | None | Close work |
| `workflow.create_approval` | Write | Gateway WorkflowService | SQLite | Gateway receipt | Returns approval_required | Informational |

`get_release_status` / `get_deployment_status` accept optional `limit` (1–100, default 25), UUID `after` keyset pagination, or a single `page_id` / `job_id`. Missing and foreign resource IDs return the same `page_not_found` / `job_not_found` / `issue_not_found`.

## Exact bot allowlist

The 12 rows above are the complete `bot_engineering` discovery/call list: **seven reads and five writes**. `src/onboarding/engineering-ops.ts` declares reads, writes, grants, expectedDiscovery and forbidden domains. `permissions.ts` applies the exact ceiling before credential matching. Issue tools are hard-denied to every other bot, including overbroad `engineering.*` credentials. Status reads remain allowed for `bot_security_devops` via its existing exact grants.

No wildcard grants, aliases, Railway/secret/deploy tools, or granted stubs on Engineering.

## Explicit denies

Every tool outside the list denies for `bot_engineering`, including `sales_agents.deploy`, `pipeline.record_sale`, `economics.*`, `security.*`, `admin.*`, `delivery.*`, `content.*`, payment/banking capabilities and universally `workflow.record_decision`. Cross-client records deny. No implicit Attract Acquisition grant. Responses omit page HTML, job params, costs and error text.

## Database changes

Migration `supabase/migrations/20260915200000_86_mcp_engineering_ops.sql` adds:

- `mcp_internal.mcp_engineering_issues` — client-scoped tracking issues (`open` on create).
- `mcp_internal.mcp_engineering_requests` — durable receipts for `engineering.create_issue`.
- `mcp_internal.require_engineering_permission` — `require_active_bot` + `require_bot_client_grant` + exact permission row `FOR SHARE`. Issue tools hard-code `bot_engineering`; status tools allow `bot_engineering` or `bot_security_devops`.
- Public wrappers `mcp_engineering_*` requiring service role.

Public wrappers require service role. Internal functions are not executable by PUBLIC/anon/authenticated/service_role. Direct table privileges are revoked from those roles, including service_role. Every public/internal Bot RPC explicitly calls `require_active_bot` and `require_bot_client_grant`. No `can_access_client` on these paths. Fixed `pg_catalog,mcp_internal,public` search_path and UTC.

`assert_cos_prohibitions()` keeps every prior check and adds: `engineering.*` is forbidden; issue tools must not be granted outside `bot_engineering`; `bot_engineering` must not hold railway/secret/infra/deploy/finance/economics patterns. Permission replace deletes all `bot_engineering` rows and inserts the 12 exact names, then asserts count=12 and the wildcard is gone. No client grants, tokens, or other-bot permission changes.

## Backend changes

Gateway: `src/onboarding/engineering-ops.ts`, registry, permissions ceiling, AA adapter routes, Engineering tests, smoke scripts, package script and generated docs. Runtime: `src/mcp/engineering-route.ts` and tests; route registration in `server.ts`. Database: migration 86 only.

Engineering does **not** copy Admin's hosted-env denial / dual-mode no-fallback. Gate 14 is read-heavy; env credentials remain valid for non-Admin bots. Flagged as a Sec question.

## Tests

Mandatory coverage includes exact 12-name discovery, overbroad grants, unchanged stubs/other bots, all four Engineering adapter routes, nested cross-client/secret-field rejection, backend reauthorization on replay, and smoke runner execution through a local engine.

Runtime/SQL tests cover migration-backed create/get/status, secret omission, unscoped job exclusion, invalid/ungranted clients, foreign/missing IDs, suspended identity, revoked grants, exact permission revocation, wildcard insert denial, other-bot denial, Security status-only access, direct anon/authenticated RPC denial and internal-function/table denial. Source assertions: `require_active_bot` + `require_bot_client_grant`, never `can_access_client`.

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
npm run smoke:engineering -- fixtures.json <private-header-file> <staging-or-local-mcp-url>
```

The endpoint must explicitly end in /mcp; HTTPS is required except localhost/127.0.0.1. The known Production MCP hostname is rejected. No connector configuration is changed.

Nonsecret fixture JSON fields: `approved_safe_fixtures=true`, `client_id`, `denied_client_id`, `denied_client_name="Attract Acquisition"`, `assignee` (active client-granted bot, normally `bot_engineering`). Engineering has no `delivery.get_client`, so the gate verifies bot identity via `workflow.get_activity`.

## Audit

Existing gateway audit: bot, client, tool, request_id, execution_id, issue/page/job resource, authorization and execution outcome. No page HTML, job params, bearer material or contact PII in logs. SQL security-definer authority comes from the trusted runtime header, never caller JSON.

## Deployment order

Design note → implementation → migration file/local validation → tests → draft PR → security review → human CLEAR → merge → staging migration → prod migration → Railway gateway/runtime → issue bot token → header-file connector → Gate 14 smoke → operator secret cleanup → ACTIVE.

All merge, deployment, live migration and credential/connector actions remain with Alex via Chief of Staff after approval. This implementation task stops at draft PR.

## Gate 14 PASS criteria

1. Approved exact 12-tool set; status projections; no Railway/secret/unrestricted-deploy claims.
2. Reviewed migration 86, security review and human CLEAR.
3. Verified bot_engineering identity and Harbour-only initial grant (separate issuance); Attract Acquisition denied; other bot grants/connectors unchanged except Security's pre-existing status grants becoming real.
4. All baseline/new tests pass; exactly 12 callable/discoverable tools for Engineering; unrelated stubs unchanged.
5. Safe Harbour issue/status/workflow fixture proven through the released connector.
6. Cross-client, forbidden-domain, record_decision, sales_agents.deploy, suspended/revoked and direct SQL/RPC evidence reviewed.
7. Staging migration and existing-bot regression evidence accepted; operator authorizes ACTIVE only after Gate smoke.

## Rollback

Authorized operator disables Engineering access/revokes only its new credential and connector, then rolls back gateway/runtime to the reviewed prior release if needed. Do not rotate other bots. Preserve additive issue/receipt tables via a forward migration if needed; do not drop applied migrations. Do not restore credentials solely because code rolled back.

## Sec questions

1. **Security status unstub.** Making `engineering.get_release_status` and `engineering.get_deployment_status` real also exposes them on default `bot_security_devops` discovery (existing exact grants). Confirm that is intended for Gate 14, versus an Engineering-only hard-deny until Phase 15.
2. **Auth posture.** Admin requires DB identity on hosted origins and never falls back in dual mode. Engineering is read-heavy status plus issue tracking. Should hosted Engineering env credentials be refused the same way?
3. **Status projections.** Gate 14 projects `client_pages` / `agent_jobs` rather than `client_site_repositories` / sales-agent deployments / Railway, because those tables are not in the isolation fixture and include platform identifiers. Confirm this is the Gate 14 contract, versus waiting on site-deployment isolation.
4. **create_issue is MEDIUM, no gateway reviewer gate.** Same posture as Admin events and workflow tasks. Confirm vs requiring HIGH/approval for any engineering write.
5. **No Railway/secret/deploy writes.** Gate 14 excludes them. A later phase that lets Engineering trigger Railway, rotate secrets, or call `sales_agents.deploy` would need CRITICAL/HIGH approval and a separate CLEAR.

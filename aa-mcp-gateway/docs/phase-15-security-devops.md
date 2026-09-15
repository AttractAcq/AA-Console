# Phase 15 — Security & DevOps MCP

Implemented for review on `cursor/phase-15-security-devops-79cc`, based on latest `origin/main` after Phase 14 Engineering (PR #36 / mig 86). **Gate 15 = NOT YET CLOSED.** No production migration, deployment, token issuance or connector change has been performed. Independent of Phases 13–14 runtime except shared engineering status reads.

## Objective

Activate `bot_security_devops` for read-heavy, **client-scoped** security status, AA-native finding/incident tracking, plus the existing workflow suite and the two Engineering status reads already granted in migration 65.

This is the highest-risk Bot identity. Gate 15 is deliberately narrow: no secret exfiltration, no unattended destroy, no global/unscoped client access, no Railway write, no secret rotation, no unrestricted deploy.

The seeded `security.*` wildcard is replaced with **14 exact permission rows**.

## Explicit non-scope

Secret stores / env dumps / token material, Railway write, secret rotation, unrestricted deploy, `sales_agents.deploy`, unattended destroy/drop/wipe, agency-global (null-client) views, GitHub App private keys, page HTML/body, job `params` / cost / error text, token mint, staging/prod migrate, merge, Finance/economics, Admin events, Engineering issue create/get, and any tool that returns credentials.

## Existing primitives

- `mcp_internal.mcp_bots`, `mcp_internal.mcp_bot_permissions`, `public.mcp_bot_clients`, existing token registry/resolver.
- Migration 65 seeded `bot_security_devops` with `security.*`, exact `engineering.get_release_status` / `engineering.get_deployment_status`, and eight workflow names. Phase 15 replaces the wildcard with four exact security names; engineering status and workflow rows stay exact.
- Phase 14 already made the two engineering status reads real (safe `client_pages` / `agent_jobs` projections). Security keeps those grants; it does **not** receive issue tools.
- `public.client_pages` / `public.agent_jobs`: system status uses **counts by status** only. Bot reads never return `body`, `brief`, `params`, `error`, tokens, `cost_usd`, `input_table` or `input_id`. Rows with `client_id` null are excluded (no implied global scope).
- Workflow task/approval suite already real (migrations 71/72). Security uses it for tracking only.

## Proposed MCP surface

All runtime routes use POST. Finding create requires an 8–128-character idempotency key. Reads need none. Every tool is client-scoped.

| Tool | Action | Backend route | RPC | Idempotency | Approval | Purpose |
|---|---|---|---|---|---|---|
| `security.get_system_status` | Read | `/internal/mcp/security/get-system-status` | `mcp_security_get_system_status` | None | None | Client-scoped job/page/finding counts |
| `security.get_open_findings` | Read | `/internal/mcp/security/get-open-findings` | `mcp_security_get_open_findings` | None | None | Open finding list |
| `security.get_incident_status` | Read | `/internal/mcp/security/get-incident-status` | `mcp_security_get_incident_status` | None | None | Incident list/status |
| `engineering.get_release_status` | Read | existing Phase 14 | `mcp_engineering_get_release_status` | None | None | Safe `client_pages` projection |
| `engineering.get_deployment_status` | Read | existing Phase 14 | `mcp_engineering_get_deployment_status` | None | None | Safe `agent_jobs` projection |
| `workflow.get_task` | Read | existing | `mcp_workflow_task` | None | None | Task detail |
| `workflow.list_tasks` | Read | existing | `mcp_workflow_task` | None | None | Paginated tasks |
| `workflow.get_pending_approvals` | Read | Gateway WorkflowService | SQLite | None | None | Pending requests |
| `workflow.get_activity` | Read | Gateway WorkflowService | SQLite | None | None | Trace activity |
| `security.create_finding` | Write | `/internal/mcp/security/create-finding` | `mcp_security_create_finding` | Gateway + durable receipt | None; MEDIUM | AA-native finding or incident |
| `workflow.create_task` | Write | existing | `mcp_workflow_task` | Gateway + durable task receipt | None | Tracking work |
| `workflow.assign_task` | Write | existing | `mcp_workflow_task` | Gateway + durable task receipt | None | Scoped coordination |
| `workflow.complete_task` | Write | existing | `mcp_workflow_task` | Gateway + durable task receipt | None | Close work |
| `workflow.create_approval` | Write | Gateway WorkflowService | SQLite | Gateway receipt | Returns approval_required | Informational |

`get_open_findings` / `get_incident_status` accept optional `limit` (1–100, default 25), UUID `after` keyset pagination, or a single `finding_id` / `incident_id`. Missing, foreign, and wrong-kind IDs return the same `finding_not_found` / `incident_not_found`. `create_finding` accepts `kind` `finding` (default) or `incident`, and required `severity` `low|medium|high|critical`. Title 1–200; notes nullable ≤2000. No evidence dump, token, env, or secret fields exist on the contract.

## Exact bot allowlist

The 14 rows above are the complete `bot_security_devops` discovery/call list: **nine reads and five writes**. `src/onboarding/security-devops.ts` declares reads, writes, grants, expectedDiscovery and forbidden domains. `permissions.ts` applies the exact ceiling before credential matching. All `security.*` tools are hard-denied to every other bot, including overbroad `security.*` credentials. Engineering status reads remain shared with `bot_engineering` via existing exact grants.

No wildcard grants, aliases, Railway/secret/destroy/deploy tools, or granted stubs on Security.

## Explicit denies

Every tool outside the list denies for `bot_security_devops`, including `sales_agents.deploy`, `pipeline.record_sale`, `economics.*`, `admin.*`, `delivery.*`, `content.*`, `engineering.create_issue`, `engineering.get_issue`, payment/banking capabilities and universally `workflow.record_decision`. Cross-client records deny. No implicit Attract Acquisition grant. Responses omit page HTML, job params, costs, error text, tokens and env.

## Database changes

Migration `supabase/migrations/20260915220000_87_mcp_security_devops.sql` adds:

- `mcp_internal.mcp_security_findings` — client-scoped findings/incidents (`open` on create).
- `mcp_internal.mcp_security_requests` — durable receipts for `security.create_finding`.
- `mcp_internal.require_security_permission` — `require_active_bot` + `require_bot_client_grant` + exact permission row `FOR SHARE`. Security tools hard-code `bot_security_devops`.
- Public wrappers `mcp_security_*` requiring service role.

Public wrappers require service role. Internal functions are not executable by PUBLIC/anon/authenticated/service_role. Direct table privileges are revoked from those roles, including service_role. Every public/internal Bot RPC explicitly calls `require_active_bot` and `require_bot_client_grant`. No `can_access_client` on these paths. Fixed `pg_catalog,mcp_internal,public` search_path and UTC.

`assert_cos_prohibitions()` keeps every prior check (including Gate 13–14) and adds: `security.*` is forbidden; security tools must not be granted outside `bot_security_devops`; `bot_security_devops` must not hold railway/secret/infra/destroy/rotate/deploy/global patterns. Existing finance prohibition on this bot stays. Permission replace deletes all `bot_security_devops` rows and inserts the 14 exact names, then asserts count=14 and the wildcard is gone. No client grants, tokens, or other-bot permission changes.

## Backend changes

Gateway: `src/onboarding/security-devops.ts`, registry, permissions ceiling, AA adapter routes, Security tests, smoke scripts, package script and generated docs. Runtime: `src/mcp/security-route.ts` and tests; route registration in `server.ts`. Database: migration 87 only.

Security matches Admin/Engineering for **identity refresh**: db/dual auth skips the token cache for `bot_security_devops`, so a revoked token is 401 on the next request and a removed client grant is re-checked on write replay (`client_forbidden`, not a cached success). Gateway receipts still bind the execution key; they do not short-circuit the AA call.

Security does **not** copy Admin's hosted-env denial / dual-mode no-fallback. Gate 15 is read-heavy plus one tracking write; env credentials remain valid for non-Admin bots when AA is unavailable. Flagged as a Sec question.

## Tests

Mandatory coverage includes exact 14-name discovery, overbroad grants, unchanged stubs/other bots, all four Security adapter routes plus inherited Engineering status routes, nested cross-client/secret-field rejection, backend reauthorization on replay, and smoke runner execution through a local engine.

Runtime/SQL tests cover migration-backed create/list/status, secret omission, unscoped job exclusion, invalid/ungranted clients, foreign/missing/wrong-kind IDs, suspended identity, revoked grants, exact permission revocation, wildcard insert denial, destroy/secret grant denial, other-bot denial, Engineering status-only (no security writes), direct anon/authenticated RPC denial and internal-function/table denial. Source assertions: `require_active_bot` + `require_bot_client_grant`, never `can_access_client`.

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
npm run smoke:security -- fixtures.json <private-header-file> <staging-or-local-mcp-url>
```

The endpoint must explicitly end in /mcp; HTTPS is required except localhost/127.0.0.1. The known Production MCP hostname is rejected. No connector configuration is changed.

Nonsecret fixture JSON fields: `approved_safe_fixtures=true`, `client_id`, `denied_client_id`, `denied_client_name="Attract Acquisition"`, `assignee` (active client-granted bot, normally `bot_security_devops`). Security has no `delivery.get_client`, so the gate verifies bot identity via `workflow.get_activity`.

## Audit

Existing gateway audit: bot, client, tool, request_id, execution_id, finding/incident resource, authorization and execution outcome. No page HTML, job params, bearer material, env, or contact PII in logs. SQL security-definer authority comes from the trusted runtime header, never caller JSON.

## Deployment order

Design note → implementation → migration file/local validation → tests → draft PR → security review → human CLEAR → merge → staging migration → prod migration → Railway gateway/runtime → issue bot token → header-file connector → Gate 15 smoke → operator secret cleanup → ACTIVE.

All merge, deployment, live migration and credential/connector actions remain with Alex via Chief of Staff after approval. This implementation task stops at draft PR.

## Gate 15 PASS criteria

1. Approved exact 14-tool set; client-scoped findings/status; no secret/destroy/global/Railway claims.
2. Reviewed migration 87, security review and human CLEAR.
3. Verified bot_security_devops identity and Harbour-only initial grant (separate issuance); Attract Acquisition denied; other bot grants/connectors unchanged except Engineering's pre-existing status grants remaining real.
4. All baseline/new tests pass; exactly 14 callable/discoverable tools for Security; unrelated stubs unchanged.
5. Safe Harbour finding/status/workflow fixture proven through the released connector.
6. Cross-client, forbidden-domain, record_decision, sales_agents.deploy, secret-field, suspended/revoked and direct SQL/RPC evidence reviewed.
7. Staging migration and existing-bot regression evidence accepted; operator authorizes ACTIVE only after Gate smoke.

## Rollback

Authorized operator disables Security access/revokes only its new credential and connector, then rolls back gateway/runtime to the reviewed prior release if needed. Do not rotate other bots. Preserve additive finding/receipt tables via a forward migration if needed; do not drop applied migrations. Do not restore credentials solely because code rolled back.

## Sec questions

1. **Hosted-env denial.** Admin requires DB identity on hosted origins and never falls back in dual mode. Security is the highest-risk Bot but Gate 15 is read-heavy tracking. Should hosted Security env credentials be refused the same way as Admin?
2. **System status projection.** Gate 15 returns job/page **counts by status** plus open finding/incident counts, not row-level job/page lists (those remain on Engineering status tools). Confirm counts-only is the Gate 15 contract versus exposing the same page/job rows Security can already read via `engineering.get_*_status`.
3. **create_finding is MEDIUM, no gateway reviewer gate.** Same posture as Engineering issues and Admin events. Confirm vs requiring HIGH/approval for incident-kind writes (`kind=incident`).
4. **Incident vs finding.** One table, `kind` discriminator, so Gate 15 does not add a separate create-incident tool. Confirm vs splitting incidents into their own table/RPC before CLEAR.
5. **No destroy / secret / Railway / global tools.** Gate 15 excludes them. A later phase that lets Security rotate secrets, dump env, destroy infra, or read agency-global (null-client) rows would need CRITICAL/HIGH approval and a separate CLEAR.

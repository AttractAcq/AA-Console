# Phase 12 — Admin & Calendar

Implemented for review on `phase-12-admin-calendar`, based on `origin/main` at `d6fc90b84e7c8fd74c30d4be77e72f5f915c8943`. **Gate 12 = NOT YET CLOSED.** No production migration, deployment, token issuance or connector change has been performed.

## Objective

Activate `bot_admin` for AA-native scheduling, meetings, reminders, administrative workflow and client/internal coordination. Events are client-scoped records. A reminder is retrieved by polling scheduled events with `due_before`; it is not a delivered notification. Internal coordination is work for an explicitly granted client, never an implicit agency-wide grant.

The operator approved the exact 15-tool surface and migration 78. The stale/dirty original checkout remains untouched. Implementation uses an isolated worktree at `/private/tmp/AA-Console-phase12` created directly from the verified pinned main. No Factory code or migration 77 is used.

## Explicit non-scope

Google Calendar OAuth, Gmail OAuth, external email/invitations/notifications, Finance, banking, payments, Security, deployment, Engineering writes, Sales Agent Factory, Sales pipeline/agent writes, Meta/WhatsApp, Production decision tools, Distribution publishing/scheduling, contact editing, secret administration, recurrence, attendee/provider/conference data and global/null-client calendars.

A later Google Calendar integration may map provider records to these AA-native events through a separately reviewed adapter. It must preserve AA client authorization, event versioning and mutation receipts; external side effects require their own idempotency/approval contract. No external integration state is prebuilt here.

## Existing primitives

Verified all 11 approved existing names against the original **85-tool registry**, before editing: three delivery reads plus eight workflow tools, all real. The new registry has **89 contracts**. Admin discovery is exactly **15**; all unrelated stubs remain hidden by default.

Migration 65 seeds `bot_admin` (display name `Admin`) with ten permissions: `delivery.list_clients`, `delivery.get_client` and the eight workflow names below. Phase 12 adds `delivery.get_status` and four new event tools. Repository seeds do not establish live identity/token/grant state.

Reusable objects:

- `mcp_internal.mcp_bots`, `mcp_internal.mcp_bot_permissions`, `public.mcp_bot_clients` and existing token registry/resolver.
- Safe `public.clients` projections through `mcp_delivery_list_clients` and `mcp_delivery_read`. Delivery status also projects incomplete `client_onboarding_steps` and existing operational work without compensation or credential metadata.
- `mcp_internal.mcp_delivery_tasks`, `mcp_internal.mcp_task_mutations`, `public.mcp_workflow_task` and its internal implementation from migrations 71/72. Tracking assignments do not create paid work or execute an agent.
- Gateway SQLite receipts, approvals and audit; `WorkflowService` handles own-bot approval/activity reads. `workflow.create_approval` is informational and never authorizes arbitrary downstream action.
- `public.team_members` and `client_assignments` support safe workflow assignment checks, without exposing compensation.

Existing `client_contact_details`, account onboarding/contact/integration UI, human `start_onboarding`, `admin_create_team_member` and `admin_store_integration_credential` are not Bot APIs. No contacts tool exists. Human helpers using `can_access_client` are not reused on Bot RPC paths.

The Console Calendar/Add Event UI and `scheduled_posts`/`schedule_asset` represent Distribution assets, not meetings. No suitable meeting/reminder table exists; a separate internal event table avoids granting Admin Distribution writes. No Console UI changes are required for this MCP gate. Metrics ingestion cron is not a reminder service.

## Proposed MCP surface

The approved surface is implemented as follows. All runtime routes use POST. Reads need no mutation idempotency key; all writes require an 8–128-character key. Every tool is client-scoped, except list_clients which returns only the credential's granted set.

| Tool | Action | Backend route / implementation | RPC / persistence | Idempotency | Approval | Purpose |
|---|---|---|---|---|---|---|
| `delivery.list_clients` | Read | `/internal/mcp/delivery/list-clients` | `mcp_delivery_list_clients` / clients + grants | None | None | Granted clients only |
| `delivery.get_client` | Read | `/internal/mcp/delivery/get-client` | `mcp_delivery_read` / clients | None | None | Safe identity |
| `delivery.get_status` | Read | `/internal/mcp/delivery/get-status` | `mcp_delivery_read` / operational projection | None | None | Onboarding/work context |
| `workflow.create_task` | Write | `/internal/mcp/workflow/create-task` | `mcp_workflow_task` / task ledger | Gateway + durable task receipt | None | Tracking work |
| `workflow.assign_task` | Write | `/internal/mcp/workflow/assign-task` | `mcp_workflow_task` / task ledger | Gateway + durable task receipt | None | Scoped coordination |
| `workflow.get_task` | Read | `/internal/mcp/workflow/get-task` | `mcp_workflow_task` / tasks | None | None | Task detail |
| `workflow.list_tasks` | Read | `/internal/mcp/workflow/list-tasks` | `mcp_workflow_task` / tasks | None | None | Paginated tasks |
| `workflow.complete_task` | Write | `/internal/mcp/workflow/complete-task` | `mcp_workflow_task` / task ledger | Gateway + durable task receipt | None | Close work |
| `workflow.create_approval` | Write | Gateway ActionEngine/WorkflowService | SQLite approvals/receipts | Gateway receipt | Returns approval_required; human decision only | Informational escalation |
| `workflow.get_pending_approvals` | Read | Gateway WorkflowService | SQLite approvals, own bot/client | None | None | Pending requests |
| `workflow.get_activity` | Read | Gateway WorkflowService | SQLite audit, own bot/client | None | None | Trace activity |
| `admin.list_events` | Read | `/internal/mcp/admin/list-events` | `mcp_admin_list_events` / events | None | None | Scoped pagination, status/due filtering |
| `admin.get_event` | Read | `/internal/mcp/admin/get-event` | `mcp_admin_get_event` / events | None | None | Event detail |
| `admin.create_event` | Write | `/internal/mcp/admin/create-event` | `mcp_admin_create_event` / events + requests | Gateway + durable Admin receipt | None; MEDIUM risk | Create internal record |
| `admin.update_event` | Write | `/internal/mcp/admin/update-event` | `mcp_admin_update_event` / events + requests | Gateway + durable Admin receipt | None; MEDIUM risk | Reschedule/complete/cancel |

New names are justified because existing workflow tasks do not carry structured meeting/reminder timestamps. No broader Admin CRUD or arbitrary payload tool is introduced.

## Exact bot allowlist

The 15 rows above are the complete discovery/call list: **nine reads and six writes**. `src/onboarding/admin-calendar.ts` declares reads, writes, grants, expectedDiscovery and forbidden domains. `permissions.ts` applies the exact ceiling before credential permission matching. No wildcard grants, aliases or granted stubs. Admin tools are hard-denied to every other bot, even with overbroad credentials. Registry realization is restricted to the four explicit new names.

## Explicit denies

Every tool outside the list denies, including `economics.*`, `security.*`, `engineering.*`, all pipeline and sales_agents tools, `content.select_idea`, `content.approve_asset`, `content.queue_distribution`, `content.record_publication`, deployment/payment/banking capabilities and universally `workflow.record_decision`. Cross-client records and list cursors deny. No implicit Attract Acquisition/internal-client grant. Task/approval text cannot invoke commands or confer forbidden permissions.

## Database changes

Migration adds only two internal tables:

- `mcp_internal.mcp_admin_events`: id, non-null client_id FK, title (1–200 trimmed characters), nullable notes (max 2,000), event_type CHECK **meeting/reminder/admin**, starts_at, nullable ends_at, status CHECK **scheduled/completed/cancelled**, created_by_bot, updated_by_bot, version, created_at, updated_at. Both bot attribution fields must be bot_admin. Timestamps must be finite; end must follow start; meeting requires end. Client/id and scheduled due-time indexes support reads.
- `mcp_internal.mcp_admin_requests`: bot_id/execution_id primary key, request_id, exact tool CHECK, client_id, event_id, canonical payload, saved result and created_at. Request/execution identifiers use the established validation. Advisory transaction locking serializes identical executions; receipt and mutation commit atomically.

Public wrappers: `mcp_admin_list_events`, `mcp_admin_get_event`, `mcp_admin_create_event`, `mcp_admin_update_event`. Internal functions have corresponding `admin_*` names; `require_admin_permission` supplies the exact Admin permission check. Every public/internal event RPC explicitly calls `require_active_bot` and `require_bot_client_grant`. Public wrappers also require service role. No `can_access_client` on these paths.

New tables have RLS enabled and forced. PUBLIC/anon/authenticated/service_role have no direct table privileges. Only service_role may execute the four public wrappers; internal functions/helper are not directly executable by those roles. Fixed `pg_catalog,mcp_internal,public` search_path and UTC serialization; all object references are qualified. Guards/permission rows are checked before receipt replay, with identity/permission/grant locks held during execution. Missing and foreign event IDs both return `event_not_found` without mutation.

Update replaces only explicit editable fields (title, notes, starts_at, ends_at, status) and requires expected_version. Client, event_type and creator are immutable. Scheduled events can remain scheduled or become completed/cancelled; terminal records cannot reopen. Retry with the same execution/payload returns the saved result even after subsequent edits; changed client/tool/payload conflicts. New execution with a stale version conflicts. No deletions or automatic execution.

The existing migration-72 workflow function is replaced with its existing behavior plus an Admin-only assignee check **before replay**: target bot must be active and granted that client; target member must be active with an unended client assignment. Other bots retain existing behavior. No event-to-actor/task references were added, removing a second cross-client reference surface.

## Implementation decisions versus the initial design

The locked implementation prompt supersedes the earlier broader schema proposal: no IANA timezone field/engine, separate reminder_at, task_id link or attendee/provider abstractions. Event types are exactly meeting/reminder/admin. Reminders use starts_at. List filters are status and due_before, with UUID keyset pagination and scoped cursor validation. Combine status=scheduled with due_before to retrieve due work. Notes max 2,000 keeps requests small; reads omit notes from list results and retain them in detail. Runtime allows a bounded 16 KiB body for Admin only, supporting escaped/Unicode notes without widening legacy routes. Gateway bounds Admin responses at 256 KiB and validates nested ownership, IDs, shape and attribution.

Writes use complete editable-field replacement rather than ambiguous nullable patches. Null notes/ends_at are explicit. The HTTP contract requires ISO instants with an offset and seconds (up to millisecond fractional precision in the runtime). It does not resolve local timezone names. PGlite simultaneous submissions exercise replay/optimistic conflicts but do not substitute for multi-session Postgres/staging evidence.

## Migration

`supabase/migrations/20260910120000_78_mcp_admin_calendar.sql`.

Latest base migration is `20260910000000_76_mcp_sales_ops.sql`. Deferred PR #16 contains `20260910100000_77_mcp_sales_agent_factory.sql`, absent from main and untouched. Migration 78 uses a later unique timestamp, with no dependency on 77. It replaces only Admin permission rows; it does not insert client grants, issue tokens, activate identities or change other bot permissions.

Existing history has two files with timestamp `20260909020000` and number 72 (`campaign_execution` and `mcp_cos_orchestration`). That pre-existing release-history concern remains unchanged; Alex/CoS must reconcile actual applied versions before staging/prod migrations. Local PGlite fixtures load named migrations explicitly and cannot prove Supabase CLI history is reconciled.

## Backend changes

Gateway: new `src/onboarding/admin-calendar.ts`, registry, permissions, AA adapter, auth identity, policy engine, Admin tests, smoke scripts, package script and generated docs. Runtime: new `src/mcp/admin-route.ts` and tests; route registration in server.ts; normalized errors in http.ts; optional per-route body limit in content-route.ts; expanded isolation tests. Database: migration 78 only. No direct gateway → Supabase path and no new audit store.

Admin auth in DB/dual mode resolves current identity on every HTTP request instead of using positive cached grants. Dual mode preserves identity/permission mismatch rejection and never falls back to an Admin env identity on resolver outage. Hosted Admin env requests are refused at authentication without preventing other bots from starting; loopback HTTP origins may use local env credentials for isolated tests. Auth is static Bearer through stdio/mcp-remote/private header file, never OAuth.

Admin event and task mutation replays go back to guarded AA RPCs instead of returning cached gateway success. Other bots retain their receipt behavior. Own approval/activity reads remain behind fresh Admin HTTP authentication. Transport authorization and the DB operation are separate boundaries: revocation committed before a new request denies; requests already authorized/in progress can finish under the normal transaction boundary.

## Tests

Mandatory coverage includes exact 15-name discovery (not count alone), overbroad grants, unchanged stubs/other bots, all four Admin adapter routes, malformed and nested cross-client responses, backend reauthorization on replay, changed-payload conflicts, audit correlation, immediate revoked credential 401, fail-closed dual auth, and smoke runner execution through local MCP.

Runtime/SQL tests cover real migration-backed list/get/create/update, meeting/reminder/admin types, status/temporal/length/unknown-field validation, pagination/due filtering, invalid/ungranted clients, foreign/missing event/cursor equality, suspended identity, revoked grants and token resolver, exact permission revocation including wildcard attempts, other-bot denial, direct anon/authenticated RPC denial and direct table denial including service_role. RLS/FORCE RLS and function guards are asserted. Create/update replay, concurrent submissions, optimistic version conflict and timezone-independent receipt serialization are covered. Admin bot/member task assignment denial is tested before mutation and replay.

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

The pre-change baseline was gateway 97 and runtime MCP 171 (isolation 57). Final counts and review evidence are recorded in the PR. The runtime command above runs the entire runtime suite, not just MCP. Full gateway/runtime suites must be rerun after generated documentation changes. No tests use production data. Loopback permission is required for mock HTTP tests; initial sandbox EPERM failures are environmental.

## Smoke

```sh
npm run smoke:admin -- fixtures.json <private-header-file> <staging-or-local-mcp-url>
```

The endpoint must explicitly end in /mcp; HTTPS is required except localhost/127.0.0.1. The known Production MCP hostname is rejected. The transport checks private header permissions but does not read or print its contents; only mcp-remote consumes it, using the established --header-file pattern with stderr suppressed. Operator must record/validate the installed compatible bridge version before staging. No connector configuration is changed by this script.

Nonsecret fixture JSON fields: approved_safe_fixtures=true, client_id, allowed_client_name="Harbour Dental", denied_client_id, denied_client_name="Attract Acquisition", denied_event_id, assignee (active client-granted bot, normally bot_admin). IDs must be actual staging/local fixtures; deny if missing/unsafe. The allowed client's returned name and own-bot audit identity are verified before writes. Denied fixture ownership is operator-provided; it is never mutated.

Smoke checks invalid credential 401, exact tools/list=15, client/workflow reads, event list, reversible fixture create/replay/same event, get, update/replay, cross-client get/update denials, forbidden calls and record_decision denial. It also creates/assigns/completes a tracking task. Its finally path cancels its new event and completes its task. Interrupted/indeterminate runs must be reconciled by fixture IDs/titles and audit evidence before retrying; no broad delete or credential/grant manipulation. No live staging or Production smoke has been run. The reusable gate runner is tested through local MCP HTTP; the private-header/stdio bridge still needs release-stage evidence.

## Audit

Uses the existing gateway audit and durable receipts: bot, client, tool, request_id, execution_id, event/task resource, authorization and execution outcome. Create responses contribute their new event ID to existing audit metadata. DB events carry creator/updater bot; receipts link request/execution to event and canonical mutation/result. Replays correlate to the original execution while the current request gets its own audit entry. No raw body/notes, bearer/header material or contact PII is added to logs. SQL security-definer authority comes from the trusted runtime header, never caller JSON.

## Security self-review

Reviewed security, correctness, performance and maintainability using the engineering code-review checklist. No unresolved P0/P1 found. Client-scoped SQL predicates, exact permissions and code ceilings, bounded schemas, direct-access revocations and current-authorization replay checks are positive controls verified by tests. No new wildcard grants, direct gateway SQL, external effects or secrets were introduced.

P2 / existing dependency finding: npm audit reports two moderate entries (`vitest` and `@vitest/mocker`) for the same [redirect-mock path traversal advisory](https://github.com/advisories/GHSA-82fw-gwwq-j7x9). They are development dependencies; the advertised fix is a Vitest major upgrade. Dependencies were not changed in this phase. Keep test servers local and track a separate toolchain upgrade. Existing duplicate migration version and pending staging/stdio smoke are release concerns, not claims of completed security acceptance.

Fixed during review: Admin dual-auth mismatch preservation, fixed UTC receipt serialization, safe nested adapter projections, Admin task assignee scope on replay, and bounded Unicode-capable Admin request bodies. Other bot behavior and legacy route body limits remain unchanged. Audit/query data is bounded; no recurrence scheduler, N+1 provider calls or parallel audit system was added.

## Deployment order

Design note → implementation → migration file/local validation → tests → draft PR → security review → human CLEAR → merge → staging migration → prod migration → Railway gateway/runtime → issue bot token → header-file connector → Gate 12 smoke → operator secret cleanup → ACTIVE.

All merge, deployment, live migration and credential/connector actions remain with Alex via Chief of Staff after approval. Temporary secret cleanup means newly created operator-approved temporary material only; persistent connector header files must remain. This implementation task stops at draft PR.

## Gate 12 PASS criteria

1. Approved exact 15-tool set and AA-native/polled reminder semantics; no external delivery claims.
2. Reviewed migration 78, security review and human CLEAR; migration history reconciled and release order evidenced.
3. Verified bot_admin identity and Harbour-only initial grant; Attract Acquisition denied; other bot grants/connectors unchanged.
4. All baseline/new tests pass, no skipped security cases; exactly 15 callable/discoverable tools and unchanged unrelated stubs.
5. Safe Harbour event/task lifecycle and idempotency replay proven through the released stdio/header connector; fixtures reconciled.
6. Cross-client, forbidden-domain, record_decision, suspended/revoked and direct SQL/RPC acceptance evidence reviewed.
7. Actor/client/request/execution/resource tracing and durable replay confirmed; no false invitation/notification/publication status.
8. Staging migration and existing-bot regression evidence accepted; dependency finding tracked; operator authorizes ACTIVE only after Gate smoke and approved secret handling.

## Rollback

Authorized operator disables Admin access/revokes only its new credential and connector, then rolls back gateway/runtime to the reviewed prior release if needed. Do not rotate other bots. Preserve additive event/receipt tables and audit data for reconciliation; do not drop tables or rename applied migrations. Any DB correction is a separate reviewed forward migration limiting only Admin capability/execute grants. Reconcile outstanding fixture events/tasks. Do not promise reminder delivery while inactive or restore credentials solely because code rolled back. Production tokens/header files remain untouched.

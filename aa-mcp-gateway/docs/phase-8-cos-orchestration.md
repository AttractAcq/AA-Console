# Phase 8: Chief of Staff orchestration

Design recorded before implementation. CoS composes existing namespaces; no cos.* API.

| Action | Classification | Boundary |
| --- | --- | --- |
| Granted client delivery, campaign and campaign metrics reads | Autonomous | Explicit client grants only |
| Create, assign, complete tracking tasks | Autonomous | Durable ledger; AA bot label or active team member UUID; no job execution |
| Escalate / request approval | Autonomous request, human decision | Existing gateway approval and activity trail; Alex ping in Grok chat out of band |
| Campaign writes, material client/legal/financial commitments | Human-required | Campaign writes remain hidden stubs; no execution added |
| Record decision, economics, security, deployment | Forbidden | No new grants; record_decision hard deny |

## Data and authorization

Reuse Phase 7 delivery RPCs and projections (see phase-7-client-delivery.md). Extend
mcp_internal.mcp_delivery_tasks with assignee and completion, plus immutable mutation
receipts. job_assignments requires a compensated employee assignment: it is not a
safe delegation ledger. Reusing the Phase 7 ledger avoids a parallel CRM.

workflow task tools -> mcp_workflow_task -> internal workflow_task -> delivery task
ledger and mutation receipts. campaign list/get/status -> mcp_campaign_read ->
internal campaign_read -> campaigns (explicit nonfinancial fields).
attribution.get_campaign_performance uses the same scoped read RPC -> metrics_daily,
paid campaign rows only, bounded date range. It reports observed impressions/clicks/
conversions and freshness, never revenue, ROI, or causal attribution. Empty data is
unknown, not zero performance. Raw upstream payloads are excluded.

Every new internal RPC checks require_active_bot then require_bot_client_grant
(FOR SHARE) before resource lookup; resource client_id must match. Public wrappers
require service_role. Both layers are VOLATILE and executable only by service_role;
no can_access_client. Gateway denies scope before AA. BOT_AUTH_MODE=db and rejection
of nonempty BOT_CREDENTIALS_JSON remain unchanged.

CoS enumerates delivery.list_clients with UUID cursor, then per-client reads. Never
scan the full clients table. Workflow/campaign lists use UUID cursor, max 100.
Compose the company exceptions view by collecting pages then sorting overdue first,
due date ascending, client/task UUID for ties. Delivery retains its 50-row exception
projection and explicit truncation. Completed tracking tasks leave delivery blockers.
Approval/activity reads remain the existing bot/client-scoped gateway control plane;
they are not a claim of visibility into every Console approval. Task mutation receipts
supply the durable delegation audit trail, with actor and request/execution IDs.

Create/assign/complete are idempotent by bot + execution ID. Same key with changed
arguments conflicts; grant and resource validation precede replay. Assignment is only
a tracking label, not authorization for the assignee, dispatch, Slack, or email.

## Onboarding and release

The standard is [Bot Onboarding Contract](bot-onboarding.md), with reference config
`../src/onboarding/chief-of-staff.ts`. Next Marketing Director rollout instantiates
that contract and suite with its existing matrix; do not provision the roster now.
No finance/security/deploy permission pattern is added.

Migration 72 is additive and must be applied by Alex via CoS after Sec review.
Token/grant live state is unverified from this coding worktree. Alex/CoS must inspect
existing identity, issue only a missing CoS bearer, and grant Harbour explicitly using
the established auth administration runbook. Never rotate Production/CDM credentials.
No token, secret header file, or service-role credential belongs in git.

Gate 8 checklist: discovery; granted client rollup, blockers, health, approvals,
activity; task create/replay/assign/list/complete/replay; campaign list/get/status;
observed attribution read; other-client and other-resource denial; revoked grant and
suspended bot denial; forbidden-domain calls and discovery; Harbour stdio connector
smoke; repeat across all granted clients; remove temporary secrets; then ACTIVE.
Local isolation tests gate real registry status. Live activation remains pending the
approved migration/deployment and Harbour smoke. Request Sec review on the draft PR
through Alex/CoS before merge.

## Review evidence

Local validation: gateway 72 tests; runtime 361 tests, including 18 Gate 8 PostgreSQL
route/isolation cases. Both type checks and builds pass. The executable operator
smoke is `scripts/bot-onboarding-smoke.ts`; its steps 4–10 match the contract.
No live smoke has been claimed. Existing workflow grants mean other bots already
permitted these task tools will discover the new implementations after release;
no permission rows or token/client grants are changed by migration 72.

Sec questions: confirm the observed paid-campaign projection is sufficient for the
exec exception scan, and approve the tracking-only assignee model. No campaign-write
or attribution deferral exception is requested. Ready for code/Sec review; not ACTIVE.

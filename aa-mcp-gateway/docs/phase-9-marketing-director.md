# Phase 9: Marketing Director onboarding

Second reuse of the [Bot Onboarding Contract](bot-onboarding.md), reference config
`../src/onboarding/marketing-director.ts`. No new MCP gateway architecture; the
shared MCP endpoint and connector pattern from `chief-of-staff.ts` are reused as-is.
Production/CDM/CoS connectors are untouched.

## Alex-locked grant matrix (2026-09-09)

Tightened from the Phase 8 wildcard placeholder (`campaign.*`, `content.*`,
`conversion.*`, `proof.*`, `attribution.*`, plus five workflow verbs) to an
intentional 23-tool allowlist. Discovery uses **exact set equality**
(`actual === expected`), not prefix/wildcard matching.

| Action | Classification | Boundary |
| --- | --- | --- |
| Campaign/content/attribution/delivery/workflow reads (15 tools) | Autonomous | True reads only; `delivery.list_clients` withheld |
| Content brief/revision/approval-request/repurpose writes, workflow task + approval writes (8 tools) | Autonomous | Idempotent, audited, replay-safe |
| `campaign.*` writes, `content.generate_ideas`/`select_idea`, `attribution.get_content_performance`, `proof.*`, `conversion.*` | Future (hidden) | Registry may exist; not discoverable until made real in a separate PR |
| `content.approve_asset`, `content.queue_distribution`, `content.assign_production`, `content.submit_asset`, `attribution.get_revenue_attribution`, `delivery.list_clients` | Forbidden | Marketing may request approval/revision but cannot approve, assign production, submit assets, or see cross-client rollups/revenue |
| `economics.*`, `security.*`, `engineering.*`, `pipeline.*`, `sales_agents.*`, `finance.*`, `deploy.*`, `infra.*`, `secrets.*`, `admin.*`, `workflow.record_decision` | Forbidden | Same hard-deny posture as every other Bot |

### READ (15)

`campaign.list`, `campaign.get`, `campaign.get_status`, `content.list_ideas`,
`content.get_idea`, `content.get_brief`, `content.get_production_status`,
`attribution.get_campaign_performance`, `delivery.get_client`, `delivery.get_status`,
`delivery.get_client_health`, `workflow.get_pending_approvals`,
`workflow.get_activity`, `workflow.list_tasks`, `workflow.get_task`.

### WRITE (8)

`content.generate_brief`, `content.request_revision`, `content.request_approval`,
`content.create_repurpose_plan`, `workflow.create_task`, `workflow.assign_task`,
`workflow.complete_task`, `workflow.create_approval`.

Request/approve are deliberately separated: Marketing can `content.request_approval`
but `content.approve_asset` stays forbidden, so an asset can never self-approve on
its way to distribution.

## Data and authorization

No new internal RPCs. Marketing reuses the exact same scoped RPCs already live for
`bot_chief_of_staff` and `bot_production` (Phase 5-8): `require_active_bot` then
`require_bot_client_grant` (FOR SHARE) before resource lookup, both VOLATILE and
service_role-only, no `can_access_client`. `workflow.record_decision` stays hard-denied
in code even against a hypothetical `workflow.*` grant (see `permissions.ts`).

The gateway's `allowed()` now additionally intersects `bot_marketing` calls against
`marketingDirector.grants` in code, so a stale or overbroad database row (e.g. a
leftover `content.*` permission) cannot widen Marketing past the locked ceiling —
the code matrix is the enforced ceiling, the database is the provisioning record.

Migration 73 replaces `bot_marketing`'s permission rows only: it deletes and
re-inserts by `bot_id = 'bot_marketing'`, touching no other bot's permissions, no
tokens, no client grants, and no bot status. It is replay-safe (delete + insert,
not a raw insert) and additive/reversible in principle, but is **not applied** here;
Alex/CoS applies it after Sec review, same as migration 72.

## Onboarding and release

Gate 9 (`scripts/marketing-onboarding-smoke.ts`, `npm run smoke:marketing`) extends
the Phase 8 smoke pattern with:

- exact discovery set equality (missing OR unexpected tool fails the gate)
- allowed reads across Harbour, with pagination cursor-repeat checks
- all eight real writes smoked with disposable fixtures, each replay-checked and
  cross-referenced against `workflow.get_activity` for Marketing's own bot identity
- cross-client denial (`client_scope`) and foreign-resource denial
  (`foreign_resource`) before the write path
- forbidden-domain denial (`forbidden_tool`), explicitly including
  `content.approve_asset`, `delivery.list_clients`, every FUTURE stub, and the
  existing economics/security/engineering/pipeline/sales_agents/finance/deploy/
  infra/secrets/admin/`workflow.record_decision` set

Local isolation tests (`test/marketing-director.test.ts`) gate the same checks
against the in-process `ActionEngine`/registry before any live connector run, plus
a Phase 9 migration-replay test in `agent-runtime` confirming migration 73 only
touches `bot_marketing` rows and is idempotent under a double-apply.

Token/Harbour grant provisioning, Production/CDM/CoS token rotation, migration 73
application and Railway deployment are release steps for Alex via CoS after Sec
APPROVE, same as Phase 8. No coding-agent production SQL is part of this contract.

## Executable Harbour suite (Gate 9)

Run `npm run smoke:marketing -- /private/path/fixtures.json /private/path/headers`
from `aa-mcp-gateway` after Alex's release, same connector/header posture as the
Phase 8 suite (stdio, private 0600 header file, never paste tokens into chat or CLI
arguments). It does not issue/revoke tokens or alter grants.

Nonsecret fixture JSON shape (`MarketingFixtures`, see `scripts/marketing-gate.ts`):

```json
{
  "approved_safe_fixtures": true,
  "client_id": "<Harbour UUID Marketing is granted>",
  "campaign_id": "<campaign UUID under that client>",
  "generation_idea_id": "<content idea UUID under that client>",
  "revision_brief_id": "<brief UUID eligible for revision>",
  "pending_asset_id": "<asset UUID awaiting approval>",
  "approved_asset_id": "<asset UUID eligible for repurposing>",
  "denied_client_id": "<ungranted client UUID>",
  "denied_task_id": "<task owned by that ungranted client>",
  "denied_campaign_id": "<campaign owned by that ungranted client>",
  "denied_asset_id": "<asset owned by that ungranted client>",
  "assignee": "<bot label or active team member UUID>"
}
```

All identifiers must be real, existing fixtures scoped to a client Marketing is
actually granted; `approved_safe_fixtures: true` is a manual attestation that the
mutated records are disposable/non-production-facing. Missing or fabricated
fixtures fail the Gate.

## Review evidence

Local validation: gateway 79 tests (including 4 Marketing-specific: discovery/grant
lock, ceiling-vs-stale-db enforcement, all-23-tools client-scope denial, and the
full Gate 9 write/replay/audit/approval flow); agent-runtime 382 tests, including the
Phase 9 migration-replay case. Both `tsc --noEmit` and the gateway build pass.
No live Harbour smoke has been claimed; `bot_marketing` token/Harbour grant status
is unverified from this worktree.

Sec questions: confirm the request/approve separation (Marketing requests, never
approves) is sufficient control for content leaving the pipeline, and confirm
withholding `delivery.list_clients` (client rollup) from Marketing while keeping
per-client `delivery.get_client`/`get_status`/`get_client_health` is the intended
scope. Ready for code/Sec review; not ACTIVE.

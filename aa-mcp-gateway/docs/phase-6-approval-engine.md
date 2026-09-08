# Phase 6 — Approval engine

Status: design locked for implementation; Sec review required before merge.
Base: main at 2243a46, including migration 69. No production apply or Railway deploy.
The [Phase 5 binding security rules](phase-5-production-manager.md) remain binding.

## Classification

| Class | Production Manager actions | Boundary |
| --- | --- | --- |
| Autonomous | list_ideas, get_idea, get_brief, get_production_status | Granted client only; status reads do not decide |
| Autonomous | generate_brief | Already-approved idea only |
| Autonomous | request_revision | Existing Phase 5 rework restrictions; cannot unapprove assets |
| Autonomous | request_approval | Records a wait; draft brief may become approved for human build under Phase 5 contract |
| Autonomous | create_repurpose_plan | Approved asset; linked continuation also verifies Console human review |
| Autonomous | workflow.get_pending_approvals, get_activity, create_approval | Gateway control-plane receipts/tickets only |
| Human approval required | Media asset approve/reject; final ready-for-distribution gate; Console Approve & Build | Console review_media_asset remains authority; a brief approved for build is not an approved asset |
| Forbidden | Bot review_media_asset, content.approve_asset as a decision, workflow.record_decision | No Bot decision ingress; record_decision hard-deny remains permanent |
| Forbidden | can_access_client on Bot paths; cross-client access; finance/security/deploy for bot_production | Active Bot + grant before lookup; existing CoS prohibitions |
| Out of scope/stub | queue_distribution and other Phase 5 stubs | No new real tools |

## Durable object and correlation

Extend mcp_internal.mcp_content_requests, rather than introducing another decision ledger.
Existing primary key (bot_id, execution_id) is stronger than client-scoped uniqueness:
reusing an execution for another client/resource/payload is an idempotency conflict.
Approval rows retain immutable request_id, execution_id, resource IDs, payload and receipt.
The response adds approval.execution_id and approval.request_id for recovery after gateway restart.
The receipt is historical; poll status for the current outcome, never replay request_approval
as a way to read a decision.

Console approvals_queue is a view of pending assets. client_asset_reviews is the human
decision ledger. Gateway workflow.create_approval is an informational control-plane ticket;
its reviewer approval cannot satisfy an asset wait. No Bot-visible decision write is added.

Status returns approvals for the requesting Bot and granted client and selected resource.
The latest 50 matching requests are returned, newest first. Each includes request
attribution, current wait state, latest matching human decision
(ID, reviewer, timestamp, decision; no free-text reason), and durable continuation receipt.
Asset requests bind exactly that asset. Brief-only requests wait for a human-approved
asset on that brief. Revision/pending/rejection blocks readiness; an unrelated approved
sibling cannot satisfy an asset-specific wait. Status is a read-only projection of durable
AA records; no triggers, polling side effects, webhooks, or copied decision authority.

## Pause and resume

1. Call content.request_approval with a stable idempotency key. Persist returned
   approval.execution_id with the workflow. This is the logical execution to resume.
2. Pause while status.approvals reports waiting_for_human or rejected. Brief-only
   requests can report awaiting_production. Console performs build/review as appropriate.
3. Human calls Console review_media_asset. Poll content.get_production_status for the
   original resource. Only a current approved asset with a matching human review allows
   that wait to become approved. No Bot calls review_media_asset or record_decision.
4. For repurpose, pass the original approval_execution_id to content.create_repurpose_plan,
   plus approved asset, formats and a stable continuation idempotency key. Runtime selects
   mcp_resume_approval. This optional field preserves existing Phase 5 callers.
5. Resume locks the approval row, validates Bot/client/resource and current human approval,
   and atomically queues one repurpose continuation per approval execution. Its internal
   step execution ID is deterministic (resume. + MD5 of Bot and approval execution).
   Repeated delivery, including a new gateway key, reuses that job; changed asset/formats
   conflicts. MD5 here names a step, not a credential. Root approval_execution_id is carried
   in the result and ledger; request_id identifies the initial continuation receipt.
   Each incoming gateway execution also receives a durable alias receipt so a transport
   key cannot be reused for another approval root. Alias rows do not queue jobs.
6. Poll status for resumed plus resume.job_id. A later human rejection blocks readiness
   and further resume calls even if an old receipt exists. Already queued work is not canceled.
   Distribution is still a stub; handoff-only consumers continue the same saved execution
   after observing approval without creating a new AA job.

The gateway creates a distinct execution ID per tool receipt. The root approval ID is
explicitly preserved across those steps; reusing the raw gateway execution ID across
different tools would violate the existing ledger contract. Gateway replay returns its
original receipt, not fresh outcome; gateway checks current identity scope before replay,
and AA replay checks active Bot and grants. If a premature continuation cached approval_required,
poll until approved and use a new continuation key with the same root; AA still guarantees
one continuation job. Do not switch to an unlinked Phase 5 call to recover.

## Surface decision

Use existing content.get_production_status for AA waits and request → decision → resume
trail. Keep workflow.get_pending_approvals/get_activity as gateway-only views: making
these depend on AA would broaden every Bot's workflow read surface. Their receipts remain
useful but are not substitutes for AA status. No new tool names or permission grants.
The sole new HTTP behavior is optional approval_execution_id on the existing repurpose
route; its new SQL wrapper and internal RPC use both active and grant helpers.
All grant-touching reads remain VOLATILE, including public wrappers (migration 69).
All new RPC execution is revoked from public/anon/authenticated and granted service_role.
Ledger forced RLS and direct DML revocations remain unchanged. No human RPC is replaced.

## Verification and Gate 6 smoke (fixture or Harbour Dental)

Run gateway tests/check and runtime tests/typecheck. RLS-enabled PGlite fixtures apply
68, 69 and 70, use the real human review RPC, and exercise isolation and durable resume.
PGlite does not replace staging PostgREST/concurrency smoke.

Non-production first; Alex via CoS gates any production migration/deploy:

1. Verify db auth, empty BOT_CREDENTIALS_JSON, granted client and unchanged stub/deny list.
2. Request approval for a pending fixture/Harbour Dental asset; save returned approval
   execution and request IDs. Replay same key: one ledger row, no asset decision.
3. Poll status: wait visible to that Bot; no ready_for_distribution. Other client denied.
4. Human approves in Console; poll original resource: approval approved, human reviewer
   evidence, ready_for_distribution true (assuming no other production blocker).
5. Repurpose with approval_execution_id and formats. Retry same key, then another key:
   same job ID and one canonical ledger continuation (additional transport receipt rows are expected). Changed formats must conflict.
6. Poll original resource: resumed with same root execution, decision and job receipt.
7. Check rejected/pending assets cannot resume, grant revocation and suspension deny,
   and workflow.record_decision/content.approve_asset cannot make a Bot decision.
8. On staging, issue simultaneous resume requests using separate connections and confirm
   one job; exercise public wrappers through PostgREST to verify VOLATILE behavior.

## Sec handoff

Review migration 70 and optional continuation ingress, particularly human decision
projection and one-continuation-per-approval semantics. No approval-write exception is
requested. Sec must be notified before merge; Alex via CoS controls merge/apply/deploy.
Test results and PR/SHA are supplied with the implementation handoff.

Implementation validation: gateway 64/64 tests; runtime 328/328 tests; both TypeScript
checks and builds passed. After the transport receipt hardening, all 38 affected runtime
HTTP/isolation tests passed again. The CI workflow now also runs gateway checks/tests/build.
Ready for Sec review. Gate 6 live acceptance still requires the Alex-gated staging/Console
smoke above, including multi-connection concurrency and PostgREST. No production changes.

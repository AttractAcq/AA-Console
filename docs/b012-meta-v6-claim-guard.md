# B012 Meta v6 build claim guard — held code slice

**Status:** preparatory and held. The stacked migration 292 supplies a durable job producer and binding, but no `meta_ad_build` action handler calls it. These changes do not enable an external switch, change a support flag, or make a paid build ready for release. A paused Meta object is still an external write.

## Verified starting state

- Migration 239 advertises `meta_ad_build.supported=true` and supplies `assert_meta_build_allowed_v6`, but `agent-runtime/src/campaigns/actions/executor.ts` has no `meta_ad_build` handler. A claimed action therefore fails without building.
- `agent-runtime/src/agents/meta_build/index.ts` directly runs `meta_build` jobs. Before this change, a v6 job only asked migration 239 for the most recent valid approval; it did not prove that the job arose from the matching claimed `campaign_action_executions` row.
- `public.request_meta_build` in migration 203 still permits a client-authorized **legacy** campaign to queue a Meta job outside the v6 Approval Inbox/action execution path. This is a B010 universal gate blocker. The code slice leaves legacy behavior unchanged.
- SELECT-only production aggregate at **2026-10-30 04:45:38 UTC**: three historical `meta_build` jobs were failed (two legacy, one without campaign input); zero were created in the previous seven days or active; `meta_ad_build` had zero approval rows and zero execution rows; zero clients had `campaign_actions_enabled=true`. These counts do not authorize a provider write or a support/switch change.

## This code slice

For nonlegacy campaigns, `meta_build` now refuses before loading credentials or contacting Meta unless:

1. The campaign is paid and uses Meta; the job carries UUID `campaign_action_execution_id` and `campaign_action_approval_id` parameters.
2. The execution is currently `executing`, has an unexpired lease, and matches this client, campaign, approval and `meta_ad_build` action.
3. The execution's typed, immutable `meta_build_job_id` equals this exact `agent_jobs.id`. Migration 292's service-role producer stores that binding and mirrors the ID in `result.meta_build_job_id` for compatibility with the earlier guard; no action handler calls the producer yet.
4. The referenced approval is approved for the same client, campaign, manifest and artifact hash.
5. The approved destination and scope match the currently recorded Meta ad account.
6. The existing migration 239 gate accepts the live switch/package/hash and returns this same approval ID, not another approved version.

The helper performs only database reads and the existing service-role gate RPC. Focused tests cover absent/malformed/mismatched claims, stale lease, wrong destination or scope, superseding approval, live gate rejection, no provider/credential call on an unbound v6 job, and the untouched legacy branch. Migration 292 adds a unique campaign-wide Meta binding, execution binding validation on both insert and update, immutable job identity triggers, and `enqueue_approved_meta_build_v6(execution_id)`. Its producer locks the execution and campaign, rechecks approval/package/hash/account/switch/lease, atomically queues one job and stores its ID, and returns the same ID on repeated calls while the exact claim remains current. It does not mark the action executed or dispatch the job.

Migration 239's build hash cast `human_approved_at::text` under the caller's timezone. A local PostgreSQL rehearsal showed the same unchanged creative produced different hashes in `Etc/GMT-1` and UTC. Migration 292 stops if any Meta build approval already exists, then pins the hash function's timezone to UTC. This is deliberately fail-closed: a fresh zero-approval read is required before application, and any existing decision must be reviewed rather than silently reinterpreted.

## Required release sequence after this held slice

1. **B010 external gate:** close the authenticated legacy `request_meta_build` bypass or route it through a reviewed exact-version Approval Inbox decision. Inventory all direct `meta_build` enqueue callers before changing that RPC. Preserve the existing legacy route until a tested replacement is ready; do not describe this code slice as closing it.
2. **Database binding and serialization:** review and release migration 292 after the held migrations 283–291 in order. It adds the atomic producer, typed immutable `campaign_action_executions.meta_build_job_id`, a unique bound job per campaign, and a no-second-job guard even for a failed historical Meta job. PGlite covers repeat calls, distinct approvals, stale context, rollback and immutable identity. A separate two-session PostgreSQL rehearsal must still verify concurrent producer calls and crash recovery against the final full schema before the handler is enabled.
3. **Worker lifecycle:** keep the action execution `executing` while the Meta job runs; renew its lease, and record `executed` only after provider IDs are durably recorded and the worker has verified completion. Record a failure/ambiguous outcome without marking the action executed on enqueue. Migration 239 currently refuses a campaign once `meta_campaign_id` is present, which also blocks a partial-build resume; fix that under the same exact approval before permitting an unattended retry. Preserve the existing “unknown provider response requires human reconciliation” rule.
4. **Provider boundary:** revalidate the exact account, package hash, human decision, switch and live job/execution lease immediately before each external write. If a source changes after this helper's read, the build must stop. Test wrong account, revoked approval/rights, changed creative or budget, duplicate job, and unknown Meta response with zero duplicate external objects.
5. **Capability parity and pilot:** correct the misleading `supported=true`/missing-handler state through a later migration or a fully tested handler. Keep all external switches off until an approved, paused real-account pilot yields one execution, one job, one set of recorded provider IDs, and read-back evidence. Activation and budget changes require separate exact-version decisions.

This document is a dependency record for the B012 blueprint row, not a production release receipt.

---

*Migration numbers in this document refer to the released labels. The nineteen migrations integrated by #297 were renumbered from their original 280–298 to 283–301; references here were corrected on 1 November 2026. See `V6_MERGE_ARCHIVE_RECORD.md`.*

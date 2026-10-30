# B012 Meta v6 build claim guard — held code slice

**Status:** preparatory and held. This change does not connect `meta_ad_build` to the campaign action executor, enable an external switch, change a support flag, or make a paid build ready for release. A paused Meta object is still an external write.

## Verified starting state

- Migration 239 advertises `meta_ad_build.supported=true` and supplies `assert_meta_build_allowed_v6`, but `agent-runtime/src/campaigns/actions/executor.ts` has no `meta_ad_build` handler. A claimed action therefore fails without building.
- `agent-runtime/src/agents/meta_build/index.ts` directly runs `meta_build` jobs. Before this change, a v6 job only asked migration 239 for the most recent valid approval; it did not prove that the job arose from the matching claimed `campaign_action_executions` row.
- `public.request_meta_build` in migration 203 still permits a client-authorized **legacy** campaign to queue a Meta job outside the v6 Approval Inbox/action execution path. This is a B010 universal gate blocker. The code slice leaves legacy behavior unchanged.
- SELECT-only production aggregate at **2026-10-30 04:45:38 UTC**: three historical `meta_build` jobs were failed (two legacy, one without campaign input); zero were created in the previous seven days or active; `meta_ad_build` had zero approval rows and zero execution rows; zero clients had `campaign_actions_enabled=true`. These counts do not authorize a provider write or a support/switch change.

## This code slice

For nonlegacy campaigns, `meta_build` now refuses before loading credentials or contacting Meta unless:

1. The campaign is paid and uses Meta; the job carries UUID `campaign_action_execution_id` and `campaign_action_approval_id` parameters.
2. The execution is currently `executing`, has an unexpired lease, and matches this client, campaign, approval and `meta_ad_build` action.
3. The execution's existing `result.meta_build_job_id` equals this exact `agent_jobs.id`. This is the future atomic producer's job binding contract; no producer writes it yet.
4. The referenced approval is approved for the same client, campaign, manifest and artifact hash.
5. The approved destination and scope match the currently recorded Meta ad account.
6. The existing migration 239 gate accepts the live switch/package/hash and returns this same approval ID, not another approved version.

The helper performs only database reads and the existing service-role gate RPC. Focused tests cover absent/malformed/mismatched claims, stale lease, wrong destination or scope, superseding approval, live gate rejection, no provider/credential call on an unbound v6 job, and the untouched legacy branch.

## Required release sequence after this held slice

1. **B010 external gate:** close the authenticated legacy `request_meta_build` bypass or route it through a reviewed exact-version Approval Inbox decision. Inventory all direct `meta_build` enqueue callers before changing that RPC. Preserve the existing legacy route until a tested replacement is ready; do not describe this code slice as closing it.
2. **Database binding and serialization:** add a reviewed migration/RPC that locks the exact approved execution and campaign, rechecks current manifest/hash/account and switches, atomically enqueues one `meta_build` job, and stores its ID as immutable `campaign_action_executions.result.meta_build_job_id`. Enforce one active build per campaign, not merely one execution per approval; distinct approvals can exist for one campaign. Refuse a second job for the same execution, including after lease expiry. Test concurrent claims and crash recovery in PostgreSQL.
3. **Worker lifecycle:** keep the action execution `executing` while the Meta job runs; renew its lease, and record `executed` only after provider IDs are durably recorded and the worker has verified completion. Record a failure/ambiguous outcome without marking the action executed on enqueue. Migration 239 currently refuses a campaign once `meta_campaign_id` is present, which also blocks a partial-build resume; fix that under the same exact approval before permitting an unattended retry. Preserve the existing “unknown provider response requires human reconciliation” rule.
4. **Provider boundary:** revalidate the exact account, package hash, human decision, switch and live job/execution lease immediately before each external write. If a source changes after this helper's read, the build must stop. Test wrong account, revoked approval/rights, changed creative or budget, duplicate job, and unknown Meta response with zero duplicate external objects.
5. **Capability parity and pilot:** correct the misleading `supported=true`/missing-handler state through a later migration or a fully tested handler. Keep all external switches off until an approved, paused real-account pilot yields one execution, one job, one set of recorded provider IDs, and read-back evidence. Activation and budget changes require separate exact-version decisions.

This document is a dependency record for the B012 blueprint row, not a production release receipt.

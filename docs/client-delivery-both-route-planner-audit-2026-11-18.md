# Coordinated campaign planner contract audit — 18 November 2026

**Scope:** Source at draft PR #363, after migration 569. No hosted mutation or provider action was performed. This is a source finding and a proposed correction, not a claim that a client campaign failed live.

## Reproducible contract break

1. Migration 302 permits a commercial campaign with `acquisition_mode='both'`, `runs_organic=true`, `runs_paid=true` and a Meta or Google paid platform. Later route planning and work-item migrations use separate organic and paid route packages.
2. `runCampaignPlanJob` treats `both` as v6 and calls `capture_campaign_intelligence_snapshot_v6` before asking the model to plan. The function from migration 207 rejects any mode outside `('organic','paid')`. Its immutable snapshot table has two checks that also reject `both`. A new coordinated campaign therefore cannot finish this path.
3. On plan save or crash recovery the same worker calls `create_campaign_manifest_v6`. The function from migration 205 rejects `both`; its immutable manifest table has two checks that also reject it. Merely allowing the value in the table would still leave the manifest with one `distribution` item and one module, so it cannot express both route obligations.
4. `request_campaign_action_approval_v6` from migration 206 accepts paid-build actions only for mode `paid` and organic publish only for mode `organic`. The `campaign_route_actions` and `campaign_launch_due` views from migration 245 resolve one distribution route and classify `both` as not live even when evidence exists.
5. Paid execution and operator surfaces still gate on `acquisition_mode='paid'`: the Meta job path (migrations 239 and 292), Google build-sheet/build paths (243, 260 and 294), and the newer Google manual operator bundle (541). These must be audited against per-route package identity before widening a predicate; changing the mode check alone could attach the wrong creative or approval.

## Correction contract for review

- Extend the snapshot and manifest constraints and writers to accept `both` only with an explicit Meta or Google paid platform. Preserve existing immutable rows and job-key retry semantics.
- Keep one commercial manifest, but give a `both` manifest separate `distribution` (organic) and `paid_distribution` items. Require each through its own route and action; preserve the old item keys and outputs for single-route manifests. The attribution item must depend on both distribution items for `both`.
- Allow organic publication and the selected paid-build action against a `both` manifest as separate exact approvals. Do not treat one approval as authority for the other route.
- Expand route-action readiness to show both obligations. For a `both` campaign, the legacy `live` boolean should be true only after both a post and paid spend are observed, with a distinct partial-live verdict when only one route has evidence. Missing paid account binding or metric coverage must remain unknown rather than zero.
- Verify a rollback-only fixture with a `both` campaign from job-bound Intelligence capture through an idempotent manifest, two distribution requirements, separate exact action approvals, and readiness/live states. Include wrong platform, stale package, cross-client and single-route regressions.
- Review each Meta and Google paid handoff against the paid route package, and the organic scheduler against the organic package. Keep execution held where an exact route binding or provider receipt is absent.

This correction is not yet implemented. No migration is authorized for staging or production by this audit. It belongs in Phase 4 source completion and Phase 9 live acceptance; the current plan remains open.

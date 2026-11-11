# Phase C release review

This branch prepares Phase C; it does not authorize or perform a release. `AGENTS.md` requires Alex via Chief of Staff before merging a release PR, applying a production migration or deploying Railway.

## Prepared changes

- Migration 314 stores ordered `content_pieces` and includes them in the approved plan fingerprint. The plan, route volumes and piece mix commit in one RPC, including after worker retries. A human cannot approve a new v6 plan without a valid route, media type and format for every piece. A changed mix makes the old approval stale.
- The planner writes the mix; the sweep passes each slot's approved route and shape into ideation. Existing legacy campaigns retain their historical single-image sweep behavior. Google-only campaigns still have no post-platform destination for this sweep and remain explicitly blocked by `platformFor`.
- Dashboard switches retain the per-client engine switch. An expandable Dashboard section now carries the cadence, platform, budget, timezone and system controls; the duplicate Distribution Engine tab is removed. The Engine approval inbox remains.
- The workflow reconciler directory is named `workflows/`. Intelligence readers exclude archived records, and agent reruns refuse to silently rewrite archived template records.
- Proof capture cadence and handoffs are recorded in `V6_1_PHASE_C_PROOF_PRODUCTION_2026-11-09.md`. The Intelligence output-quality gate is specified in `V6_1_PHASE_C_INTELLIGENCE_QUALITY_GATE_2026-11-09.md` and has not passed without representative answer/source evidence.

## Release sequence after review and approval

1. Verify the remote branch and all four exact-head CI checks. Review migration 314's planned `content_pieces` behavior and check current production v6 campaign counts before apply; any approved v6 plan will need human re-review because its fingerprint changes.
2. Merge the reviewed code PR only after Alex's Chief of Staff approval. Keep the browser receipt at migration 313 until the next step.
3. Apply migration 314 with `supabase db push --linked` only, then independently read back the production ledger and schema. Never use `migration repair --status reverted`.
4. Deploy the exact reviewed `agent-runtime/` tree to Railway after separate Chief of Staff approval, verify its public runtime identity and migration head, then create a separate browser receipt PR pinning the **whole** runtime directory SHA and migration 314. The gateway pin remains the deployed gateway SHA.
5. Merge the receipt only after exact-head CI and separate Chief of Staff approval. Verify Pages deployment, served bundle SHA and public live identities.

The Intelligence repetition and false-claim review remains a Phase C completion gate. This branch must stay draft until that evidence is reviewed or the release scope is expressly changed.

## Read-only production preflight

At 2026-11-10 13:42 UTC, an exact-count read of production `client_campaigns` found **0 v6 campaigns, 0 built v6 plans and 0 approved v6 plans**. Migration 314 therefore had no existing v6 approval fingerprint to stale at that snapshot. Recheck counts immediately before apply; this is a time-bounded observation, not authorization to merge or migrate. The linked migration ledger was not read in this worktree because it is not linked to the production project.

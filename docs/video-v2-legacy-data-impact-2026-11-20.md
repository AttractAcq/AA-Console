# Video V2 database transition: legacy data impact

**Status:** Source investigation only, 20 November 2026. No migration applied. The detailed November 15 video plan predates later Motion Design review and attachment safeguards; its sample `0262_video_projects.sql` cannot be applied verbatim at the current head (`20261124053900_664_client_video_brand.sql`).

## Current records and dependencies

| Current source | Data or behavior that must survive |
| --- | --- |
| Migration 181 | `motion_design_projects`, existing job IDs, render/poster paths, prompts and revision links; `request_motion_design`. |
| Migration 183 | `motion_design_attachments` and their client media asset lineage. |
| Migration 242 | `motion_scenes` with locks/proof references and `motion_render_candidates` with QA, acceptance and rejection history. |
| Migrations 412–414 | Exact Inbox render reviews, accepted content hashes, storage attestations, and invalidation when a project, scene, proof or file changes. |
| Migration 536 | `guard_motion_attachment_v7` requires a completed project and the exact accepted cut before the attachment becomes pending creative. |
| Current Console/runtime | Motion Design pages and worker still read/write the legacy table names. Tests and generated database types reference them. |

The detailed plan proposes renaming the three Motion Design tables, dropping `motion_render_candidates` and old RPCs, and removing the old agents in one phase. At the current migration head, dropping that table would lose exact approval and QA history. Renaming tables before replacing every live function, trigger, view, policy and client/runtime reference would also break the existing route. Historical queued `agent_jobs` must remain auditable even after an old key stops being claimed.

## Data-preserving implementation sequence

1. Inventory live row counts, foreign keys, dependent functions/views, storage paths, queued/running jobs and exact review links in staging and production. Record a recovery point and test its restore before any hosted DDL.
2. Add new `video_projects`, `video_scenes` and project candidate/attachment contracts for the code-rendered route. Preserve legacy tables and rows during rollout. If `video_render_candidates` is extended with nullable `project_id`, update every existing asset-only guard and query before allowing a project-only candidate; never weaken the exact review or rights checks.
3. Add tenant-scoped, versioned RPCs for create, stage advance, failure, cost, lock/edit/rerun, candidate acceptance and attach. Test stale version, cross-client, missing AAL2, revoked proof, duplicate job/attach and changed render bytes with disposable rollback fixtures.
4. Make new UI and workers read/write the new contract. Keep legacy Motion Design available as historical read/restore evidence until all its pending work is resolved. Route new video requests only to the new pipeline after the exact-version review gate passes.
5. Pause old agent claims only after queued/running job disposition is recorded. Remove old write routes after the new path passes manual and campaign video acceptance. Keep old review/QA/attachment data retrievable in Archive; any physical cleanup needs a separate retention decision and proven migration of history.

This is an adaptation of the intended end state, not acceptance of two permanent video pipelines. The new route must still produce reviewed code-rendered MP4s, while historical cuts and decisions remain readable. The current V2 PR contains only the local IR/compiler slice; the hosted schema, worker and UI steps above are open.

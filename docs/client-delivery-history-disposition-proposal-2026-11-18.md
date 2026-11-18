# Migration-history disposition proposal — 18 November 2026

**Status:** Proposal only. Do not repair migration history or treat Phases 8/9 as accepted. The latest read-only staging parity classification has 38 findings: 30 explained environment differences and eight unresolved history findings. Current catalog parity does not reconstruct SQL that Supabase did not retain.

## What the eight findings represent

| Underlying question | Findings | Established evidence | Still unproved |
| --- | ---: | --- | --- |
| Original staging history has no stored SQL payload | 1 aggregate finding covering 277 rows | The recorded payload and hash fields are NULL. | Exact SQL bytes applied for those rows. |
| Staging used alternate 259/260 timestamps | 6 findings: two canonical files locally pending, two possible relabels, two alternate rows remote-only | The Git rename for 259 is byte-identical. Production's recorded 259/260 statements appear in order in the reviewed canonical source. Staging records the alternate names, zero statements and NULL payloads. | That staging applied the canonical 259/260 SQL bytes or an equivalent body. A name or current object match is insufficient. |
| Production recorded a different name for campaign execution migration 72 | 1 finding | Production's recorded body is 11,645 characters and has a captured SHA-256; it is neither byte-identical to nor contained in the earlier reviewed file, and the staging row is only a zero-statement marker. | The origin and exact semantic effect of the production body relative to reviewed source. |

Sources: [38-finding classification](/Users/alex/.aa-console-evidence/staging-overlay-retry-2026-11-17/parity-38-classification-2026-11-18.json), [read-only history lineage](/Users/alex/.aa-console-evidence/staging-overlay-retry-2026-11-17/history-lineage-read-only-2026-11-18.md), and [post-head staging result](/Users/alex/.aa-console-evidence/staging-overlay-retry-2026-11-17/post-head-result-2026-11-18.md).

**Additional local Git check, 18 November:** The recorded production-72 body hash `f72fe64080b663d1eb61b469e2545e53388a677209816372b85a8b7cda6ef424` matched none of the 819 distinct reachable `.sql` blobs in this checkout's `git rev-list --objects --all`. The earlier 72 file and the later compatibility marker each have one distinct body in reachable history, with different hashes. This narrows the local search but does not identify the production body or rule out deploy artifacts outside Git.

## Proposed resolution path

1. Preserve the original migration rows and names. Do not insert canonical 259/260 stamps or relabel the alternate rows merely to make a parity counter green.
2. Seek the original 259/260 and production-72 deploy logs, SQL bundles or database backups. Compare their SHA-256 or statement bodies with the reviewed files. If such evidence is unavailable, record that exact historical SQL cannot be proven.
3. Re-run scoped production/staging read-only parity at a fresh timestamp. Require zero unexplained current schema, function, privilege, trigger, RLS and Storage-definition differences. Keep the 30 environment differences documented with their existing evidence. This proves only present-state equivalence for the objects covered by the report.
4. For migration 72, compare the recorded production body against Git history and each affected current catalog object. Document every semantic difference or explain why the currently deployed object supersedes it. Do not infer equivalence from the recorded name or hash alone.
5. If exact historical bodies cannot be recovered, ask the release owner to decide explicitly whether the remaining **historical provenance gap** can be carried as a known exception for a future source release. That decision is separate from schema parity, hosted recovery and Phase 8/9 journey acceptance. Until then, retain all eight findings as unresolved.

## Boundaries for PR #363

The [PR #363 migration manifest](/Users/alex/aa-console-client-delivery-completion/docs/client-delivery-pr363-migration-review-2026-11-18.md) pins 15 new source files after migration 551. None has been applied to hosted staging or production in this work. Their local clean/upgrade replay does not close any historical finding. The earlier staging reconciliation and guarded cron resume covered a different pinned manifest through 551; it does not rehearse these 15 files. Production and outward switches remain unchanged.

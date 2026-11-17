# Staging reconciliation to reviewed migration 551

**Prepared:** 17 November 2026. **Status:** source workspace prepared; live data-preserving restore and full-head replay **not yet verified**. Staging and production were not modified. Phases 8 and 9 remain unaccepted, with outward switches off.

## Identity and current evidence

| Item | Evidence |
| --- | --- |
| Reviewed source | `61b2166ca562070c00f00dd3984fe71c49d1a7c1`; 568 tracked SQL files; released head `20261124034600` (551). |
| Production | Project `bancbdztffokwiifzoiv`; signed-in Admin reported 568 history rows and head `20261124034600` on 17 November at 10:03 displayed time. Catalog parity is still unknown. |
| Staging | Project `vmmertwoboqiazcsougw`; linked CLI read-only migration list returned 277 history rows, head `20261025250000`. No staging write has been made in this work. |
| Recovery | `supabase backups list --project-ref vmmertwoboqiazcsougw` returned `backups: []` and `pitr_enabled: false` on 17 November. This does not establish a recoverable checkpoint. |
| Token | The server-side parity token is not configured. A scoped `sbp_fc` PAT with Database Read on both projects is required for the read-only capture and live parity report. |

## Alternate 259/260 lineage

Staging's last two rows are alternate stamps `20261025240000_259_which_client_a_message_belongs_to` and `20261025250000_260_building_the_google_campaign`. The reviewed source uses `20261025233000` for 259 and `20261025235000` for 260. Both alternate stamps have invalid clock hours, and all 277 staging rows had `NULL` stored SQL payloads in the October capture; actual applied SQL bytes cannot be proven from history. The source version of 259 was renamed without a byte change. The old staging 260 catalog lacked the reviewed manifest binding, same-client foreign keys, immutable specification, exact approval and destination guards; its `google_ad_build.supported` was incorrectly true. The older `ensure_rls` event-trigger declaration and `mcp_internal.assign_production` definition also differed. See [the detailed 259–272 investigation](staging-259-272-reconciliation-runbook.md) and [PR #257](https://github.com/AttractAcq/AA-Console/pull/257). These are historical observations and must be refreshed before a staging write.

| Source artifact | SHA-256 | Evidence limit |
| --- | --- | --- |
| Reviewed canonical 259 | `83012f6e3349cdac1ae7dbaa4d765fa4135ffe7d80a1ace55372f4f22c186c62` | Byte-identical to the earlier Git file with the alternate 259 stamp; live applied bytes unavailable. |
| Earlier 260 Git candidate | `798f430e75f8edc9590cdbb8b406984be471407c1c76bf9bbf79f6edc93506f1` | Catalog resembles this candidate, but this is not proof of staging's applied SQL. |
| Reviewed canonical 260 | `2faa6d2e3494eac3ad92082813566526c376facf52a3c531d77dd84a74963e9e` | Has guards missing from the historical staging catalog; cannot be replayed directly. |
| Staging-only corrective SQL from PR #257 | `bae478c14e9731cd97ea150d55b716457877f2f19db3982f3c4e5491a2e91554` | Passed the October disposable rehearsal through 279; not yet rehearsed against a fresh staging clone through 551. |

Do not replay canonical 259/260 on the alternate history or mark them applied with `migration repair`. The staging-only corrective SQL imported from PR #257 first disables the false Google capability, verifies the retained client/Auth identity and affected-table state, then repairs the known catalog differences. Its guards stop on changed data or catalog shape. The historical alias rows remain in place, so a successfully reconciled staging history would have **569 rows**, one more than production's 568. Migration-history identity would remain incomplete even if catalog definitions match.

## Current source workspace

`scripts/staging-reconciliation-workspace.mjs` and its test import the reviewed PR #257 correction, baseline and guarded alias strategy. The builder now requires exactly 568 canonical files through 551 and emits four isolated migration workspaces:

| Phase | Starting history | Intended selection | Expected history after apply |
| --- | ---: | --- | ---: |
| Correction | 277 | One staging-only 260 correction | 278 |
| 261–272 | 278 | Twelve reviewed migrations | 290 |
| 273–279 | 290 | Seven reviewed migrations | 297 |
| 280–551 | 297 | 272 reviewed migrations, ending at `20261124034600` | 569 |

The fourth workspace contains the earlier versions for CLI history matching, guarded placeholders for the two alternate stamps, the correction, and all 272 later files. The manifest records SHA-256 for every selected source file. Its `through568.selectedMigrations` must be inspected against the release commit before any CLI push. The script never links a hosted project or applies SQL. `node --test scripts/staging-reconciliation-workspace.test.mjs` passed 3/3 on 17 November, including exact selection/count and fail-closed stale/wrong-project snapshots. This is **workspace selection only**, not a database replay or restore test.

## Required fresh, data-preserving rehearsal

1. Create the scoped Database Read token as described in [schema parity token setup](schema-parity-token-setup.md). Capture P01–P20 and the full history with the script's read-only `capture` command. Keep the JSON in a private directory outside Git. The baseline verifier must match the reviewed 277-row staging state and all pinned catalog/data checks. If it differs, revise the correction from the new catalog and rerun review.
2. Capture a **fresh, private staging checkpoint** including roles, schema, data, Auth, Storage metadata, migration history, and separate cron definitions. Record SHA-256, owner, time and retention. Count Storage objects and Vault secrets again. If either is nonzero, include and verify the corresponding file bytes or decryptable secret recovery. The October bundle and clone are not a current restore point. The Supabase CLI currently lists no physical backup or PITR; a logical bundle alone is not a proven hosted rollback.
3. Restore the fresh checkpoint into a disposable isolated target. Match client/Auth UUID digests, all 277 history rows, bucket metadata, selected catalog definitions and cron definition digest. Keep all restored cron jobs inactive. Verify restoration of a representative retained record and any Storage/Vault material. Prove a feasible forward repair or hosted cutover path for a failed migration before touching staging.
4. Use the four generated workspaces and CLI dry-run at each **disposable** stop point. Require selections of exactly `1 → 12 → 7 → 272` files; no alias or canonical 259/260 may be selected. Apply each phase only to the disposable restored target. Compare retained identity digests, affected-table counts, executor flags, RLS/grants, generated types, 11-category catalog fingerprints and cron definitions after each phase. The final catalog must be compared with a fresh production read-only capture, including migration 551's approval/outcome functions and all 22 expected cron schedules. Categorize any platform-only clone differences; do not waive a live catalog mismatch from an old allowlist.
5. Only after the **current full-head** disposable rehearsal, restore verification, recovery decision and review are complete, propose a live staging sequence. Before each phase, capture fresh history, identities, Storage/Vault counts and backup evidence. Stop at 278, 290, 297 and 569 for read-back. Keep outward switches off throughout. A successful 569-row staging head is not itself a clean parity result; preserve the alternate-history exception in the report.

**Stop conditions:** changed 277-row baseline; nonempty affected Google/action tables without a row-preserving backfill; changed client/Auth identities; missing Storage bytes or Vault recovery; unverified backup/restore; unexpected CLI selection; migration failure; unknown generated-types comparison; new catalog drift; wrong project; or an outward executor becoming enabled. No live staging apply is proposed from the current evidence.

# Lead money currency audit — 19 November 2026

**Scope:** Draft PR #363 source only. This is a data-contract audit, not a hosted migration or acceptance result. Production and staging were not changed. Outward switches remain off.

## Current contract

- `client_leads.sale_value` and `cash_collected` are nullable numeric amounts with no currency column. `opportunity_value` is also currency-free. The Sales OS Details form calls `update_lead(uuid,jsonb)` and permits either amount without a currency. The RPC validates nonnegative values and the stage rule for cash, but has no currency input. Other service/database paths can write `client_leads` directly.
- The current client funnel, asset attribution, Economics and MCP cohort functions were last replaced in migration 599. They sum lead amounts across rows without currency partitions. Eight return expressions in that migration divide those sums by a spend total. Spend has its own currency and can be mixed. The raw arithmetic is not evidence of a meaningful monetary return.
- Migration 599 excludes probe leads from those totals and reconciles sale evidence. Those safeguards must survive currency work. The lead journey trace exposes individual amounts but no currency. `archive_lead` snapshots the full lead row as JSON; `recover_lead` repopulates the row from that snapshot.
- The current draft browser UI labels lead amounts currency-unverified and suppresses return multiples. This prevents a symbol or ratio being presented as verified, but the database and MCP responses still contain the unverified sums and ratios.

## Required source change

1. Store **sale currency** and **cash currency** separately on each lead. They can differ if collection involves conversion. Keep both nullable for historical amounts; never infer either from spend currency, client locale or account currency. Record provenance for a later backfill decision.
2. Extend the Sales OS form and `update_lead` with explicit ISO currency entry and validate the amount/currency pair. A new positive amount needs its currency. A nonfinancial edit to an old lead must remain possible without silently asserting a currency. Protect direct write paths too, while retaining old data and disposable fixtures.
3. Preserve archived currency fields and their history through archive/restore. Add client-scoped tests for allowed edits, absent/invalid currency, legacy nonfinancial edits, and a different-client denial.
4. Replace cross-lead revenue and cash totals with per-currency totals or an explicit incomplete-coverage result. Calculate a return multiple only when every included positive amount has a verified currency, all included amounts use one currency, and that currency equals the single spend currency. Otherwise return null with a reason. Keep the existing probe exclusion, sale-evidence rule, tenant permissions, and cohort windows. Apply this to browser, MCP and Finance Controller responses, not only visible cards.
5. Show individual lead amounts with their recorded currencies and label legacy values unknown. Do not backfill or convert historical values without source evidence. Test mixed lead currencies, missing currency, mismatched spend currency, zero spend, archived history and one valid same-currency route.

## Implementation boundary

This needs a new, hash-pinned migration after candidate 611, generated types, frontend and MCP changes, and clean/upgrade plus rollback-fixture replay. The 17 November local staging checkpoint has five Auth identities with a known fallback-password predicate and is not a substitute for current hosted verification. The eight staging migration-history findings, hosted Storage/tenant behaviour, provider receipts and the two live journeys remain separate blockers. Do not call Phases 8 or 9 accepted from a currency fixture.

## Candidate source checkpoint

Migrations 612 and 613 now store separate nullable sale/cash currencies, validate new positive Sales OS money edits, and fix `recover_lead` so PostgreSQL recomputes its generated `dedupe_key` instead of rejecting the restore. The browser editor requires a currency for a changed positive amount; the pipeline displays a cash total only when all positive rows share one recorded currency. Existing lead money remains unverified. A rollback fixture covers legacy unrelated edits, invalid and missing currencies, separate sale/cash currencies, cross-client denial, and archive/recovery. Clean and upgrade replay, generated types, nine Phase 8 fixtures, scoped read gates, 21 focused browser tests and frontend build passed locally.

Migration 614 now applies the same rule to direct inserts and financial updates. A nonfinancial edit of an old currency-free row remains permitted; exact archived legacy money can be restored while its archive snapshot is present. The rollback fixture checks direct missing-currency denial, a direct same-currency success, legacy edit denial, and archive recovery. Eight Phase 3 and nine Phase 8 fixtures passed in the full local replay; a final Phase 8 replay passed after the direct-success assertion was added.

This remains a **partial currency contract**. Migration 599's aggregate/MCP/Finance Controller return expressions still need comparable-currency coverage and per-currency output. `opportunity_value` also has no currency. The source has not run a hosted staging-data replay at migration 614 or a live sale. No hosted schema, Auth, provider account or outward switch changed. Keep Phase 8 and 9 acceptance open.

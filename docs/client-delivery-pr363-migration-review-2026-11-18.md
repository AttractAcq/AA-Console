# PR #363 migration review manifest — 18 November 2026

**Candidate source:** draft [PR #363](https://github.com/AttractAcq/AA-Console/pull/363). The full SHA-256 values below pin the SQL files, not a hosted release. Recheck the PR head and each hash before any apply.
**Observed hosted baseline:** Production and staging last reported head `20261124034600` (migration 551). Staging has one extra historical correction row. Refresh both heads, cron state, parity and deployment identity before any apply. The eight staging migration-history findings are unresolved.

## Ordered candidate

| Order | Migration file | SHA-256 | Purpose |
| --- | --- | --- | --- |
| 552 | `20261124034700_552_campaign_package_offer_source_current.sql` | `4401df849cc36d813969ab0ccd27047df87bf1a4b2d875432230240c65e3cbb8` | Current offer source in campaign package readiness |
| 553 | `20261124034800_553_campaign_from_signed_secondary_offer.sql` | `1b0c5bcb21428997ecf93ae7f349a28d3db22596c439a3113d16bfb9a6011f68` | Campaign creation from signed secondary offer |
| 554 | `20261124034900_554_campaign_clone_opportunity_lineage.sql` | `2a526a2b3b9d9fd8cf45d23c8f3d3f2c301677a2b0880fd952aa1eb7c64adb75` | Clone opportunity lineage guard |
| 555 | `20261124035000_555_campaign_factory_sourced_create.sql` | `d2a40f230aa367691120828da1bd5689d168278acfb0feda7e7e569bbb5734a6` | Sourced Campaign Factory creation RPC |
| 556 | `20261124035100_556_sourced_mcp_campaign_create.sql` | `381a14818f42024c552918cce11fe78b3bf9292334c5a8a46b2d62ceb5b93a47` | Sourced MCP campaign creation RPCs |
| 557 | `20261124035200_557_atomic_sourced_campaign_revision.sql` | `04a55eaa1abe0784eb3538ad9975ae1a989da139298db12741d3f4bfb34e3c88` | Atomic sourced campaign revision |
| 558 | `20261124035300_558_retire_unsourced_opportunity_creator.sql` | `8d41552aec44828dedd0560c8b23d494ae17190d1ba45c32c6337cdf8d3621de` | Retire unsourced opportunity creator |
| 559 | `20261124035400_559_campaign_package_requires_sourced_offer.sql` | `62203168ac854999a654d4701d7369c9e42d9cfbe6b85b0917ecc0409dfddbcf` | Require sourced offer for package readiness |
| 560 | `20261124035500_560_campaign_offer_proof_rights_snapshot.sql` | `219210f1bc315b02852674ebcf7b9ae012a9283a42f544550d1e075206852abc` | Snapshot offer proof rights in package |
| 561 | `20261124035600_561_opportunity_score_proposal_input_snapshot.sql` | `a8e16eb71aa226029f60fb4d92f8be6a0a71eee73f838c143246e23e653827ee` | Opportunity score proposal input snapshot |
| 562 | `20261124035700_562_atomic_opportunity_strategy_draft.sql` | `fb7c9a596d24991c825b9dc66eb4cdaea1dd7ca2b43deb60eccacf57cf20ec92` | Atomic opportunity strategy draft |
| 563 | `20261124035800_563_human_production_demand_lineage.sql` | `c17e106d2e50231f8a0ab8e3885e7ed96fb592a613669c816b3257b61ac82da1` | Exact human production demand binding and attempt views |
| 564 | `20261124035900_564_production_attempt_timing.sql` | `640eaaed81e00bb99bbb6942a01f1f6efbaed1c366bd03a44a83a89c98355695` | Production attempt timing and terminal render timestamp |
| 565 | `20261124040000_565_assignable_production_demand_search.sql` | `dac831bdd301d6cc3efa2fc6bcf60a00779cc9d191b2b4d66d3f50720a3c7229` | Brief-filtered request discovery view |
| 566 | `20261124040100_566_human_assignment_brief_client_guard.sql` | `6d87c1e58d87c4afbe33c6001cd9b1c48a34c91448abeb7f060861375b8ba07c` | Brief/client guard for human assignments |
| 567 | `20261124040200_567_ads_metric_observation.sql` | `0ae837603ec0785fc9850337c7c3c4836661fcbf0482700cc7816810bf104140` | Distinguish absent provider metrics rows from observed zero activity in Meta and Google reads |

## Review and stop gates

1. Confirm PR head and all four CI jobs at the exact candidate commit. Local disposable replay passed clean and released-to-current equivalence, catalog, generated types, four Phase 5 fixtures and the signed-in read gate; this is not hosted parity.
2. Refresh production and staging migration heads and validated schema parity. Disposition the eight unresolved staging history findings with evidence; do not rewrite migration records to hide them. Keep outward switches off.
3. Run [`phase5-assignment-brief-client-drift.sql`](/Users/alex/aa-console-client-delivery-completion/supabase/verification/phase5-assignment-brief-client-drift.sql) under a genuinely cross-client read role and record the aggregate. A scoped user returning zero is not an audit. Migration 566 preserves historical rows and guards new/retargeted writes.
4. Review replacement function signatures, grants and invoker/definer rights. Migrations 561–564 alter tables or create new state; migration 567 adds four metric-observation columns and replaces two service-only read-recording functions. Migrate the database before deploying browser/runtime code that calls new RPCs or views, particularly migrations 563 and 565. A partial deployment could leave old readers presenting zero placeholders as observed metrics.
5. Rehearse the exact ordered SQL and application build on an isolated or recoverable staging copy, with data/Auth preservation, tenant/RLS tests and rollback/forward-repair evidence. The earlier hosted staging rehearsal covers only its pinned manifest through migration 551; it does not cover these 16 files.
6. Alex via Chief of Staff owns merge, production migrations and Railway deployment under `AGENTS.md`. Stop at the first failed guard, failed migration or parity mismatch. A code rollback does not undo database changes.

## Acceptance remains open

This manifest does not authorize deployment or outward effects. Phase 5 still needs real creative quality and human review. Phases 8 and 9 still need provider receipts, both organic and paid journeys, a consented route-to-cash trace, archive/retrieve, negative tests and exact post-release identities. The Console browser bridge is unavailable in this CLI session, so no new live UI evidence was gathered here.

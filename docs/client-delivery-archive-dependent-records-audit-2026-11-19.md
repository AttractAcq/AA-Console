# Lead Archive dependent-record audit — 19 November 2026

**Scope:** Draft PR #363 through migration 635, inspected in the network-isolated local staging-data rehearsal. This is a schema and source audit, not a hosted or live journey test. The positive-cash `archive_lead` guard remains. No hosted project or outward switch was changed.

## Current deletion boundary

`archive_lead` copies the active lead row and `lead_events` into `archived_leads`, then deletes the active `client_leads` row. `recover_lead` recreates that row and its copied events. It does not snapshot, reparent or recover the other dependent records below. Migration 622 already moved `lead_submissions.lead_id` to the durable, same-client `lead_identities` key, so new promoted capture-route links survive deletion.

| On deleting `client_leads` | Dependent records | Consequence requiring a gate or migration |
| --- | --- | --- |
| Cascade | `campaign_lead_enrolment_items_v6`, `client_appointments`, `lead_sequence_enrollments`, `outbound_messages`, `workflow_lead_attribution` | Rows can disappear, including appointments, message receipts and attribution. Their exact IDs/status/history are not restored by `recover_lead`. |
| Cascade with existing snapshot | `lead_events` | These events are copied into `archived_leads.events` and restored; the new source catalog also reads the archived copy. Verify event ID and timestamp preservation on the full journey. |
| Set lead ID null | `campaign_page_publications.probe_lead_id`, `dm_conversations`, `dm_identities`, `lead_magnet_deliveries` | The records remain, but their lead association can be lost. This can remove historical probe, DM and delivery lineage. |
| Restrict | `proof_outcome_followup_consents_v7`, `proof_request_deliveries.outcome_lead_id`, `proof_service_outcomes_v7` | Archive can fail when one of these rows exists. The UI needs an explicit blocker until a lossless relationship and action rule is defined. |

These are the 13 direct foreign keys to `client_leads` in the local catalog. The list does not establish that indirect or external references are complete. The local `delivery_source_catalog_v6` lead/outcome nodes now survive archive under migration 635, but that does not preserve the dependent operational records above.

## Required implementation order

1. Decide which dependent rows are historical evidence and rekey their lead association to `lead_identities(id,client_id)` without changing their IDs or tenant. Add same-client preflight checks before each foreign-key replacement. Keep completed appointment, message, DM, magnet and attribution records queryable after archive and recovery.
2. Keep an archived identity out of operating claims. Review every writer and due/claim path against current active `client_leads`; where a durable-key foreign key would permit a new record for an archived identity, require an active-lead guard at the final write. Pending sends, bookings, nurture, proof follow-ups and owed deliveries need an explicit stop, cancellation or handoff rule before archive.
3. Make archive and recovery atomic and idempotent for a finished positive-cash lead only after dependent history is durable. Preserve exact lead, event, appointment, message, proof, capture-route, campaign, asset and cash IDs/versions; restore only operating state that was explicitly part of the archived record. A later consented submission must use an explicit reviewed reopen or new-lead transition and must not silently rewrite the archive snapshot.
4. Run one rollback fixture across pre-archive, archived and recovered states: all public/MCP revenue reports, currency coverage, source catalog and links, dependent record IDs/status, active action claims, duplicate callbacks, cross-client denial, and returning capture. A provider-backed read and a signed-in archive/retrieve check remain separate Phase 8/9 gates.

**Stop condition:** Do not remove the positive-cash guard or claim Archive complete while any dependent record is deleted, detached, silently claimable or unverified through recovery. Hosted parity, eight migration-history findings and the organic/paid acceptance journeys remain open.

## Candidate correction after the audit

Migration 636 replaces 12 direct active-lead foreign keys with durable, same-client `lead_identities` references; `lead_events` remains covered by the archived event snapshot. It retains the dependent record IDs and original delete behavior against the durable identity. A trigger on each rekeyed table requires a current same-client active lead for new or retargeted references and locks that lead through the write. `archive_lead` also holds when there are pending outbound messages, active sequences, booked appointments, unfinished magnet or proof deliveries, or open DM conversations. The cash-positive archive guard remains.

A network-isolated local staging-data copy reached migration head `20261124051100` (654 history rows). The rollback fixture retained appointment, DM, workflow-attribution and proof-outcome links across archive and recovery, rejected new references to archived identities, and checked all 12 foreign keys and 12 active-reference triggers. A separate two-connection fixture observed an appointment insert wait for the archive row lock and then fail closed after deletion; the disposable rows were removed. The full local clean and released-to-current replay, generated types, scoped read gate, 30 Phase 8 fixtures and frontend build passed. [Protected cumulative result](/Users/alex/.aa-console-evidence/staging-pr363-85-cumulative-result-2026-11-19.json); [race result](/Users/alex/.aa-console-evidence/phase8-dependent-write-lock-2026-11-19.json).

This correction has not been applied to a hosted project. Status changes on completed dependent records, returning capture, all operational claims, positive-cash archive/recover and signed-in retrieval still require coordinated tests before the archive guard can be removed.

**Status-reactivation candidate:** Migration 637 adds status-change guards for outbound messages, sequence enrolments, appointments, magnet deliveries, proof deliveries and DM conversations. A finished row linked to an archived lead can be read and corrected to another terminal status, but cannot be moved back to an actionable status until that lead is recovered. The rollback fixture checked archived appointment and DM reactivation refusal, restored-lead transitions and all six installed triggers. The isolated staging-data copy reached 655 history rows/head `20261124051200`; its checked client/Auth, paused cron, Storage and trigger aggregates stayed unchanged. [Protected incremental result](/Users/alex/.aa-console-evidence/staging-pr363-86-incremental-result-2026-11-19.json) SHA-256 `e6492c4356dc37cdc34aef66d947008a452ff59435d6baafee3bf14d81c5b0f9`. This is local evidence only; the full operational claim and returning-capture gates remain open.

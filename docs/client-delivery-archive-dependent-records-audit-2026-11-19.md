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

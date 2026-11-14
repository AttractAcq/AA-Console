# Client Delivery Phase 1 contract

This is the implementation companion to the [client delivery build plan](client-delivery-build-plan-2026-11-14.md). It describes the new records and how later producer and executor phases should use them. Migrations 316–323 are additive; they do not activate a provider worker or convert a legacy `live` label into evidence of publication. Migration 322 repairs the existing route guard so new campaigns can be created while route changes and unapproved launches remain blocked.

## Identity and lineage

- `delivery_entity_versions_v6` stores immutable source observations. Its `(client_id, entity_kind, source_key, fingerprint)` key preserves history when a source changes. `delivery_entity_heads_v6` points to the current version.
- `delivery_source_catalog_v6` fingerprints opportunity, intelligence model, logical offer and version, campaign, route package, content and proof, destination, page, magnet, sales agent, approval, campaign action attempt, lead and outcome. A raw lead or approval preview is never copied into the registry.
- `delivery_lineage_links_v6` records same-client source → derived edges. Migration 318 backfills existing associations. Migration 320 links later campaign, offer, opportunity, artifact, proof, magnet, approval, attempt, lead and outcome records as they arrive. A legacy campaign with no route flags gets no invented route package.
- `campaign_route_packages_v6` gives a commercial campaign separately versioned organic and paid route identities. A campaign with both flags gets two packages; each has independent work and approvals.

## Work items and decisions

`delivery_work_items_v6` names a single owning module and records required status, frozen input snapshot, expected output, job, attempts, cost, QA, blocker, exact approval request, external result and retry/remediation details. Immutable manifest requirements backfill as `draft` work; they are not marked complete from a campaign badge.

Trusted module workers call `create_delivery_work_item_v6`, bind exact inputs with `bind_delivery_work_input_v6`, link exact outputs with `link_delivery_work_output_v6`, and call `advance_delivery_work_item_v6`. The transition gate checks the owning module, allowed state edge, QA, output hash and canonical approved artifact hash. A provider ID or URL is required before `externally_confirmed`. `delivery_work_effective_v6` reports `held` when a bound input, output or approval has gone stale, without rewriting historical events.

`bind_delivery_approval_dependency_v6` associates a canonical approval request with every version it used. Campaign action requests automatically bind their campaign and selected offer. Known proof artifacts, source rights, destination settings and creative byte digests are also bound. A changed head inserts an invalidation, makes the Inbox card `stale`, and blocks a later approval event. A completed campaign action or confirmed work item creates a remediation task; an approval alone is not evidence of an external use. Existing proof-placement retraction handling remains the authority for those placements.

## Exact creative bytes

`register_delivery_asset_bytes_v6` accepts a SHA-256 digest from a trusted asset worker for the current storage or render path. It updates the content source fingerprint. A changed path clears the digest. New delivery work cannot link a content output for review until its exact digest is recorded. Existing assets retain a null digest until they are read and hashed; the migration does not guess from their storage paths.

An update or deletion of a matching `storage.objects` row clears the registered digest and invalidates bound decisions. An asset worker must then hash the current object again. Metadata-only changes may cause a conservative invalidation.

## Phase boundary

Phase 1 establishes the durable contract and records truthful historic identities. Later phases must call these RPCs from each producer and bind source-specific dependencies that cannot be inferred from the existing campaign-action payload. Phase 2 still owns universal approval coverage and the pre-execution check. Provider execution remains held by its existing runtime gates.

## Local verification

- A clean local Supabase reset replayed every migration through 323 on 14 November 2026. The eight Phase 1 migrations were present in migration history.
- The PGlite contract suite passed 12 cases: route backfill and legacy preservation; both-route creation and immutability; same-client lineage/work binding; full opportunity-to-outcome trace; stale offer, model, proof right, destination and creative bytes; storage overwrite invalidation; and remediation for both executed campaign actions and confirmed work.
- The Unified Inbox test suite passed 51 cases, including a visible stale-source card with no approval action. The frontend production build completed.
- A rollback-only smoke test against the real local schema created a commercial campaign, one organic package and one paid package, and observed their three current lineage identities. The transaction was rolled back.
- Local schema lint still reports eight errors in functions defined before Phase 1: four proof-placement event writers, three lead-event writers, and lead recovery. None are in migrations 316–323; they belong in the relevant Proof Distribution and Sales/Archive phases.

No production migration or provider action was run. The local database contains no client data from production.

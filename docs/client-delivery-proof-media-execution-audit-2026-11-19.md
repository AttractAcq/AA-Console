# Proof media rights and external-use audit — 19 November 2026

**Scope:** PR #363 source at `04962fca6517c5408fa57bf212178564cd416281` and its isolated 638-row candidate database. This is a source and local catalog review, not a live provider or Storage behavior test. Hosted projects and outward switches were not changed.

## Observed path

1. `agent-runtime/src/proof-rights/request-media-route.ts` downloads private `proof` Storage bytes, computes SHA-256 and byte count, rereads the object identity, and passes those values to `request_proof_media_rights_v6`. Migration 359 binds the digest, size, path and object identity into the exact Inbox preview; migration 360 checks the object identity and invalidation when determining the current rights state. The SQL does not itself read or hash Storage bytes.
2. `src/lib/proofRights.ts` downloads the private file for human review and refuses the download if its current SHA-256 or size differs from the Inbox values. The unified Inbox calls this helper for the media review card. A live signed-in download and human rights decision are still unverified.
3. The currently supported proof placement writer in `agent-runtime/src/proof-distribution/placer.ts` recomputes the approved payload hash and checks the approval/rights gate immediately before its Google Business Profile call. The gate in migration 365 requires `media_type = 'text'` for a direct proof placement and rejects `asset_id` placements. The writer's currently reachable proof path sends text or an approved text artifact. It does not send the private `proof` file to the provider.
4. The source search found private `proof` bucket downloads in the request verifier, human-review helper and public capture duplicate check. It found no external proof-media publisher. This is a source inventory, not proof that every deployed or third-party path was covered.

## Result and next source boundary

The current source has a byte-bound media-rights **request and review** path, while autonomous **external use of private proof media** remains unbuilt/held. The local approval coverage view still reports class 11 `proof_rights` as blocked; it must not be promoted from this audit. Text proof placement also remains blocked on provider account, rights, approval and live receipt evidence.

Before adding an outward proof-media adapter, require a trusted fresh download of the exact `proof` object, a digest and size comparison with the approved rights request, current Storage identity and rights/invalidation checks, and a final exact placement gate before the provider call. Record the provider receipt and read-back separately. A signed URL or matching Storage metadata alone cannot establish byte equality. Test a same-path byte replacement, revoked rights and stale approval as negative cases. Keep the adapter disabled until those checks and an authorized live provider test pass.

This audit narrows an implementation gap; it does not change coverage status, accept Phases 8/9, or authorize outward execution.

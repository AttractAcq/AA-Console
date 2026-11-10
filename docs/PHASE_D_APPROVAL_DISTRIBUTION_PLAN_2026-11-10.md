# Phase D: approval and distribution expansion

Status: development plan, 10 November 2026. Phase D is a later release. It is stacked after draft Phase C because its first schema migration must follow 314. Nothing in this plan authorizes a production migration, Railway deployment, or release merge.

## First usable slice: one decision surface

The unified Approval Inbox currently mirrors nine source routes. The media review queue is the only queue with production decision history, but `client_media_assets` is absent from the canonical ledger. Engine slots are mirrored as blocked cards while `EngineInboxPanel` owns their decisions. Moving either set of buttons without preserving its source checks would create a second, weaker approval route.

1. **Register media approval entries from the owning source.** Add a tenth `client_media_asset` route for each new reviewable asset version. An entry must identify the client, asset, review version, selected review file, and decision owner. It must not infer an exact artifact from a storage path alone. Backfilled legacy entries stay blocked until a trusted byte capture is available.
2. **Capture exact media bytes.** A trusted server process reads the selected `client-media` object, hashes its bytes, and records the object version and immutable evidence reference against the approval entry. For reels the selected object is `render_path`; for other media it is `storage_path`. The preview must use that same captured version. The source decision function must recheck the selected object and asset fields before calling the canonical AAL2 decision recorder. A path, timestamp, signed URL, or user-provided digest is not a byte attestation.
3. **Keep video and creative seats intact.** `review_media_asset` currently checks video owner, manager and requested client sign-offs, edit readiness, reel render readiness, and the optional creative-director seat. The unified panel must invoke the owning RPC only after those checks remain inside its transaction. A rejection still requires a reason. Engine-owned assets are excluded from this route so they cannot be signed off without advancing their slot.
4. **Bring Engine decisions into the unified panel after evidence exists.** The slot epoch is the `slot_events` approval-entry ID. The source resolver currently blocks multiple historical approval entries because their order cannot be proven. A new slot entry needs frozen asset bytes, copy, schedule, platform, destination account and rights; the owning decision must recheck the epoch and exact version under lock before calling `approve_slot` or `reject_slot` and recording the canonical decision. Regeneration remains a separate action on rejected slots. Until then the existing Engine panel stays available.
5. **Retire duplicate panels only after parity.** Compare pending rows, previews, video sign-offs, approve/reject/regenerate behavior, reason history and deep links for the old and unified panels. Remove old navigation only after all of these are available in the unified panel.

## Distribution order

| Class | Required before enabling its first write |
| --- | --- |
| `engine_slot` organic publication | Exact byte and copy snapshot, rights provenance, AAL2 decision for that version, destination account, provider prewrite recheck, provider read-back and log. |
| `campaign_action`, `campaign_budget_profile` paid handoff | Action-specific source payload and budget recheck, named operator handoff, approval version and record of what was sent. |
| `lead_magnet` delivery | File-byte digest, exact delivery words, recipient/scope evidence, decision and delivery read-back. |
| `proof_placement`, `proof_rights`, `proof_artifact`, `proof_delivery` | Rights owner and permitted use, exact artifact, destination linkage, source-owned decision and delivery read-back. |
| `page_deploy` | Already verified by migration 313; retain its existing gate and receipt. |

The ten proof destination rows are configuration candidates, not functioning connections. Facebook and Instagram accounts are an external dependency. Do not turn on a worker merely because a row or UI control exists.

## Product decision still required

`inbox_enforced` currently leaves `is_eligible_lead_owner` false. Activating sales entitlement grants real sales-seat access. Keep this switch off until the product owner chooses the activation policy and the approved, unrevoked grants have been audited.

## Review gates

- A media path overwrite, deleted object, changed asset field, changed slot epoch, or expired request must make approval fail under the owning transaction.
- An AAL1, unprovisioned, cross-client or wrong-seat actor cannot approve.
- A media approval must preserve the existing video sign-off and creative-director rules; an Engine decision must also move the slot or reject it with a reason.
- The canonical decision ledger must contain exactly the source decision that was committed; no orphaned approval or outgoing effect may survive a failed transaction.
- Each enabled external action must log the exact outgoing version and provider read-back. Anything without that evidence stays blocked.

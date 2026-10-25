# SF30 — Approve a placement and watch it place

**Where.** Clients → [client] → Delivery → Approval Inbox → Campaign actions, then
Proof Distribution → Placements
**Owner.** Marketing Director. **Reviewed.** 25 October 2026. **Part of** MF06.

## Do it
1. **Approval Inbox → Campaign actions** — read the request. It is bound to this exact
   artifact version, destination and scope.
2. Approve it. The placement moves to `approved`, then `queued`.
3. The proof placement sweep places it, if **`proof_publishing_enabled`** is on for this
   client (SF06).
4. It reaches `placed`, then `verified` when the placement is confirmed with its external
   record.

## Approval is version-bound
Change the artifact and the approval is void — request again. A person's decision about one
exact artifact and destination cannot authorise a different one.

## If it does not place
Read `proof_placement_due`. In order of likelihood:
1. `proof_publishing_enabled` is off
2. The source proof's rights lapsed between approval and the sweep
3. The destination has no adapter (SF29)
4. The transport failed and it is retrying — the attempt count is shown, with a five-attempt
   ceiling

## Gotcha
`placed` is not `verified`. Placed means we sent it; verified means we confirmed it is there.
For manual destinations the person records that themselves (SF31).

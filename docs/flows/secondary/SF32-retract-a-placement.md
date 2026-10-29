# SF32 — Retract a placement when rights are lost

**Where.** Clients → [client] → Delivery → Proof Distribution → Placements / Rights
**Owner.** Client manager. **Reviewed.** 25 October 2026. **Part of** MF06, MF15.

## When this fires
Proof rights are revoked or expire (SF25). The sweep flags affected placements as
**`retraction_required`**. This covers placements that were only `drafted` or
`awaiting_approval` as well as live ones — a placement waiting for approval whose proof has
gone must not be approvable.

It also fires from **Gone but cited** on Google Profile (SF26): the review was deleted, so
anything citing it is now unevidenced.

## Do it
1. **Proof Distribution → Rights** — see what is expired or expiring.
2. For each `retraction_required` placement:
   - Supported destination → the retraction goes through the adapter.
   - Manual destination → remove it yourself using the recorded external record (SF31), then
     record the retraction.
3. **Verify** the retraction. An unverified retraction is a claim that you removed something.

## Then look wider
A retracted placement is rarely the only exposure. Also check:
- Claims on offer versions leaning on that proof (SF21)
- Motion cuts whose scenes cite it (SF47)
- Published pages and live ads that quoted it (MF15 stage 4)
- Content already posted — terminating the record does not unpublish the post (SF48)

## Gotcha
Do this promptly. The whole point of tracking rights is that the gap between losing a
permission and removing the claim is the window of exposure.

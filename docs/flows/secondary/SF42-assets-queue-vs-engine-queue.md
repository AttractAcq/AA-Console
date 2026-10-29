# SF42 — Approve an asset, or approve engine work: the difference

**Where.** Clients → [client] → Delivery → Approval Inbox
**Owner.** Client manager. **Reviewed.** 25 October 2026. **Part of** MF03, MF07, MF08, MF09.

## Three queues, three different acts
| Tab | What approving does |
|---|---|
| **Engine** | Signs the content off **and puts the post on the calendar** — the slot moves to `scheduled` |
| **Assets** | Signs an asset off. Nothing is scheduled |
| **Campaign actions** | Authorises an external action on an exact version — page deploy, Meta build, proof release (SF78) |

## The mistake this memo exists to prevent
**Approving engine work on the Assets tab approves the asset and leaves the slot exactly
where it was**, sitting at `awaiting_approval`. The content looks approved, the client's feed
stays empty, and nothing errors.

If you are working through engine output, use the **Engine** tab.

## Rejecting
Reject with a reason. For engine work the reason is what stops the engine making the same
mistake next week; for assets it is what the producer needs in order to fix it.

## Gotcha
Neither Engine nor Assets approval publishes anything by itself. `publishing_enabled` still
has to be on (SF06), and the publish sweep still has to run (SF50).

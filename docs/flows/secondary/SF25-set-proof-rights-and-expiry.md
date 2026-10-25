# SF25 — Set proof rights and expiry

**Where.** Clients → [client] → Delivery → Proof Production Factory → Proof Bank → [asset]
**Owner.** Client manager. **Reviewed.** 25 October 2026. **Part of** MF06, every production flow.

## The one rule
**`not_cleared` is the default and it refuses everything downstream.** That is deliberate. A
testimonial used without permission, or a result quoted after the right to quote it lapsed,
is the one mistake in this system that creates legal exposure rather than wasted spend.

## The three states
| `usage_rights` | Meaning |
|---|---|
| `not_cleared` | Default. Nothing derived from it can go out |
| `restricted` | Usable only where the permission says |
| `approved` | Cleared to use |

## Expiry
Set **expires_on** wherever the permission has an end date. **An expired asset behaves like
an uncleared one.** Nothing silently keeps using it.

## What rights control
Rights and expiry **follow every derivative**. A reel made from a review inherits that
review's permission. So clearing an asset clears its descendants, and losing an asset's
rights invalidates them:

- `offer_claim_evidence` flags any claim leaning on it (SF21)
- `motion_candidate_due` flags any cut whose scene cites it (SF47)
- The placement sweep flags live placements as `retraction_required` (SF32)

## Gotcha
`restricted` is not a soft `approved`. If the permission is "website only", an ad using it is
a breach — and the system cannot read your note, so record the restriction somewhere a person
will see before they place it.

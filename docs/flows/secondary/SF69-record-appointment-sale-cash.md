# SF69 — Record an appointment, a show, a sale and cash

**Where.** Clients → [client] → Delivery → Sales OS (v2) → Pipeline
**Owner.** Whoever closes. **Reviewed.** 25 October 2026. **Part of** MF12, MF13.

## The one rule
**Nothing books a call and nothing records a sale for you.** `booking_rule` is prompt text
telling the agent when to *offer* a booking; no calendar is connected and nothing creates an
appointment (**G04**). Every stage from here is a person typing.

## Do it, in order
| Stage | Set it when |
|---|---|
| `appointment` | A call is actually in someone's diary |
| `qualified_appointment` | And the prospect is a fit |
| `shown` | They turned up. Tracking no-shows is half of why this is separate |
| `sale` | They bought, with the amount |
| `cash` | The money arrived |
| `lost` | They did not buy — **with a reason** |

## Why `shown` exists
The gap between `appointment` and `shown` is the no-show rate, and it is usually the cheapest
thing to fix in a client's funnel. If you collapse them, you cannot see it.

## Why `cash` exists
**Cash collected** is what the economics read, and **Cash ROAS** is **Cash ÷ spend**. A
pipeline full of `sale` with no `cash` produces a ROAS that is a forecast pretending to be a
measurement.

## Gotcha
Record these promptly. A week-old sale recorded today lands in the wrong period and makes the
reporting in MF13 wrong in a way nobody will spot.

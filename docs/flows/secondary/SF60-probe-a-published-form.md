# SF60 — Probe a published form

**Where.** Clients → [client] → Delivery → Website Studio (v2) → Publish
**Owner.** Client manager. **Reviewed.** 25 October 2026. **Part of** MF11, MF15.

## The one rule
**This is the step that separates published from working.** A page whose form posts nowhere
looks identical to one that works — same commit, same URL, same screenshot. Do not skip it,
and do not tell a client a page is live before it has passed.

## What the probe does
It posts a real test submission to the live public endpoint and requires that it comes back
as a lead carrying **consent, a campaign and a source**. All three, or it fails.

## Reading the result
| Result | Meaning |
|---|---|
| **Live and tested.** | Pass |
| *Published, but the form probe failed: …* | Fail, with the reason. The page is **not** unpublished |
| *Published. Nobody has tested the form yet.* | Never run |

A failed probe deliberately does not unpublish the page: taking a client's page down
automatically would be worse than leaving it up and saying so.

## Probe leads are real
They are real rows in `client_leads` marked `is_probe`. They have to be real, or the probe
would be testing a path a customer never takes. Exclude them from the pipeline (SF71).

## When it fails
| Reason | Fix |
|---|---|
| No consent recorded | The capture endpoint has no consent wording (SF61) |
| No campaign | The endpoint was not attributed to one (SF61) |
| No source | The form is not passing the source fields |
| Nothing arrived | The form posts to the wrong place, or the endpoint is disabled or revoked |

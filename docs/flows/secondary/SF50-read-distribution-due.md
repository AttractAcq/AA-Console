# SF50 — Read distribution due and publish due

**Where.** `distribution_due`, `publish_due`, surfaced in Organic Content Distribution
**Owner.** SMM. **Reviewed.** 25 October 2026. **Part of** MF03, MF09.

## What they are for
Each names, in one sentence, why a given post has not gone out. This is the first thing to
read when something is "stuck" — before asking anyone.

## The usual answers, in order of likelihood
| Sentence means | Fix |
|---|---|
| Publishing is off for this client | Turn on `publishing_enabled` (SF06) |
| The post has no human approval | Approve it on the right queue (SF42) |
| The platform is not connected | Connect it (SF02) |
| The token has expired | Replace the credential (SF05) |
| The format is not publishable on that surface | Change surface or format |
| The asset's proof rights lapsed | Clear or replace the proof (SF25) |
| It is scheduled for later | Nothing is wrong |

`distribution_due` also shows what is **unpublishable** rather than merely unpublished —
the difference between "waiting" and "will never go".

## Gotcha
"Connected means eligible" — a platform being connected is what makes a surface eligible at
all. If a surface never appears as an option, check the integration before the post.

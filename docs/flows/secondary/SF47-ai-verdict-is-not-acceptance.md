# SF47 — Why an AI verdict is not an acceptance

**Where.** Clients → [client] → Delivery → Motion Design (v2) → Renders, and
`motion_candidate_due`
**Owner.** Creative lead. **Reviewed.** 25 October 2026. **Part of** MF07.

## The two QA passes
They catch different things, which is why they are separate columns:

| Pass | Catches |
|---|---|
| **Brand QA** | An off-palette frame, wrong type, wrong feel — a design problem |
| **Claim QA** | An unevidenced claim like "cheapest in Portsmouth" — a legal problem |

Both are AI verdicts. **Neither is a sign-off.** `accepted_by` is a person, and the gate is a
person judging the output good enough for a premium service business.

## Reading `motion_candidate_due`
It gives one sentence per candidate:

| Blocker | Meaning |
|---|---|
| *Still rendering, or the render failed* | No render yet |
| *A scene cites proof that is no longer usable. The cut is wrong whatever the QA says* | **Outranks both QA verdicts** |
| *Brand QA failed: …* | With the detail |
| *Claim QA failed: …* | With the detail |
| *QA has not run on this candidate yet* | Do not accept it yet |
| *A person rejected it: …* | With the reason |
| *Accepted.* | Done |
| (null) | QA passed and it is waiting for a person |

## The expensive case
A scene citing proof whose permission has gone: the cut is wrong and **nothing about the
render says so**. That is why scenes record their proof asset (SF46) and why this view checks
rights independently of the QA passes.

## Benchmark
**Benchmark** is where you record the same brief rendered elsewhere, so "a newer model" has
to show its work rather than being assumed better.

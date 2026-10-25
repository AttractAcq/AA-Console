# SF72 — Observed, estimated and unknown: never conflate them

**Where.** Clients → [client] → Delivery → Attribution OS
**Owner.** Marketing Director. **Reviewed.** 25 October 2026. **Part of** MF13.

## The one rule
These three are reported **separately, always**. Never present an estimate as a measurement.

| Class | Meaning |
|---|---|
| **Observed** | We measured it. A click ID, a form submission, a recorded sale |
| **Estimated** | We inferred it from a model or a partial join |
| **Unknown** | We do not know. Saying so is the honest answer |

## Why it matters commercially
A client who is shown an estimate as a fact and later discovers it will stop believing the
observed numbers too. Reporting `unknown` honestly is what makes the observed figures
credible.

## The confusions this prevents
| Wrong | Right |
|---|---|
| A post went out, so it reached people | Publication is not reach |
| Reach, so leads | Reach is not a lead |
| A lead, so a sale | A lead is not a sale |
| A sale, so revenue | A sale is not `cash` (SF69) |

Each of those has its own column precisely so nobody has to make the mistake.

## Before drawing any conclusion
Read `metrics_coverage` (SF74). A quiet week may be an ingestion gap, not a performance
problem, and that distinction is the difference between a good and a bad decision.

## Gotcha
DM-sourced leads have no content lineage at all (**G01**), and hand-bound Google campaigns
depend on someone having bound the IDs (**G03**). Both legitimately produce `unknown`. Report
it rather than filling the gap with a guess.

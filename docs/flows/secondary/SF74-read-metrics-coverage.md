# SF74 — Read metrics coverage and explain a gap

**Where.** `metrics_coverage`, Attribution OS
**Owner.** Marketing Director. **Reviewed.** 25 October 2026. **Part of** MF13.

## Read this before any other number
Coverage says what has and has not been ingested, per surface and period. It is the first
thing to read in MF13 and the most frequently skipped.

## The question it answers
"Is this week quiet because nothing happened, or because nothing was collected?"

Those two look identical on a chart and lead to opposite decisions — one says change the
creative, the other says fix a token.

## What to do with a gap
1. Identify the surface and period.
2. Find the cause: dead credential (SF05), integration connected late, ingestion off, runtime
   down.
3. Request a backfill (SF73).
4. If it cannot be backfilled, **label the period** in the commentary (SF75). A gap that is
   explained is fine; a gap that is silently averaged over is not.

## Gotcha
Commentary agents read the figures, not the coverage. They will describe a gap as a decline
unless you tell them otherwise — which is why SF75 says to edit the commentary.

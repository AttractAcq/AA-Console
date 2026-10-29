# SF73 — Request a metrics backfill

**Where.** Attribution OS, metrics ingestion controls
**Owner.** Marketing Director. **Reviewed.** 25 October 2026. **Part of** MF13.

## When
`metrics_coverage` shows a period with no data (SF74), usually because:
- A credential was dead for a while (SF05)
- An integration was connected after the campaign started
- Ingestion was off for that surface or provider
- The runtime was down

## Do it
Request a backfill for the surface and the period. Ingestion is per **surface**
(`paid`, `organic`, `landing`, `offer`) and per provider, so request the one that is actually
missing rather than everything.

`metrics_pulls` shows what ran and when.

## Before you report on the backfilled period
Re-read coverage. A backfill can be partial — a platform may not serve data that old, or may
serve it at a coarser grain. Partial is `estimated` or `unknown`, not `observed` (SF72).

## Gotcha
**A missing figure is not a zero.** The system keeps that distinction deliberately. If a
period shows nothing, do not let a chart or a commentary turn it into "no leads that week"
until you have checked whether anyone was looking.

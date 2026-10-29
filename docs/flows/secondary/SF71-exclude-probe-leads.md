# SF71 — Exclude probe leads from the real pipeline

**Where.** Sales OS → Pipeline, `client_leads.is_probe`
**Owner.** Client manager. **Reviewed.** 25 October 2026. **Part of** MF11, MF12, MF13.

## Why probe leads exist at all
MF11's form probe (SF60) posts a real submission to the live endpoint and requires a real
lead back. It has to be a **real row** in `client_leads`, or the probe would be testing a
path a customer never takes — which would defeat the point.

So probe leads are real in every respect except one: they are marked `is_probe`.

## Do it
Exclude them wherever you are counting:
- The pipeline board and its counts
- Any lead number reported to a client
- Cost-per-lead in the economics

There is an index specifically for the real-leads-only read, so excluding them is the normal
path, not a workaround.

## Gotcha
If pipeline counts look slightly high, or a client asks who "AA Console Probe" is, this is
why. Do not delete probe leads — they are the evidence that the form works. Filter them.

## Related
A failed probe does not unpublish the page (SF60). A page can be live, probed, failing, and
still have a probe lead row explaining what happened.

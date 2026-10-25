# SF11 — Take an intelligence snapshot for a campaign

**Where.** Intelligence OS, and the campaign's `intelligence` manifest item
**Owner.** Marketing Director. **Reviewed.** 25 October 2026. **Part of** MF03, MF04, MF13.

## Why it is versioned
Intelligence changes. A campaign built in March against March's understanding should not
silently re-read June's, because then nobody can say what the campaign was actually built on,
and a campaign that worked cannot be reproduced.

So the campaign's `intelligence` manifest item is a **snapshot** — a frozen read of the
records at the moment the campaign was packaged.

## Do it
1. Finish correcting the intelligence records first (SF07). The snapshot captures what is
   there, including the mistakes.
2. The snapshot is taken as part of the campaign package; the manifest item shows it as
   satisfied.
3. For a new campaign after intelligence has moved on, take a fresh snapshot rather than
   reusing the old campaign's.

## Downstream
After a campaign runs, MF13 feeds results back into the intelligence records — and the next
campaign's snapshot picks that up. That is the learning loop: snapshots are how the loop has
discrete steps instead of drifting continuously.

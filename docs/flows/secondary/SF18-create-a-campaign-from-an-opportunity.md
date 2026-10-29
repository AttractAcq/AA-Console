# SF18 — Create a campaign from an approved opportunity

**Where.** Clients → [client] → Delivery → Market Opportunities → Activate
**Owner.** Marketing Director. **Reviewed.** 25 October 2026. **Part of** MF02, MF03, MF04, MF05.

## Before
The opportunity must be **`approved`**. Only an approved opportunity can create a campaign
(SF17 clears the way).

## Do it
1. **Approve** the opportunity.
2. **Choose an opportunity** → the approved one.
3. **Campaign name** → what it will be called in Meta too. Name it for a stranger reading an
   ad account later.
4. Mode: **organic** or **paid**. *A campaign is one or the other, for its whole life.*
5. For paid: *choose Meta Ads or Google Ads.*
6. **Create and plan** — creates the campaign and queues the planner.

## What you get
The campaign carries the opportunity as its origin, readable in `campaign_origins`. The
question "why does this campaign exist" now has an answer that is a record rather than
somebody's memory.

## Gotcha
**Mode is immutable.** Choosing wrong means cloning into a new campaign later (MF16), which
copies the brief and lineage but no creative, approvals, external IDs or results. Decide
properly here.

## Next
MF03 (organic) or MF04 (paid Meta) or MF05 (paid Google).

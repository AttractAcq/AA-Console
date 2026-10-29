# SF55 — Produce a Google Ads build sheet and read what is missing

**Where.** Clients → [client] → Delivery → Google Ads Studio → Build sheet
**Owner.** Marketing Director. **Reviewed.** 25 October 2026. **Part of** MF05.

## The one rule
**There is no Google Ads adapter.** This produces a specification a person builds by hand.
The **Automated build** tab says so: *The build a person does by hand.* That is gap **G03**.

## Do it
1. **Derive the sheet** (or **Derive again**).
2. Read it. It covers **Campaign**, **Budget**, **Geography**, **Conversion action**,
   **Destination** and **Search intent groups**.
3. Read what is missing. The panel says either *Everything it needs is here* or lists gaps.

## `keyword_research` is always listed as missing
Deliberately. The system never claims to have done keyword research, because it has not. Do
that work in Google's own tools and treat the intent groups as a starting structure, not a
finished keyword plan.

## Immutable and deduplicated
The sheet is immutable and deduplicated by hash: deriving again with no changes gives you the
same sheet rather than a second one. Change the campaign, then derive again.

## After the build
Record the external Google campaign ID against the operational campaign, or Attribution OS
has nothing to join spend to (MF13). Nothing does this for you here, because nothing created
the campaign.

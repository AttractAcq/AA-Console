# SF56 — Publish a Google Profile post

**Where.** Clients → [client] → Delivery → Google Profile → Posts
**Owner.** Client manager. **Reviewed.** 25 October 2026. **Part of** MF06.

## Why it matters
This is omnipresence (exit track X-f). A prospect searching the business before they buy sees
the profile, and a profile last posted to eight months ago reads worse than one with no posts
at all.

## Before
- The location is connected and has a credential (SF03)
- The proof being posted is cleared (SF25)
- `proof_publishing_enabled` is on if this is going out as a proof placement (SF06)

## Do it
Google Business Profile is a **supported** proof destination, so the normal path is:
1. Request a placement to `google_business_profile` (SF29)
2. Approve it (SF30)
3. It posts through the Business Profile API on the sweep

The transport handles posts, photos and review replies.

## Keep a cadence
Freshness is the measure here, not volume. A post a fortnight beats a burst of ten and then
silence.

## Gotcha
Posting works. **Changing the profile itself** — hours, description, categories — does not:
those changes are recorded and a person makes them in Google (**G05**).

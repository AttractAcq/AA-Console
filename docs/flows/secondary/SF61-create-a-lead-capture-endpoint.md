# SF61 — Create a lead capture endpoint and connect it to a campaign

**Where.** Clients → [client] → Delivery → Sales OS (v2) → Capture →
**Open a capture link**
**Owner.** Client manager. **Reviewed.** 25 October 2026. **Part of** MF11, MF12, MF14.

## The one rule
**Attribution is decided here and cannot be reconstructed later.** A lead captured by an
endpoint with no campaign is a lead nobody can attribute, forever.

## Do it
1. **Open a capture link** → **Choose what the link is for.**
2. **On which page** — bind it to the page it will live on.
3. **Attribute to campaign** — bind it to the campaign. Do this now.
4. **Consent** — the consent wording stored on every lead this endpoint creates. Write what
   the person actually agreed to; it is kept verbatim.
5. The token is shown **once** and stored only as a hash. **I have it** confirms you copied
   it. Lose it and you revoke and create another.

Optional: an expiry, and a maximum number of submissions. Use both for a campaign with a
known end date.

## Reading the Capture tab
Per lead: **Came from**, **Attributed to**, **Consent**, and **Came in without creating a
lead** for submissions that arrived but did not become one.
*"Nobody has arrived from outside yet"* means no external capture has happened at all.

## Refusals are deliberately silent to the public
A disabled, revoked, expired or over-limit endpoint returns one sentence:
*"This form is not accepting submissions."* It never explains which, because that would be a
probing tool for anyone on the internet.

## Troubleshooting
Read `lead_capture_due`. It names which of the conditions is closed.

# SF29 — Create a destination and request a placement

**Where.** Clients → [client] → Delivery → Proof Distribution → **Destinations**, then
**Placements**
**Owner.** Client manager. **Reviewed.** 25 October 2026. **Part of** MF06.

## Check the destination can actually take it
| Destination | Supported |
|---|---|
| `google_business_profile` | **yes** — posts, photos, review replies via API |
| `proposal_quotation` | **yes** — a proof pack in the document a salesperson sends |
| `third_party_directory` | **yes, manually** — payload rendered, person places it (SF31) |
| `main_website`, `campaign_landing_page`, `seo_geo_content` | no — **G09** |
| `email_sms_nurture` | no — **G02** |
| `organic_social`, `paid_advertising`, `sales_conversation` | no — **G10**, they execute elsewhere |

An unsupported destination is a row with a sentence saying why, not a silent failure. Read it.

## Do it
1. Pick the destination.
2. Request the placement against a **signed-off artifact version** (SF28).
3. It enters `drafted`, then `awaiting_approval`.

## The lifecycle
`drafted` → `awaiting_approval` → `approved` → `queued` → `placing` → `placed` → `verified`,
with `awaiting_manual_placement`, `failed`, `rejected` and `retraction_required` as the others.

## Next
SF30 to approve it.

# Conventions used by every memo

Read once. It makes every other memo shorter.

## How a click-path is written

> **Clients → [client] → Delivery → Campaign Factory → Campaigns**

Each arrow is a click. `[client]` means the client you are working on. A module with a
version switcher is written with the view in brackets:

> **Clients → [client] → Delivery → Website Studio (v2) → Publish**

The equivalent URL is
`/clients/<clientId>/delivery/website-studio?view=v2&tab=publish`. The first tab of any
module needs no `tab=` parameter. Intelligence OS uses `?view=intelligence` or
`?view=strategy` rather than v1/v2.

Modules with a **v2** view: Campaign Factory, Proof Production Factory, Content Production
Factory, Offer Studio, Website Studio, Meta Ads Studio, Meta Profile, Sales OS, Motion
Design. Everything else has one view.

## The one rule that applies to all of them

**Internal work may run automatically. Every external action needs a human to approve the
exact version, destination and scope.** Research, production, revision, QA and testing are
internal. Publishing, deploying a page, creating ad objects, sending anything to a person,
and changing spend are external.

Internal QA passing is **not** approval. An AI verdict is never an acceptance.

## The four switches

Nothing reaches the outside world unless all four are true:

1. **The runtime flag** — set in Railway, not in the console.
2. **The per-client switch** — on `client_engine_settings`, five of them:

| Switch | Governs |
|---|---|
| `enabled` | the organic content engine runs at all |
| `publishing_enabled` | approved organic posts actually publish |
| `proof_publishing_enabled` | approved proof placements actually place |
| `campaign_actions_enabled` | page deploys, Meta builds and proof releases execute |
| `lead_magnet_delivery_enabled` | magnets are actually delivered to opt-ins |

3. **The per-destination support flag** — some destinations and actions have no adapter.
   They are rows in `campaign_action_executors` and `proof_destinations`, with a sentence
   saying why. A missing adapter is visible, never silent.
4. **The human decision** on that exact version.

**All five client switches are currently off for every client.** A memo that ends "it goes
out on the next sweep" means exactly that and nothing more until someone turns the switch on.

## How to read a `_due` view — the universal troubleshooting step

Every stage of delivery has a view whose job is to say, in one sentence, why the thing has
not happened. When a memo's step does not do what it says, read that module's `_due` view
before anything else.

| Module | View |
|---|---|
| Campaign actions (all external) | `campaign_action_due` |
| Organic distribution | `distribution_due`, `publish_due` |
| Proof placement | `proof_placement_due` |
| Page publication | `campaign_page_publish_due` |
| Lead capture | `lead_capture_due` |
| Lead magnets | `lead_magnet_due` |
| Meta ad build | `meta_build_due` |
| Google Ads sheet | `google_ads_sheet_due` |
| Google Business Profile | `google_profile_due` |
| Motion renders | `motion_candidate_due` |
| Opportunities | `opportunity_readiness` |
| Offers | `offer_version_drift`, `offer_claim_evidence` |
| Metrics | `metrics_coverage` |
| Integrations | `integration_health` |

Most modules surface their own `_due` view as the "What is stopping it" column on the page,
so you rarely need the database. When you do, Admin and the MCP read paths can query it.

## Vocabulary

**Audience state** — S0 stranger, S1 watcher, S2 owned (a follower), S3 identified,
S4 in conversation, S5 customer, S6 lapsed.

**Mode** — a campaign is **organic** or **paid**, for its whole life, never both. To run the
same idea the other way, clone it; the clone keeps lineage and copies no approvals, no
creative and no results.

**Template** — one of sixteen codes (P1–P5, R1–R4, C1–C3, O1–O2, X1–X2). Each moves one
audience state to another. The full matrix is in the map.

**Proof rights** — `not_cleared` by default, then `restricted` or `approved`. Nothing
derived from proof can go out while its source is uncleared or expired.

**Observed, estimated, unknown** — reporting keeps these separate. Never present an
estimate as a measurement, and never read a publication as a commercial result.

# SF79 — Read any `_due` view as a troubleshooting tool

**Where.** Most modules surface theirs as a "What is stopping it" column
**Owner.** Anyone. **Reviewed.** 25 October 2026. **Part of** every flow.

## The idea
Every stage of delivery has a view whose only job is to say, in one sentence, why the thing
has not happened. **When a step does not do what the memo says, read that module's `_due`
view before anything else.**

This is the single most useful habit in the console.

## The map
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

## How to read one
The sentence is the answer. It names which of the four conditions is closed — the runtime
flag, the client switch, the destination's support, or the human decision.

A **null** blocker means nothing is stopping it: it is waiting for a sweep, or for a person.

## Why they are phrased as sentences
So that the answer does not require knowing the schema. *"External campaign actions are off
for this client."* is actionable by whoever reads it.

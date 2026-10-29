# SF78 — Read the Approval Inbox end to end

**Where.** Clients → [client] → Delivery → Approval Inbox
**Owner.** Client manager and Marketing Director. **Reviewed.** 25 October 2026.
**Part of** every external flow.

## Three queues, three different acts
| Tab | Approving does | Owner |
|---|---|---|
| **Engine** | Signs content off **and** puts the post on the calendar (slot → `scheduled`) | SMM / client manager |
| **Assets** | Signs an asset off. Schedules nothing | Creative lead |
| **Campaign actions** | Authorises an **external** action on an exact version | Marketing Director |

## Campaign actions — what arrives here
| Action | Flow |
|---|---|
| `page_deploy` | Publish a page (SF58, SF59) |
| `meta_ad_build` | Build paused Meta objects (SF54) |
| `proof_publish` | Release proof placements (SF30) |

Unsupported actions exist as rows with a sentence saying why, so a missing adapter is visible
rather than silent: `google_ad_build`, `lead_message`, `profile_update`, `budget_change`,
`organic_publish`, `campaign_launch`.

## What a reviewer is actually agreeing to
**The exact version, destination, action and scope.** Approval cannot be reused for changed
copy, creative, page, audience or budget — change any of them and the request must be made
again. Read the snapshot, not a preview.

Reject with **Reason to reject**. The reason is what the requester needs.

## Why this is one page
Before it, each module had its own approvals and nobody could answer "what is waiting on a
person for this client". This is that answer.

## Gotcha
Approving here is not the last condition. `campaign_actions_enabled` must also be on, the
destination must have an adapter, and the sweep must run (see [`../CONVENTIONS.md`](../CONVENTIONS.md)).

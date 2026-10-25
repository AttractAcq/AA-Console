# SF67 — Approve and deploy a sales agent widget

**Where.** Clients → [client] → Delivery → Sales OS (v2) → Agents
**Owner.** Client manager. **Reviewed.** 25 October 2026. **Part of** MF12, MF16.

## Approve it
**Approve for public use** → *"Approved for public use."* Until then it reads
*"Not approved for public use"* and will not talk to anybody.

**Revoke approval** takes it down. That is also the fastest way to stop an agent that is
saying the wrong thing.

## Deploy it
The agent is a widget on a page. Set:

| Setting | Why it matters |
|---|---|
| **Page it lives on** | *"Not attached to a page yet"* means built but live nowhere |
| Allowed origin | The widget only answers from this origin. Wrong origin, no conversation |
| Daily message limit | Caps how much it can talk in a day |
| Daily cost limit | Caps what it can spend in a day |

Set both limits. They are the difference between an agent having a bad day and an agent
having an expensive bad day.

## Reading its state
| State | Meaning |
|---|---|
| *Not approved for public use* | Built, not approved |
| *Not attached to a page yet* | Approved, not deployed |
| *Live, but has not spoken to anyone yet* | Healthy, waiting for traffic |
| *No conversations yet* | Same, from the conversation list |

## Troubleshooting
| Symptom | Cause |
|---|---|
| Not answering | Not approved, or not attached to a page |
| Stopped mid-day | A daily message or cost limit was reached |
| Answers on staging but not live | The allowed origin |
| Refuses to mention a result | The proof behind it is uncleared (SF25). Correct behaviour |

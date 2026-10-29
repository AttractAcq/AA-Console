# SF77 — Trace one customer back to the content that caused them

**Where.** Clients → [client] → Delivery → Attribution OS → Attribution
**Owner.** Marketing Director. **Reviewed.** 25 October 2026. **Part of** MF10, MF12, MF13.

## Why do this
It is the most convincing thing you can show a client, and the fastest way to find a break in
the instrumentation. Do it for one real customer every reporting cycle.

## The chain
**From the idea** → **Hook** → **Asset** → **Leads** → **Conversations** →
**Appointments** → **Sales** → **Cash**

That chain exists because:
- The lead carried `source_client_campaign_id`, `source_click_id` and `source_utm` from
  capture (SF61)
- The asset carries lineage back to its brief and its idea (SF34)
- The idea carries its campaign and pillar (SF33)
- Derivatives carry their source (SF43)

## Where it breaks, and what each break means
| Break | Cause | Fix for next time |
|---|---|---|
| Lead with no campaign | Capture endpoint not attributed | SF61, before traffic |
| Lead with no asset | Came from a surface with no lineage — usually a DM | **G01** |
| Sale with no lead | Recorded by hand with no lead row | SF68 |
| Cash with no sale | `cash` set without `sale` | SF69 |
| Asset with no idea | Produced outside the ideation path | Brief it properly (SF34) |

## Gotcha
You cannot repair a broken chain retrospectively — the data was never captured. What you can
do is fix the cause so next month's customers are traceable. That is why MF11's probe (SF60)
matters so much: it checks the chain's first link before any real traffic arrives.

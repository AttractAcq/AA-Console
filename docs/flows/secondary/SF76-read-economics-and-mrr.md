# SF76 — Read economics and MRR

**Where.** Clients → [client] → Delivery → Attribution OS → Economics
**Owner.** Marketing Director. **Reviewed.** 25 October 2026. **Part of** MF13.

## The figures
| Figure | Meaning |
|---|---|
| **Ad spend tracker** | Spend by **Channel** and **Amount**. The legacy tracker is kept and labelled *(legacy)* |
| **Leads acquired** / **Cost each** | Volume and efficiency |
| **Appointments** / **Qualified** / **Customers** | The pipeline in numbers |
| **Cash collected** | What actually arrived |
| **Cash ROAS** | **Cash ÷ spend** |
| **Cohort economics** | By cohort — the right way to read a service business |

MRR comes from billing (`mrr_from_billing`), which is AA's own revenue from the client, not
the client's revenue. Do not mix them in one report.

## Why two spend tables exist
The operational campaign (`client_campaigns`) is the **plan**; the older spend tracker
(`campaigns`) is the **money**. They are bridged by external campaign IDs. For Google, where
nothing is created by the system, you bind those IDs by hand or the join does not exist
(SF55).

## The number worth arguing about
**Cash ROAS.** Leads and cost-per-lead are inputs. A campaign with cheap leads and no cash is
a failure that looks like a success for about six weeks — long enough to scale it.

## Read it by cohort
A service business often has a long gap between lead and cash. Looking at this month's spend
against this month's cash understates a campaign that is working and overstates one that is
coasting on last quarter's pipeline.

# MF13 — Attribution and the learning loop

**Flow.** MF13 · main · Measure
**Purpose.** Say what actually happened, separate what we measured from what we estimated,
and feed the result back into intelligence so the next campaign is better informed.
**Scope.** Attribution OS, and the write-back to Market Opportunities and Intelligence OS.
**Owner.** Marketing Director.
**Last reviewed.** 25 October 2026.
**Entry.** A campaign has been running (MF03, MF04, MF05).
**Exit.** Opportunity confidence moved on evidence, and a report a client can be shown.

**Composes:** SF15, SF72–SF77.

---

## The one rule

**Observed, estimated and unknown are reported separately, always.** Never present an
estimate as a measurement, and never read a publication as a commercial result. A post that
went out is not a lead; a lead is not a sale; a sale is not cash. Each of those confusions
has its own column in this module precisely so nobody has to make the mistake.

---

## Stage 1 — Make sure there is anything to read

**Clients → [client] → Delivery → Attribution OS**

| Tab | Shows |
|---|---|
| **Attribution** | The chain from content to cash |
| **Organic** | Organic surface metrics |
| **Paid** | Paid surface metrics |
| **Landing Pages** / **Offer Pages** | Page performance |
| **Commentary** | The written read |
| **Economics** | Spend against cash |

Before reading anything, read **coverage** (SF74). `metrics_coverage` says what has and has
not been ingested. A quiet week may be an ingestion gap rather than a performance problem,
and that distinction is the difference between a good decision and a bad one.

If a period is missing, request a backfill (SF73). Metrics come in by ingestion per surface
and provider; `metrics_pulls` shows what ran.

---

## Stage 2 — Read the chain

**Attribution OS → Attribution**

The chain is **From the idea** → **Hook** → **Asset** → **Leads** → **Conversations** →
**Appointments** → **Sales** → **Cash**.

This is the payoff of everything upstream: the lead carried `source_client_campaign_id`,
`source_click_id` and `source_utm` from capture, the asset carries lineage back to its brief
and idea, and the idea carries its campaign and pillar. Trace one customer end to end (SF77)
— it is the most convincing thing you can show a client, and the fastest way to find a break
in the instrumentation.

**Where the chain breaks, and what it means:**

| Break | Cause |
|---|---|
| Leads with no campaign | Capture endpoint not attributed (SF61) |
| Leads with no asset | Came from a surface with no content lineage — usually a DM (G01) |
| Sales with no leads | Recorded by hand without a lead row |
| Cash with no sale | `cash` set without `sale` |

---

## Stage 3 — Join the money

**Attribution OS → Economics**

| Figure | Meaning |
|---|---|
| **Ad spend tracker** | Spend, by channel. The legacy tracker is kept and labelled |
| **Leads acquired** / **Cost each** | Volume and efficiency |
| **Appointments**, **Qualified**, **Customers** | The pipeline in numbers |
| **Cash collected** | What actually arrived |
| **Cash ROAS** | **Cash ÷ spend** |
| **Cohort economics** | By cohort, which is how a service business should read this |

Two tables exist for spend on purpose: the operational campaign (`client_campaigns`) is the
plan, and the older spend tracker (`campaigns`) is the money. They are bridged by external
campaign IDs. For Google, where nothing is created by the system (MF05), you bind those IDs
by hand or the join does not exist.

**Cash ROAS is the number worth arguing about.** Leads and cost-per-lead are inputs; cash is
the outcome. A campaign with cheap leads and no cash is a failure that looks like a success
for about six weeks.

---

## Stage 4 — Write the read

**Attribution OS → Commentary** — **Reporting Commentary** generates the written read from
the figures (SF75).

Read and edit it. The commentary agent can only describe what the numbers say; it cannot know
that the client paused their phones for a week. Add that.

**Never let commentary launder an estimate into a fact.** If coverage is partial, the
commentary must say so.

---

## Stage 5 — Feed it back

This is the stage that makes it a loop rather than a report.

1. **Move the opportunity's confidence on evidence** (SF15):
   **Delivery → Market Opportunities → Evaluate**. A niche that produced cash moves toward
   `first_party` and then `proven`. A niche that produced nothing is evidence too — record it
   rather than quietly retrying it next quarter.
2. **Move the opportunity's status**: `active` → `learning` → `scaling`, or `paused`.
   `scaling` should mean cash, not optimism.
3. **Take an intelligence snapshot** for the next campaign (SF11) so the next build reads
   what we now know rather than what we assumed.
4. **Record the objections** that came back as `lost` reasons in MF12. They are the briefs
   for R2 campaigns.
5. **Retire what did not work.** Archive the campaign (SF82, MF16) so the board shows live
   work.

---

## Troubleshooting

| Symptom | Read this |
|---|---|
| Numbers look empty | `metrics_coverage` (SF74), then request a backfill (SF73) |
| Paid spend not matching | The external campaign ID is not bound to the operational campaign |
| ROAS impossible | `sale` without `cash`, or spend on the wrong channel |
| Organic metrics missing | The platform's token may be dead (`integration_health`, SF05) |
| A customer cannot be traced | Follow the break table in stage 2 |
| Commentary overclaims | Edit it. The agent cannot see coverage gaps as caveats |

---

## Where this stops today

Attribution is the most complete module in the system for organic and Meta paid. The honest
weak points: Google paid attribution depends on hand-bound IDs (**G03**), DM-sourced leads
have no content lineage at all (**G01**), and proof-derived ads are not recorded as proof
placements (**G10**), so "which proof sold this" is weaker than "which asset sold this".

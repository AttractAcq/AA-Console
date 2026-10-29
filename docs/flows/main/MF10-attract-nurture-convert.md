# MF10 — Attract, nurture and convert for one micro-niche

**Flow.** MF10 · main · spans all three layers
**Purpose.** Take one micro-niche from strangers who have never heard of the client to a
paying customer, and be able to say which piece of content caused the sale.
**Scope.** The whole delivery. Organic and paid together, because the two halves of this
journey are two campaigns, not one.
**Owner.** Marketing Director.
**Last reviewed.** 25 October 2026.
**Entry.** An approved opportunity with an awareness journey (MF02).
**Exit.** `client_leads.stage = cash`, attributable to a content piece.

**Composes:** MF02 → MF03 → MF06 → MF07/MF08 → MF09 → MF11 → MF12 → MF13.
Secondary: SF16, SF18, SF23–SF32, SF33–SF42, SF49–SF52, SF57–SF65, SF66–SF71, SF77.

---

## The one rule

**This journey is at least two campaigns, and they are separate records.** The attract half
is a paid P1 campaign whose only job is to buy followers. The convert half is a different
campaign — R1 or O1 — that spends against the pool P1 built. A campaign has exactly one mode
for its whole life. If you try to run attract and convert as one campaign you will get a
campaign that cannot be reported on, cannot be cloned, and whose readiness never resolves.

The nurture layer in the middle is **not a campaign at all.** It is the content engine, the
proof factory and the profile, running continuously for the client. It is what makes the
convert campaign cheap.

---

## The shape of the journey

| Stage | What moves | Audience state | Mechanism |
|---|---|---|---|
| 1 | Nothing yet — the niche is chosen | — | MF02, already done |
| 2 | Stranger sees an ad, visits the profile, follows | S0 → S2 | **P1** paid campaign |
| 3 | Follower watches, and starts to trust | S2 | Content engine + proof + profile |
| 4 | Follower identifies themselves | S2 → S3 | **R1** or **O1**, to a page or a DM |
| 5 | Lead has a conversation | S3 → S4 | Sales agent, then a person |
| 6 | Lead buys | S4 → S5 | A human closes |
| 7 | We learn which content did it | — | Attribution OS |

**Where this journey is honest about itself:** stages 5 and 6 are substantially manual
today. See *Where this stops* at the end before you promise a client otherwise.

---

## Before you start — the gates for the whole journey

1. **MF01 is done.** Business context written, brand profile set, Meta connected with a
   System User token, a Facebook page ID and a pixel. Without a pixel, R1 and O1 cannot
   build at all — only P5 and O2 can. Check **Clients → [client] → Account → Integrations
   & Credentials** reads `connected`.
2. **MF02 is done.** An opportunity at status `approved`, with an awareness journey. Read
   **Clients → [client] → Delivery → Market Opportunities → Activate** and confirm the
   opportunity has no blocker.
3. **An offer version is signed off** (SF19, SF20). Everything downstream freezes a version,
   so a campaign built against an unsigned offer carries unapproved copy.
4. **Decide the two campaign names now.** They will appear in Meta. Name them so the pair
   is obvious, e.g. `Garage conversions — P1 follow` and `Garage conversions — R1 convert`.

---

## Stage 2 — Attract: buy the followers (P1)

This is MF04 run with template P1. The short version:

**Clients → [client] → Delivery → Market Opportunities → Activate**

1. **Choose an opportunity** → the approved one.
2. **Campaign name** → the P1 name you decided.
3. Mode → **paid**, platform → **Meta Ads**. A campaign is one or the other, for its whole life.
4. **Create and plan.**

Then **Clients → [client] → Delivery → Campaign Factory → Campaigns → [the campaign]**:

5. **Edit campaign** → set **Campaign template** to **P1**. This is the decision that makes
   the rest of the journey work: P1 optimises for `PROFILE_VISIT` and its destination is the
   profile, so it exits at S2 — a follower, a channel owned for free, forever.
6. Read **Readiness and blockers**. Work the manifest spine in dependency order: intelligence,
   then offer and proof, then creative. Each item names the module that owns it.
7. Creative for P1 is awareness-level content for the **first** awareness stage of the
   journey — the mindset of someone who does not yet know the problem has a name. Produce it
   with MF07 (AI) or MF08 (people). The awareness journey from MF02 is what the brief points at.
8. When the package is complete, ask for the build: **Meta Ads Studio (v2) → Build →
   Ask for approval**, then approve it, then it builds on the next sweep. Objects are created
   **paused**. Nothing in AA Console can make an ad live.
9. Launch in Ads Manager yourself, deliberately. See SF54 for the full Meta memo.

**What success looks like at this stage.** Followers arriving. Not leads — followers. P1
produces `stage = profile_visit` and `follower` rows in Sales OS, and those are the pool
stage 4 spends against. Judging P1 by leads is the most common way to kill the campaign that
was working.

---

## Stage 3 — Nurture: earn the trust (the part that is not a campaign)

This is the most important stage and the one with no single button. Three things run at once.

### 3a. Standing organic content — MF09

**Clients → [client] → Delivery → Organic Content Distribution → Engine**

Set the engine going so content ships on a rhythm rather than in bursts: plan horizon,
format mix, approval mode, minimum QA score (SF51). The engine plans slots, picks ideas,
briefs them, builds them, QAs them, and stops at **one** human gate per post.

The content here is not the ad. It is the authority and authenticity material: process,
team expertise, results, the client's own voice. Content pillars (SF09) are what keep it
coherent rather than random.

### 3b. Proof — MF06

Proof is what converts a watcher into someone who believes. Run MF06 in parallel from the
day P1 starts, because proof takes real-world time to collect:

- Capture real proof with source and evidence (SF23), or collect it from customers with a
  capture link (SF24).
- Set rights and expiry (SF25). `not_cleared` is the default and it refuses everything
  downstream — this is deliberate.
- Turn proof into artifacts (SF27) and place it where a buyer will look (SF29, SF30).

### 3c. The profile itself

A prospect who follows will look at the profile, and will search the business before buying.

- **Meta Profile (v2) → Identities / Profile / Presence** — confirm the identity is connected
  and the profile reads as a real business (SF-level detail in MF06).
- **Google Profile → Location / Reviews / Posts** — connect the location (SF03), reply to
  reviews (SF26 captures them as proof), publish posts (SF56).

**How long stage 3 takes.** R1 cannot run until P1 has been going **14 days or more** — that
is the template's own prerequisite, and it exists because retargeting an empty pool spends
money on nobody. Plan the nurture layer to fill that fortnight.

---

## Stage 4 — Convert: let them identify themselves (R1 or O1)

A second campaign, cloned or created fresh, in paid mode.

**Which template:**

| Situation | Template | Entry → Exit |
|---|---|---|
| The pool has been warmed and you want the next step | **R1** | S1 → S3 |
| There is a real offer with a real end date | **O1** | S2 → S5 |
| Leads exist who did not convert | **R2** | S3 → S5 |
| They got most of the way and stopped, and a pixel saw it | **R3** | S3 → S4 |

For the flagship, use **R1**. Its destination is a page, which means **MF11 must be done
first** — the page has to exist, be approved, be published, and have a probed form. A
published page whose form posts nowhere looks identical to a working one from the outside,
and it is the single most expensive failure in this journey.

1. Build the conversion path: MF11. Do not skip the probe
   (**Website Studio (v2) → Publish** → the row must read **Live and tested.**, not
   **Published. Nobody has tested the form yet.**).
2. Create the R1 campaign and set its template. If you are reusing the P1 creative concept,
   **Clone campaign into a new route** from the P1 campaign — the clone keeps lineage and
   copies no approvals, creative, results or external IDs.
3. Creative for R1 answers the awareness stage *after* the one P1 addressed. This is what the
   awareness journey is for: one stage per ad, sequenced.
4. Build and approve as in stage 2, launch in Ads Manager.

**The faster routes.** If the niche is already solution-aware, you do not need this whole
journey. P2 (instant form), P3 (DM) and P5 (lead magnet) all jump S0 → S3 directly. P5 needs
a magnet and the page that gates it (MF11, SF62–SF64). Use the awareness journey to decide;
running the long path on a most-aware niche wastes the fortnight.

---

## Stage 5 — The conversation

A lead has arrived in **Sales OS (v2) → Pipeline** with its campaign, its source and its
consent. Two destinations are possible and they are not equally built.

### To a website: the sales agent (built)

The sales agent is a widget on the client's page. Build it (SF66), approve it, deploy it with
an allowed origin and daily message and cost limits (SF67). It qualifies against its
`qualification` rules, handles objections, and books when its `booking_rule` says to.

### To a DM: not built — see G01

P3's destination is `message`, and there is **no DM path in the system at all**: no webhook
ingestion, no Instagram or Messenger adapter, no DM conversation record. If you run a DM
campaign, a person monitors the inbox and records the lead by hand in Sales OS (SF68).

---

## Stage 6 — The close

A human closes. The console records, it does not sell.

**Clients → [client] → Delivery → Sales OS (v2) → Pipeline** — move the lead through
`appointment` → `qualified_appointment` → `shown` → `sale` → `cash` (SF68, SF69).

**The booking is manual — see G04.** `booking_rule` is prompt text telling the agent when to
offer a booking. No calendar is connected and nothing creates an appointment row, so whoever
owns the client sets the stage by hand after the call is in the diary.

---

## Stage 7 — Learn which content did it

**Clients → [client] → Delivery → Attribution OS → Attribution**

1. Trace the customer back (SF77). The lead carries `source_client_campaign_id`,
   `source_click_id` and `source_utm` from capture, which is why MF11's probe matters: a form
   that drops those fields produces leads nobody can attribute.
2. Read observed, estimated and unknown **separately** (SF72). Never report an estimate as a
   measurement.
3. Feed it back: raise or lower the opportunity's confidence on the evidence (SF15). An
   opportunity that produced cash moves toward `proven`; one that produced nothing is
   evidence too.
4. Read `metrics_coverage` (SF74) before drawing conclusions from a quiet week — the gap may
   be an ingestion gap, not a performance one.

---

## Troubleshooting

| Symptom | Read this first |
|---|---|
| Nothing builds in Meta | `meta_build_due`, then **Meta Ads Studio (v2) → Build → What is stopping it** |
| The campaign says ready but nothing happened | `campaign_action_due`. Most likely `campaign_actions_enabled` is off |
| The page is live but no leads | **Website Studio (v2) → Publish**. If it says *Nobody has tested the form yet*, run the probe (SF60) |
| Leads arrive with no campaign | The capture endpoint has no campaign bound (SF61) |
| R1 is refused | P1 or P4 has not been running 14 days, or there is no pixel on the integration |
| Only P5 and O2 are selectable | No pixel on the Meta integration (SF02) |
| Proof will not place | Rights are `not_cleared` or expired (SF25), or `proof_publishing_enabled` is off |
| Posts never publish | `publishing_enabled` is off, or the post never got its human gate (SF42) |

---

## Where this stops today

This journey is complete and honest up to the end of stage 4. Past that it hands to people
more than the pitch implies. Before promising a client the full automated loop, know:

- **G01 — no DM path.** P3 and the "prospect goes to a DM" half of stage 5 have no system
  behind them. A person watches the inbox.
- **G02 — no governed outbound send.** There is no way to send a nurture message, an
  objection sequence or a follow-up to a specific lead. Nurture is broadcast only.
- **G04 — no booking integration.** The agent can say it is booking; nothing books.
- **G06 — awareness stage to template mapping is tribal.** Stages 2 and 4 both ask "which of
  the sixteen for this awareness level", and nothing in the system answers it. The awareness
  journey is free text and the templates carry audience states; nothing joins them.
- **G11 — no per-lead nurture.** Once someone is S3 and did not buy, only a new campaign
  reaches them.

Each is listed with its severity in [`../../core-delivery-flows-map.md`](../../core-delivery-flows-map.md).

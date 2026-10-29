# Core Delivery Flows — the map

**Status.** Built. All 16 main flows and all 82 secondary flows are written, in
[`flows/`](flows/) — start at [`flows/README.md`](flows/README.md). This document remains the
rationale: why the set is shaped this way, and the twelve gaps.
**Date.** 25 October 2026.
**Purpose.** AA Console's own service — the Client Acquisition System — delivered by a
person following a document, repeatably, with nothing important left to memory.

---

## 1. What the service actually is, in the system's own words

We run intelligence on a client's business, connect their APIs, find the micro-niches
worth attacking, and build a campaign per micro-niche that **attracts**, **nurtures**
and **converts**. Content is produced by AI or by people. Every outcome is attributed
back to the piece of content that caused it.

The console already carries that model in its data, and the memos must use its
vocabulary rather than invent a parallel one. Three things in the schema are the spine:

**Audience states.** Every prospect sits in one of seven states, and a campaign's job
is to move them one step.

| State | Meaning | Funnel layer |
|---|---|---|
| S0 | Stranger — has never met the business | Attract |
| S1 | Watcher — has seen something, owns nothing | Attract → Nurture |
| S2 | Owned — a channel we can reach for free, forever (a follower) | Nurture |
| S3 | Identified — we have contact details | Nurture → Convert |
| S4 | In conversation | Convert |
| S5 | Customer | Convert / expand |
| S6 | Lapsed | Re-convert |

**The sixteen templates.** The paid campaign matrix. Each has a `fn` (build pools,
spend against pools, or learn), an entry and exit state, an optimisation event, a
destination and a prerequisite. This is the "16 different types" — it is already in
`src/lib/campaignTemplates.ts` and on every campaign row as `template`.

| Code | Name | fn | Entry → Exit | Destination | Prerequisite |
|---|---|---|---|---|---|
| P1 | Prospect to follow | build | S0 → S2 | profile | — |
| P2 | Prospect to direct lead | build | S0 → S3 | instant form | — |
| P3 | Prospect to DM | build | S0 → S3 | message | — |
| P4 | Attention prime | build | S0 → S1 | none | — |
| P5 | Lead magnet | build | S0 → S3 | page | A magnet and the page that gates it |
| R1 | Retarget to next step | spend | S1 → S3 | page | P1 or P4 running 14 days+ |
| R2 | Objection answering | spend | S3 → S5 | page | Leads that did not convert |
| R3 | Abandon recovery | spend | S3 → S4 | page | A pixel recording the step they left |
| R4 | Proof seeding | build | S1 → S1 | post | A post worth seeding |
| C1 | Customer expansion | spend | S5 → S5 | page | A customer list |
| C2 | Reactivation | spend | S6 → S5 | page | A lapsed customer list |
| C3 | Referral | build | S5 → S0 | page | A customer list and something worth referring |
| O1 | Promotional | spend | S2 → S5 | page | A real offer with a real end date |
| O2 | Event or webinar | build | S0 → S3 | page | A date |
| X1 | Lookalike scale | spend | S0 → S3 | page | A seed of 100+ |
| X2 | Test | learn | S0 → S0 | page | — |

**Attract, nurture and convert are not three stages of one pipeline.** They are three
*functions*, and the templates tell you which is which. `fn = build` buys pools
(attract). The nurture layer is largely unpaid — organic content, proof and profile —
and it is what makes the `spend` templates cheap. `fn = spend` harvests (convert).
This is why the delivery is **not linear**: P2, P3 and P5 jump S0 straight to S3 and
skip the nurture layer entirely, while R2 and C2 start from states that only exist
because something earlier worked.

**The flagship journey Alex described** — ad → Instagram profile → trust → DM or
website → booked call → human close — is specifically **P1 into the nurture layer into
a convert template**. It is the longest path through the system and therefore the one
that exercises the most modules. It is MF10 below.

---

## 2. The shape of the delivery: entry tracks and exit tracks

A memo set that assumes one start and one end would be wrong. There are six ways
delivery starts and six ways it realises value.

### Entry tracks

| # | Starts when | First flow |
|---|---|---|
| E1 | A new client signs | MF01 Client activation |
| E2 | Intelligence surfaces a micro-niche worth attacking | MF02 Opportunity to activation |
| E3 | The client changes or reprices an offer | MF15 Offer version change |
| E4 | Real proof arrives unprompted (a review, a result) | MF06 Proof to omnipresence |
| E5 | Someone asks for one asset, outside any campaign | MF07 / MF08 content production |
| E6 | AA hires for itself (separate `content_purpose = recruitment`) | MF14 Recruitment |

### Exit tracks

| # | Value realised as | Terminal record |
|---|---|---|
| X-a | A follower — a free channel owned forever (S2) | `client_leads.stage = follower` |
| X-b | An identified lead (S3) via form, DM or magnet | `client_leads` with consent + source |
| X-c | A booked call closed by a human → sale → cash | `lead_stage = sale`, then `cash` |
| X-d | An existing customer expanded, reactivated or referring | C1 / C2 / C3 campaigns |
| X-e | Information only — a test that taught us something | X2, `opportunity_confidence` rises |
| X-f | Omnipresence — the trust surface a prospect checks before buying | Proof placements, Google Profile |

X-f deserves emphasis because it has no conversion event and is still essential: Alex's
point that a prospect will search the business before buying. It is measured by
existence and freshness, never by a lead.

---

## 3. The spine every campaign build follows

`campaign_manifest_items` already encodes the dependency graph, and every campaign
memo must walk it in this order. `external_activation = true` marks the steps that
need a human approval of an exact version.

```
intelligence  (Intelligence OS)                      no dependencies
   ├── offer           (Offer Studio)                needs intelligence
   ├── proof           (Proof Production Factory)    needs intelligence
   │      └── proof_distribution                     needs proof          [external]
   ├── creative        (Content Production Factory)  needs offer + proof
   ├── website         (Website Studio)              needs offer + proof  [external] (if a page is needed)
   ├── lead_magnet     (Lead Magnet Studio)          (if a magnet is needed)
   ├── sales_path      (Sales OS)
   ├── distribution    → one of three modules        [external]
   └── attribution     (Attribution OS)
```

**`distribution` resolves to a different module per route, and that is the single
biggest branch in the whole delivery:**

- organic mode → **Organic Content Distribution**
- paid mode + Meta → **Meta Ads Studio**
- paid mode + Google → **Google Ads Studio**

A campaign has exactly one mode, organic or paid, and never both. Reusing an idea in
the other mode is a clone with lineage, not an edit.

### The switches, and why a memo must always name them

Nothing reaches the outside world unless four things are true: the runtime flag, the
per-client switch, the per-destination support flag, and a human's decision on the
exact version. The five client switches live on `client_engine_settings`:

| Switch | Governs |
|---|---|
| `enabled` | the organic content engine runs at all |
| `publishing_enabled` | approved organic posts actually publish |
| `proof_publishing_enabled` | approved proof placements actually place |
| `campaign_actions_enabled` | campaign actions (page deploy, Meta build, proof release) execute |
| `lead_magnet_delivery_enabled` | magnets are actually delivered to opt-ins |

Every `*_due` view names which of these is closed in one sentence. **Every memo's
troubleshooting section is just "read the `_due` view".** All five are currently off
for every client.

---

## 4. Main flow register — the multi-process memos

Fourteen. Each composes secondary flows and spans modules.

| ID | Flow | Layer | Entry | Modules | Ends at |
|---|---|---|---|---|---|
| **MF01** | **Client activation** — signed client to a business the system understands | Foundation | E1 | Account (Onboarding, Contact, Brand, Integrations), Intelligence OS | A business context, brand profile and connected integrations |
| **MF02** | **Opportunity to activation** — run intelligence, find micro-niches, score, build the awareness journey, approve one | Foundation | E2 | Intelligence OS, Market Opportunities | An `approved` opportunity with an awareness journey |
| **MF03** | **Campaign build, organic mode** — opportunity to a live organic campaign | Attract/Nurture | MF02 | Campaign Factory → the manifest spine → Organic Content Distribution | Scheduled, approved posts going out |
| **MF04** | **Campaign build, paid mode (Meta)** — the same spine ending in paused Meta objects | Attract | MF02 | Campaign Factory → spine → Meta Ads Studio | A complete paused structure a person launches in Ads Manager |
| **MF05** | **Campaign build, paid mode (Google)** — same spine, build sheet only | Attract | MF02 | Campaign Factory → spine → Google Ads Studio | A reviewable build sheet. **Blocked at execution — see G03** |
| **MF06** | **Proof to omnipresence** — capture real proof, clear rights, make artifacts, place them where a prospect will look | Nurture | E4 | Proof Production Factory, Proof Distribution, Google Profile | Verified placements on the surfaces a buyer checks |
| **MF07** | **Produce a video with AI** — idea to an approved, QA'd, published video | Nurture | E5 or MF03 | Content Production Factory (+ Motion Design) | An approved asset in the library, lineage intact |
| **MF08** | **Produce content with people** — the human/filmed route and the editor hand-off | Nurture | E5 or MF03 | Content Production Factory, Team (editors, avatars) | Same end state as MF07, different route |
| **MF09** | **Run the organic content engine** — the autonomous nurture cadence | Nurture | MF03 | Organic Content Distribution, Approval Inbox | A standing content rhythm with one human gate per post |
| **MF10** | **Attract → nurture → convert for one micro-niche** — the flagship end-to-end journey | All three | MF02 | Nearly every module | A stranger became a customer, and we can say which content did it |
| **MF11** | **Build the conversion path** — page, magnet, capture, probe | Convert | MF03/MF04 | Website Studio, Lead Magnet Studio, Sales OS | A published page whose form provably reaches Sales OS with consent and source |
| **MF12** | **Sales path** — capture to qualified to booked to closed to cash | Convert | MF11 | Sales OS, Website Studio | `lead_stage = cash`, attributed |
| **MF13** | **Attribution and the learning loop** — measure, report, feed back into intelligence | Measure | MF03+ | Attribution OS, Intelligence OS, Market Opportunities | Opportunity confidence moved on evidence, not narrative |
| **MF14** | **Recruitment** — AA's own hiring campaigns, deliberately separate | Internal | E6 | Team (recruitment tabs), Meta Ads Studio | Applicants against a recruitment page |
| **MF15** | **Offer change and drift sweep** — reprice safely, find every live asset still quoting the old figure | Lifecycle | E3 | Offer Studio, Website Studio, Lead Magnet Studio | Zero live surfaces carrying a superseded version |
| **MF16** | **Campaign lifecycle** — clone, mode switch, pause, archive, terminate content | Lifecycle | any | Campaign Factory, Archive | A campaign ended without orphaned external objects |

*(Sixteen, not fourteen — MF15 and MF16 earned their place once the lifecycle entry
tracks were written out.)*

---

## 5. Secondary flow register — the specific-task memos

Short, precise, one job each. Grouped by the module that owns the job.

### Account and connection
- **SF01** Onboard a client: the steps and what each unlocks
- **SF02** Connect Meta: ad account `act_` prefix, System User token, page ID, pixel ID
- **SF03** Connect a Google Business Profile location
- **SF04** Connect the client's site repository and GitHub installation
- **SF05** Read `integration_health` and replace a dead credential
- **SF06** Turn on a client switch — and what becomes possible, and what starts costing money

### Intelligence and strategy
- **SF07** Run one intelligence agent (ICP, market, competitor, association) and read the record
- **SF08** Write business context so the agents produce something usable
- **SF09** Set content pillars
- **SF10** Produce branding strategy / money model strategy
- **SF11** Take an intelligence snapshot for a campaign and know why it is versioned
- **SF12** Export intelligence as PDF/ZIP

### Market opportunities
- **SF13** Run opportunity discovery
- **SF14** Score an opportunity and record the factors
- **SF15** Raise `opportunity_confidence` with evidence (hypothesis → proven)
- **SF16** Build the awareness journey: stage, mindset, message, asset direction, distribution note
- **SF17** Read `opportunity_readiness` and clear each blocker
- **SF18** Create a campaign from an approved opportunity (and why the brief points back at it)

### Offer Studio
- **SF19** Create an offer and a version
- **SF20** Sign off an offer version, and why a quantified claim needs proof attached
- **SF21** Read `offer_claim_evidence` and fix a claim whose proof expired
- **SF22** Read `offer_version_drift` after a reprice and fix each live surface

### Proof
- **SF23** Capture a proof asset by hand, with source and evidence
- **SF24** Run a proof capture link and collect a submission from a customer
- **SF25** Set usage rights and expiry — and what `not_cleared` refuses downstream
- **SF26** Capture a Google review as proof
- **SF27** Request a proof artifact (geo answer, SEO case study, local proof snippet)
- **SF28** Sign off a proof artifact version
- **SF29** Create a proof destination and request a placement
- **SF30** Approve a proof placement and watch it place
- **SF31** Place a manual placement (a directory with no write API) and record the evidence
- **SF32** Retract a placement when rights are lost, and verify the retraction

### Content production
- **SF33** Generate ideas for a campaign, and approve or reject one
- **SF34** Build a brief from an approved idea
- **SF35** Build a frame plan and regenerate one frame without redoing the rest
- **SF36** Produce a single image asset
- **SF37** Produce a reel: stills, then motion
- **SF38** Produce a carousel, and why it publishes whole
- **SF39** Produce a story
- **SF40** Write and attach post copy
- **SF41** Run QA, read the score, and act on a `min_qa_score` failure
- **SF42** Approve an asset (Assets queue) versus approve engine work (Engine queue) — the difference
- **SF43** Repurpose a long video into clips
- **SF44** Hand a video to a human editor and take delivery
- **SF45** Edit a source video with AI and request a revision
- **SF46** Seed motion scenes, lock a scene, accept a motion candidate
- **SF47** Read `motion_candidate_due` and why an AI verdict is not an acceptance
- **SF48** Terminate or archive a piece of content

### Distribution
- **SF49** Schedule an organic post to Instagram/Facebook
- **SF50** Read `distribution_due` / `publish_due` and clear the blocker
- **SF51** Set the engine's plan horizon, format mix and approval mode
- **SF52** Read the slot board and move one slot through its stages
- **SF53** Hold a job and resume it
- **SF54** Build a Meta campaign to paused objects from an approved package *(existing SOP — fold in)*
- **SF55** Produce a Google Ads build sheet and read what is missing
- **SF56** Publish a Google Profile post

### Website, magnets and capture
- **SF57** Build a landing page, audit it, revise it
- **SF58** Request page-deploy approval and read the snapshot a reviewer sees
- **SF59** Publish an approved page and re-check the byte hash
- **SF60** Probe a published form and prove a lead arrives with consent and source
- **SF61** Create a lead capture endpoint and connect it to a campaign
- **SF62** Create a lead magnet and a version
- **SF63** Approve a magnet version and turn on delivery
- **SF64** Connect a magnet to a campaign and to the page that gates it
- **SF65** Read `lead_capture_due` and `lead_magnet_due`

### Sales
- **SF66** Build a sales agent: purpose, qualification, objections, booking rule, guardrails
- **SF67** Approve and deploy a sales agent widget, with origin and daily limits
- **SF68** Move a lead through the pipeline by hand
- **SF69** Record an appointment, a show, a sale and cash
- **SF70** Deduplicate a lead, and how `dedupe_key` decides
- **SF71** Exclude probe leads from the real pipeline

### Attribution and reporting
- **SF72** Read attribution: observed, estimated and unknown, and never conflate them
- **SF73** Request a metrics backfill
- **SF74** Read `metrics_coverage` and explain a gap
- **SF75** Generate reporting commentary
- **SF76** Read economics and MRR
- **SF77** Trace one customer back to the content that caused them

### Operations
- **SF78** Read the Approval Inbox end to end: three queues, three different acts
- **SF79** Read any `*_due` view as a troubleshooting tool
- **SF80** Read `agent_runtime_status` to confirm which build is live
- **SF81** Reap stale claims and understand the five-attempt ceiling
- **SF82** Archive a campaign without orphaning external objects

Eighty-two secondary memos is the honest count for complete coverage. They are short.

---

## 6. Gaps that stop a loop closing

Found by reading the registries that record unsupported actions as data, plus the
runtime. None is a missing module; each is specific functionality a flow needs.

| ID | Gap | Blocks | Severity |
|---|---|---|---|
| **G01** | **No DM path whatsoever.** No webhook ingestion, no Instagram/Messenger adapter, no DM conversation record. `campaign_action_executors.lead_message` is unsupported. | P3 (destination `message`) produces conversations nothing can hold. Alex's described "prospect goes to a DM" has no system behind it. MF10 and MF12 both break here. | **Critical** |
| **G02** | **No governed outbound send.** Lead magnet delivery has a courier; general nurture messaging has nothing. | R2 objection sequences by message, magnet follow-up, any nurture that is not a public post. `email_sms_nurture` proof destination unsupported. | **Critical** |
| **G03** | **No Google Ads adapter.** Migration 243 produces a build sheet; nothing writes to Google. `keyword_research` is always listed as missing. | MF05 cannot complete. Alex named Google ads explicitly. | **High** |
| **G04** | **No booking integration.** `booking_rule` is prompt text telling the agent when to book; no calendar is connected and nothing creates an appointment. `lead_stage = appointment` is set by hand. | "Sales agent setter books a call" is manual. MF12's middle is a human typing. | **High** |
| **G05** | **No `profile_update` executor.** `google_profile_changes` and `meta_profile_changes` record decisions; no runtime writes them. | Omnipresence (X-f) is partly manual: GBP *posts* work through proof distribution, profile *management* does not. | **High** |
| **G06** | **No awareness-stage → template mapping.** `opportunity_awareness_stages.stage` is free text; the 16 templates carry entry/exit audience states; nothing joins them. | The core attract decision — "which of the 16 for this awareness level" — is tribal knowledge, not system knowledge. Weakens MF02 → MF03/MF04. | **High** |
| **G07** | **No `budget_change` executor.** Deliberately excluded from the build. | Spend changes are manual in Ads Manager, ungoverned and unattributed. | Medium |
| **G08** | **`campaign_launch` is not a real gate.** Listed as "every other action having happened". | Nothing answers "is this campaign actually live" in one place. MF03/MF04 end without a single verdict. | Medium |
| **G09** | **Proof destinations still unsupported** for `main_website`, `campaign_landing_page`, `seo_geo_content`. These route through the page pipeline, which migration 237 has now built. | MF06 cannot place proof on the client's own site — arguably the most important surface. **Likely cheap to unblock now.** | Medium–High |
| **G10** | **`organic_social` / `paid_advertising` / `sales_conversation` proof placements unsupported** — they execute elsewhere but are not *recorded* as placements. | Proof lineage is incomplete: a proof-derived ad exists but no placement row says so. | Medium |
| **G11** | **No per-lead nurture sequencing.** The engine schedules content slots, not per-person journeys. | Nothing moves a specific S3 lead along; nurture is broadcast only. | Medium |
| **G12** | **No creative-director or SMM assignment concept.** "Creative director" exists only as an LLM persona string; `team_category` is avatars/editors/smm with no routing of creative decisions. | Alex's "social media manager and creative director controlling the creatives" has no seat in the system. | Low–Medium |

**The pattern worth naming:** every gap is in the **convert** layer or in **omnipresence**.
Attract and nurture are close to complete; the system can get a stranger's attention and
earn their trust, then largely hands off to a human. G01, G02 and G04 are one cluster —
the conversation and the booking — and they are what stands between MF10 and an actual
closed customer.

---

## 7. Build order used

1. **MF10 first**, as the spine. Writing the flagship journey end to end will expose
   any flow I have mis-scoped before eighty short memos are built on top of it.
2. Then the foundation main flows **MF01, MF02**, since nothing runs without them.
3. Then the three build tracks **MF03, MF04, MF11** and their secondary flows — this is
   the bulk of the daily work.
4. Then **MF06, MF07, MF08, MF09** (production and omnipresence).
5. Then **MF12, MF13** — and these will be written with the G01/G02/G04 gaps stated in
   place, so the memo is honest about where a person takes over.
6. Then **MF05, MF14, MF15, MF16** and the remaining secondary flows.

Each memo follows the house style already set by `sop-meta-campaign-to-paused-ads.md`:
purpose, scope, owner, last reviewed, the one rule that prevents the expensive mistake,
then bolded click-paths, field tables, and a troubleshooting section that is mostly
"read the `_due` view".

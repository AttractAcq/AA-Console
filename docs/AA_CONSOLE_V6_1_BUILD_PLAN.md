# AA Console v6.1 build plan

Written 31 October 2026, from `ATTRACT_ACQUISITION_AA_CONSOLE_NOTES_31-10-2026.txt`,
once v6 was merged, applied and published (main `36a4c8b`, 318 migrations
through `20261101150000`, live bundle verified to embed that commit).

## The shape the notes describe

Read across all twenty pages, the notes ask for one pattern applied everywhere
rather than twenty separate rewrites:

> an index table → click a row for detail → actions on the row · agents do the
> work · every flow stops at **ready to distribute** · a human approves in the
> Approval Inbox · then distribution workers fire

Most page-level notes are a variant of "collapse these tabs into that pattern".
Offer Studio, Website Studio, Lead Magnet Studio, Sales OS and Market
Opportunities all say it explicitly. So the plan builds the pattern once and
applies it, because building it per page is where this would lose weeks.

The second repeated instruction is that **nothing distributes without a human
gate**, and the third is that **every switch lives on the Dashboard** — which
landed in v6 already, in #320.

## Phase 0 — foundations

### 0.1 A campaign may be paid, organic, or both

Alex's decision on 31 October: "i want to be able to run all of these: either
just paid, just organic or paid and organic together."

This is not a loosened constraint. The current design is deliberately
one-route-per-campaign:

- `client_campaigns.acquisition_mode` is `legacy | organic | paid`, with
  `client_campaigns_acquisition_route_check` tying `paid_platform` to it
  (migration 203)
- `guard_campaign_acquisition_route` makes the route **immutable** after
  insert: you must clone to change it
- `clone_campaign_for_route` refuses to clone into the same mode, with the
  stated reason "to keep independent distribution and results"

**The real work is that the route is currently a property of the campaign, and
has to become a property of the asset.** Today "this campaign is organic"
implies "every asset under it is organic", and the B011 guards rely on that
implication. Migration 290 blocks scheduling with

```sql
if v_campaign.acquisition_mode is distinct from 'organic'
   or v_campaign.paid_platform is not null then
```

and the publisher claim requires

```sql
and ca.acquisition_mode = 'organic'
and ca.paid_platform is null
```

For a both-campaign that implication no longer holds. If those predicates are
left alone, a both-campaign simply cannot publish organically. If they are
relaxed to accept it without giving each asset its own route, **paid creative
becomes claimable by the organic publisher**, which is precisely the leak B011
exists to prevent.

So 0.1 is three things, in order:

1. per-campaign capabilities: organic enabled, paid enabled, and which paid
   platforms (the notes' campaign planner decides "organic content (how much
   and what), paid content (how much and what)", so this is a set with
   per-route configuration, not one enum value)
2. an explicit route on each asset or slot, defaulting to nothing
3. the B011 guards rewritten to read the **asset's** route, staying fail-closed:
   an asset with no explicit route is never claimable, exactly as today

It also needs campaign → offer → market opportunity links, since the notes say
"this starts with the new campaign, which should now be linked to the offer and
the market opportunity".

Twelve migrations and roughly sixteen runtime and frontend files read
`acquisition_mode`. Each has to be assessed, not bulk-edited — the failure mode
here is a guard that looks relaxed and is actually open.

#### 0.1a Migration 302 was only the schema half

Asked what stage the build was at, I checked `both` end to end rather than
from memory, and it was not usable. 302 taught the database the route and left
six code paths on two. One of them was a regression 302 itself introduced.

**The regression.** 302 added `runs_organic` and `runs_paid` defaulting to
false and made the route CHECK require the mode and the flags to agree. It
taught `create_campaign_from_opportunity_v6` and `clone_campaign_for_route` to
set them, and missed `mcp_campaign_create_v6`, which sets the mode and leaves
the flags alone. Every branch of that CHECK but `legacy` needs a flag true, so
from the moment 302 was applied **that function could not create a campaign in
any v6 mode** — organic and paid included, both of which had worked before.
Verified against the live constraint: the predicate is false for
`('organic',f,f,null)`, `('paid',f,f,'meta')` and `('both',f,f,'meta')`, true
only for `('legacy',f,f,null)`.

It stayed hidden because no v6 campaign has ever been created — all 20 are
`legacy` — and that path is service-role only, reached by a bot rather than by
the console. Latent, not harmless. `campaign_execution`, the third writer,
inserts only `(client_id, name, brief)` and so takes the `legacy` default; it
needed no change.

**What else assumed two routes.** The campaign planner refused `both` outright:
`planRouteProblem` fell through to "the campaign has an unknown acquisition
route", and `isV6` tested `organic || paid` so such a campaign was planned as
*legacy* — told to "preserve its historical routing". The MCP gateway's
`create-v6` parse rejected the mode. The console's own create dialog read
`values.acquisition_mode === "paid" ? "paid" : "organic"`, so choosing
paid-and-organic would have created an **organic** campaign on an immutable
route, the mistake surfacing later as paid work that never happened.
`assertOrganicScheduleRoute` demanded `mode === "organic"` *and*
`paid_platform === null`, and a `both` campaign fails both — so every organic
post under it was blocked, which is precisely the half Alex asked for. Page
approval was hidden, and the launch gate showed spend but not posts.

Migration 305 and the surrounding commit close all of it. The lesson worth
keeping: **adding a value to an enum-like column is not a schema change, it is
a change to every branch that reads the column.** 302 should have shipped with
the sweep for `acquisition_mode ===` that found these in minutes.

### 0.2 The shared index-table pattern

One component, with tests: index table, row click to detail, row actions.
Consumed by Market Opportunities, Offer Studio, Website Studio, Lead Magnet
Studio, Sales OS, and both distribution logs. Built once.

### 0.3 Archive and document the discontinued surfaces

Per Alex on 31 October: archive, but keep a documented list, because
undocumented archiving is the habit to break. Clean removal in v6.2.

- Proof Distribution → **Rights**, **Placements** — the notes call both "not as
  important" and say "both need to be discontinued"
- Lead Magnet Studio → **Opt-ins** — "isnt necissary to track"

**And Motion Design**, decided on 4 November. This one needed asking. The notes
said it "can be left alone for now as I believe we will discontinue it" — left
alone, not removed — while the phase 0 list named it among the surfaces to
archive *and* again under "deliberately deferred", two of the three fates in one
message. The plan held it as deferred and flagged the conflict rather than
picking, which is why it was still open when the rest of phase 0 was done. Asked
directly, Alex chose to archive it now. Only the route in is gone; both of its
panels still compile.

Archived means the way in is gone and the code is not: each panel still
compiles, so v6.2 deletes it without reopening the decision. The list lives in
`V6_1_ARCHIVED_SURFACES.md`.

## Phase 1 — campaign inputs

Campaign Factory cannot be correct until the things a campaign is built from
are correct.

### 1.1 Offer Studio

One page, a table of all offers, two buttons: create main offer, create
secondary offer. A main offer is the business's own; a secondary offer targets a
specific ICP and micro-niche. An agent compiles it — from Offer Strategy for a
main offer, from the micro-niche market opportunity for a secondary one. Human
gate in the Approval Inbox before it reaches production. Autonomous when called
by the campaign builder, to ready-to-distribute.

Also: **move the Offer Strategy tab out of Offer Studio and under Strategy** as
its own tab.

### 1.2 Market Opportunities

`Discover` becomes the single table view; `Evaluate`, `Strategise` and
`Activate` become row actions, so active opportunities are visible at a glance.

Two functional gaps the notes name:

- **there are no agents in this module today.** Evaluate and Strategise should
  be agent work, leaving the human to trigger a Discover run and approve or
  activate a micro-niche.
- **no way to say how many opportunities to assess.** The "find opportunities"
  run needs a count, then selection of which to evaluate and strategise, then
  approval of which to activate.

### 1.2a The Evaluate and Strategise agents needed a decision first — **decided and built**

The notes ask that "the agents should do the evaluation and the strategise
modules within the market opportunities model", leaving the human only to run a
Discover pass and to approve or activate.

**The database currently forbids exactly that, and on purpose.** Both
`score_market_opportunity_v6` and `set_opportunity_status_v6` guard on
`can_shape_opportunity`, which is

```sql
select coalesce(public.is_admin(), false)
    or coalesce(auth.uid() = public.active_video_approval_manager(p_client_id), false);
```

`is_admin()` reads `profiles.role` for `auth.uid()`, and `auth.uid()` is null for
the agent runtime, so both are **false for an agent**. An evaluation agent would
be refused before it wrote anything.

That is not an oversight to patch around. Scoring is the gate that lets money be
spent against a hypothesis: `set_opportunity_status_v6` reads the readiness view
on approval rather than trusting the person, and readiness depends on the score.
So permitting an agent to score moves who may assert the thing that unlocks
spend.

**What the change would be, if Alex wants it:**

1. a service-role branch on `score_market_opportunity_v6` only — never on
   `set_opportunity_status_v6`, so approval and activation stay human exactly as
   the notes describe
2. the score attributed to the agent rather than to nobody.
   `opportunity_scores.scored_by` already exists and
   `opportunity_events.actor` already carries `'agent'` as a value, so an
   agent-authored score is distinguishable from a person's on the screen and in
   the history. A human looking at an approved opportunity should be able to see
   whether a person scored it.
3. the same treatment for whatever the Strategise agent writes, which needs its
   own pass over the strategy writers to see which of them share the guard.

**Recommended:** do it, narrowly, in that shape. The alternative reading — that
scoring must stay human — would mean the notes' "completely autonomous" cannot
include evaluation, and that is a product decision rather than a technical one.

Until it is decided, Market Opportunities works as it does today: a human scores
in the Evaluate view, and the Discover table carries the whole status
progression.

#### 1.2b How it was resolved, and what was wrong in #327

Asked on 4 November, Alex chose **the agent proposes and a human accepts**. So
**no guard was widened.** `can_shape_opportunity` is untouched,
`score_market_opportunity_v6` is untouched, and neither agent can score.

Migration 306 adds `opportunity_proposals`, and
`accept_opportunity_score_proposal_v6` performs the ordinary human scoring act
with the factors exactly as proposed — it adds no permission of its own, so
there is still exactly one rule about who may score and it lives in one place.

**#327 overstated the problem.** It said the agents were blocked by
`can_shape_opportunity`. True of scoring and status, but three of the shaping
writers already carry a service-role branch:

| | |
|---|---|
| agent may write | `set_opportunity_attributes_v6`, `set_opportunity_awareness_v6`, `link_opportunity_v6` |
| human only | `set_opportunity_fields_v6`, `score_market_opportunity_v6`, `set_opportunity_status_v6`, `set_opportunity_confidence_v6` |

So an agent shaping an opportunity was never unprecedented. The codebase
already draws the line this build keeps: **structured working-out** an agent
may write, **the opportunity's own commercial claim** a person asserts. The
Strategise agent therefore writes its attributes and awareness messages
directly and proposes only the narrative fields.

It also deliberately does **not** use the approval spine. All nine of those
routes are human decisions about outward acts — publish, spend, grant access,
cut a release — and two are contained because that bar is high. A drafted
evaluation goes nowhere and costs nothing; accepting it is just the scoring a
person could have done unaided. If it later belongs in the Inbox it becomes
route ten then.

#### 1.2c What was built

- **`opportunity_evaluate`** — scores the seven factors with per-factor
  reasoning and proposes it. Reads the factors and weights from
  `opportunity_score_factors` rather than carrying a copy, and does not compute
  the total: the scorer does that at acceptance, so a proposal accepted after a
  reweight is scored on the new weights.
- **`opportunity_strategise`** — writes the problems, outcomes, motivations,
  triggers and objections, and a message per awareness stage; proposes the six
  narrative fields. Refuses fewer than two objections, and refuses an entry
  stage it wrote no message for, because the first thing a campaign would do is
  reach for copy that does not exist.
- **The Evaluate view** shows each proposal with the reasoning beside every
  number, because accepting is asserting the thing that unlocks spend and a
  person who can only see a total is rubber-stamping. Accepting sends the
  proposal id and no numbers, so what is scored cannot drift from what was read.

#### 1.1a The offer compiler — **built**

The notes' "agent compiles from Offer Strategy or from the micro-niche". #324
built the page and the two buttons; this is the compiling half, as
`offer_compile` plus migration 307.

No permission change was needed and that is worth recording:
`create_service_offer_version_v6` already names `service_role` in its own
guard. Unlike scoring, this one needed checking rather than arguing about.

The asymmetry is not an oversight in either direction. An offer version is a
draft that is reviewed and signed off, and nothing spends because it exists —
**the propose-then-accept shape was already implemented here by the version and
sign-off flow**, so no proposal table was added. A score is an assertion that
unlocks spend, and had no draft state at all.

It leaves **price and claims empty on purpose**: a price is a commercial
decision with margin behind it, and a claim is a promise that needs proof,
which is what the claims system exists to tie together. The RPC permits both to
be absent, and absent is the honest answer from an agent.

## Phase 2 — the campaign spine

3. **Campaign planner agent** — decides landing page or not, sales agent or not,
   organic volume and type, paid volume and type, pillars and positioning per
   route. **Largely already existed**, which is the thing to know before
   budgeting for it: `campaign_plan` already decides the landing page, the
   sales agent, the content pillars as an enum of this campaign's own pillars,
   the KPI, the content count and the ideas.

   What it could not do was divide that count between routes, because
   `content_count` is one number. For a single-route campaign that is the
   answer; for the `both` route 302 added, "twelve pieces" could mean twelve
   organic and no ads, and readiness could not tell. **Migration 308 and
   `routeVolumes` close that**, and the split is derived rather than asked for
   on single-route campaigns so the model cannot get wrong a question it was
   not asked.

   **A design bug a test caught, worth recording.** 308's constraint first
   required the split to equal `content_count`. The planner saves its plan —
   which sets `content_count` — and *then* records the split, because a total
   has to exist before it can be divided. An equality constraint rejects the
   first of those two statements, and Postgres cannot defer a CHECK. So the
   constraint now forbids only what is never acceptable at any instant
   (negative counts, pieces on a route the campaign does not run, a split
   larger than the plan) and the function enforces exactness in one statement.
   The first version of 308 could not have saved a plan at all.
4. **Plan review gate** — correctable in the Inbox or in the campaign before the
   agent runs. **Done** (item 7 in Alex's numbering), as migration 309.

   **"Before the agent runs" is `provision_campaign`.** It refused only when
   there was no plan at all, and then wrote a landing page row, wrote a sales
   agent row, and enqueued both jobs. And the plan it ran from was approved by
   nobody: `save_campaign_plan_only` and `save_campaign_plan_with_ideas` set
   `built_at` themselves, so the planner marked its own work approved — the
   prompt even calls such a row an "EXISTING APPROVED CAMPAIGN PLAN".

   **An approval has to name the plan it approved.** A flag would not be a
   gate: the notes ask for a plan that is *correctable*, and a bare
   `plan_approved_at` would let the corrected plan provision on a decision made
   about different text. So the approval records a fingerprint of the planned
   fields, and `provision_campaign` refuses when the current fingerprint
   differs. Correcting a plan therefore un-approves it, which is exactly the
   behaviour the notes describe.

   That is the idiom the rest of the system already uses — an offer approval
   names the hash of the bytes, the approval spine carries an `artifact_hash` —
   applied to a plan.

   The fingerprint covers only the planned fields. A campaign that launches or
   gets an external id has not been replanned, and re-approving for that would
   train people to click past the gate.

   `approve_campaign_plan_v6` has **no service_role branch**: the whole point
   is that a machine does not approve its own plan.
5. **The single multi-step sweep** — one run driving every asset to
   ready-to-distribute by calling the factories, each process individually.

   **The engine already exists and is live.** This is the fourth item in a row
   where the mechanism was built and the wiring was not, and it is the most
   consequential: the plan treated this as "the heart of it", and building a
   second orchestrator beside a working one would have been the worst mistake
   available in this phase.

   | | |
   |---|---|
   | `create_workflow_run(...)` | creates a run, and **already takes a `campaign_id`** |
   | `add_workflow_agent_step(...)` | a step with `dependencies text[]`, an `agent_key`, and `input_from_step_key` to chain one step's output into the next |
   | `reconcile_workflow_runs(p_limit)` | the driver, **running every 15 seconds** in the runtime (`src/v5/reconcile.ts`) |
   | `enqueue_workflow_step_job(...)` | queues a step's agent job — `agent_jobs` stays the only execution queue |
   | `accept_workflow_step(...)` | records a step's artifact and its QA evidence |
   | `seal_workflow_run`, `workflow_run_outcomes` | completion and reporting |

   That is the sweep the notes describe, component for component: one run,
   each process individually, each calling a factory by `agent_key`, driven on
   a loop. It carries real data — 10 runs, 140 steps.

   **So item 8 is a composer, not an engine**: a function that, given an
   approved campaign plan, creates a run and adds the steps the plan implies —
   the landing page, the sales agent, the content pieces per route — with the
   dependencies between them. Plus the retirement question for the `v5/`
   label, since the engine is not v5-specific in anything but its directory.

   It must refuse an unapproved plan, which is why 2.7 landed first: the gate
   exists for the sweep to respect, rather than the sweep being built and then
   gated.

   **What is concrete.** `workflow_runs_kind_check` permits only
   `daily_content_package` and `client_launch_package`, so the composer's
   migration has to extend it with a `campaign_sweep` kind. All 10 live runs
   are `daily_content_package` at `v5.daily.1`.

   **The open design question, which should not be guessed at.** The sweep's
   relationship to `provision_campaign`. That function already creates the
   landing page and the sales agent and enqueues their agents, so a sweep that
   adds the same two steps duplicates it — and this phase has already removed
   three duplications of exactly that shape. Either:

   - the sweep **subsumes** it, covering the build artifacts and the content
     pieces as one step graph, and `provision_campaign` becomes the sweep's
     first steps rather than a separate act; or
   - the sweep covers **only** what `provision_campaign` does not — the
     content pieces per route, using 308's split — and the two run side by
     side with a clear boundary.

   The first is cleaner and matches "one run driving every asset". The second
   is smaller and does not touch a working path. It also depends on what the
   content chain actually is: the daily-package pipeline already chains brief,
   copy, creative and QA steps, and the sweep should reuse that chain rather
   than restate it.

   Settling that needs a read of the daily-package step graph, and it is the
   kind of decision worth making deliberately rather than at the end of a long
   session. Recorded here so the next pass starts from it.

## Phase 3 — the factories the sweep calls

6. **Website Studio** — five tabs collapse to a Sites table plus build buttons
   for landing pages and offer pages; agent builders; autonomous under the
   campaign worker; publish to GitHub after approval. **Mostly done** (item 9
   in Alex's numbering). Four tabs now, Sites leading, with build buttons on
   it.

   **The agent builders already existed**, which is worth knowing before
   anybody budgets for them: `PageBuilderPanel` creates the `client_pages` row
   and enqueues the `landing_page` agent, and has since v1.

   So the build buttons **link** to the builders rather than repeating them. A
   button here that created a page and queued the agent would be a second
   write path for one act — the same duplication this module lost a whole tab
   for, when **Results** turned out to be Attribution OS's reporting panel
   reached by a different route. One write path, and Sites is the way in.

   **Publish survived on purpose.** It is not the publish button on a site
   row: it is the board of what happened to each campaign page decision, and
   it carries a state nothing else does — *published, and nobody has tested
   the form yet* — which has the same commit, the same URL and the same
   screenshot as working. That belongs in the Sites detail eventually, not in
   a row action.

   **Still owed:** autonomous operation when called by the campaign worker.
   Deliberately left with the sweep rather than guessed at here, because the
   sweep is the thing that would call these builders. Building it from this
   end first would mean designing a caller that does not exist yet and
   rewriting the interface when it does.
7. **Lead Magnet Studio** — one page, table plus a build button. Download only,
   no distribution. Opt-ins dropped. **Done.** Four tabs became one page on
   `IndexDetail`. Build was the table twice, so its button became the page's
   action. Delivery held three separable things: its switch was already
   duplicated on the Dashboard panel, where the notes put every switch, so
   that copy went; the approval queue moved into the row detail; what-is-owed
   moved with it, scoped by version id rather than by magnet name, since two
   magnets may share a name and a rename would silently empty the list.
   Opt-ins went to Sales OS → Capture, which already creates endpoints and
   already tested the token-shown-once rule.

   The approval act deliberately did **not** flatten into a row menu: it
   approves exact bytes plus the words carrying them, and it shows the scope
   and payload hash the *approval* recorded rather than what the version row
   says now, because the gap between those two is the "changed after approval"
   blocker. See `docs/V6_1_ARCHIVED_SURFACES.md` §Phase 3.7.
8. **Sales OS** — Agents becomes the main table page. **Pipeline CRM moves to
   Attribution OS.** The agent distributes to its associated page without a
   developer. Capture portal left alone for now.
9. **Content Production tuning** — the two named defects: video generation, and
   the text inside image content. Repetition, not architecture.

## Phase 4 — the gate and distribution

10. **Approval Inbox unification** — four views into one. The notes say the
    approval routes are "specifically unknown", so the existing routes need
    mapping before any UI work, and that mapping should happen before Phase 2's
    plan review gate depends on it. **That mapping is done — see 10a below**,
    and it changes the shape of this item: the unified spine already exists and
    carries nine routes, so item 10 is wiring and deletion, not a build.
11. **Distribution workers** — organic on a cron schedule, paid bundles handed
    to the human paid-ads operator, page published to GitHub, lead magnet bundle
    delivered.
12. **Proof Distribution** — ten destinations as individual connect-modules,
    plus a Distribution Log table of what went where and when.
13. **Organic Content Distribution** — Destinations (Facebook, Instagram) plus a
    Distribution Log. The Engine tab retires into the Dashboard switch panel.

### 10a. The approval routes, mapped

The notes called the approval routes "specifically unknown", and the plan made
mapping them a prerequisite for the Phase 2 plan review gate. They are now
mapped, from the live database rather than from the UI, because the UI is the
part that turned out to be behind.

**There is already one unified spine, and it is complete.** `approval_requests_v6`
is the single request table, `register_approval_request_v6` its single writer,
`record_approval_decision_v6` its single decision recorder, and
`approval_inbox_v6` the single read model. Nine routes are registered against
it, each with its own registrar and its own source-state resolver:

| `source_system` / `source_kind` | source of truth | registrar | resolver | decision |
| --- | --- | --- | --- | --- |
| `aa_console` / `campaign_action` | `campaign_action_approvals` | `register_campaign_action_inbox_v6` | `approval_source_state_v6` | `decide_campaign_action_approval_v6` |
| `aa_console` / `client_sales_entitlement` | `client_sales_entitlement_requests` | `sales_entitlement_inbox_insert_v6` | `approval_source_state_v6` | `decide_client_sales_entitlement` |
| `aa_console` / `recruitment_brief` | `client_briefs` | `register_recruitment_brief_inbox_v6` | `approval_source_state_v6` | `approve_recruitment_brief_from_inbox_v6` |
| `aa_console` / `google_review_reply` | `google_review_replies` | `register_google_reply_inbox_v6` | `approval_source_state_v6` | `decide_google_review_reply_from_inbox_v6` |
| `aa_console` / `engine_slot` | `content_slots` + `slot_events` | `register_engine_slot_inbox_v6` | `approval_source_state_v6` | — not wired in the unified panel |
| `auth` / `console_invitation` | `console_invitation_requests_v6` | `request_console_invitation_v6` | `approval_source_state_v6` | `decide_console_invitation_v6`, not wired |
| `aa_console` / `production_release` | `production_release_candidates_v6` | `submit_production_release_candidate_v6` | `production_release_source_state_v6` | `decide_production_release_candidate_v6`, not wired |
| `aa_console` / `recruitment_meta_build` | recruitment Meta build | `request_recruitment_meta_build` | `recruitment_meta_build_source_state_v6` | contained, see below |
| `aa_console` / `organic_publication` | organic publication package | `register_organic_publication_package_v6` | `organic_publication_source_state_v6` | contained, see below |

So the work in item 10 is not "build a unified inbox". It is to finish wiring
the one that exists, and that is a smaller and better-understood job than the
notes assumed.

**The unified panel decides four of the nine.** `UnifiedApprovalInboxPanel`
calls the campaign-action, sales-entitlement, recruitment-brief and
google-reply RPCs. Engine slots, console invitations and production releases
are registered and resolved but have no decision path in that panel; the last
two are decided elsewhere today, which is defensible, and engine slots are
decided in a *second* implementation, which is not.

**Two routes are deliberately undecidable.** `recruitment_meta_build` and
`organic_publication` carry an unconditional `preview_blocker` in the view, so
their cards can never present as decidable:

> Recruitment Meta creation still lacks exact media bytes and an AAL2 prewrite gate.
> Organic publication lacks rights provenance, exact AAL2 approval and prewrite attestation.

That is the containment migrations 293 and 295 added on purpose. Item 11 cannot
distribute organic content through this gate until that blocker is lifted, and
lifting it means supplying rights provenance and a prewrite attestation, not
editing the string. **Phase 4 ordering follows from this**: item 11's organic
worker is gated on 10a, not merely sequenced after it.

**The spine has never carried a request.** `approval_requests_v6` and
`approval_decision_events_v6` both hold zero rows, as do
`campaign_action_approvals`, `content_slots` and
`campaign_page_approval_snapshots`. This is not a defect: five of the nine
registrars grant `execute` to nobody, so they are reachable only from inside
the owning act's own definer function — a card is a side effect of the act that
needs approving, never something a caller elects to create. Two more are
`service_role` only. The inbox is empty because the acts have not fired, which
is what "ready for v6.1" means here rather than something to fix.

**The real gap is the one queue with real data.** `client_media_assets` holds
110 rows and is approved by `review_media_asset`, which does not call
`register_approval_request_v6` and has no `source_kind` in the spine at all. So
media-asset review — the only approval in this system that has ever actually
happened — is the single route with no representation in the unified inbox.
Item 10 should add it as a tenth route before retiring `ApprovalsPanel`, or the
unification loses the only queue in production use.

**A soft edge worth knowing.** `source_system` and `source_kind` are
length-bounded free text, with no enumeration and no foreign key. A registrar
passing an unknown pair gets a card whose resolver falls through to
`'unverified'`, which the view surfaces as that status and which no decision
RPC will act on. It fails closed, so this is not urgent; but it means the route
list above is discoverable only by reading `approval_inbox_v6` and
`approval_source_state_v6`, which is why it is written down here.

**What item 10 therefore is**, in order: add the media-asset route; wire the
engine-slot decision into the unified panel and delete `EngineInboxPanel` and
the legacy `approval_inbox` view with it; fold `ApprovalsPanel` and
`CampaignActionApprovalsPanel` into the unified panel, whose RPC the latter
already shares; then reduce the four tabs to one page. The two contained routes
stay contained and visible.

## Phase 5 — read-only views and the archive

14. **Google Ads Studio** and **Meta Ads Studio** — downgraded to read-only API
    views with per-campaign data on click. Deliberately less than today: the
    build and management moved to a human paid-ads operator.
15. **Google Profile** and **Meta Profile** — what has gone out, plus live paid
    campaign data for that channel.
16. **Archive** — add market opportunities, the intelligence and strategy
    models, and lead magnets. Rejected assets land here with their rejection
    note, so the what-worked trend becomes visible.

## Deliberately deferred

- **Attribution OS** — "this is massive so we will leave this for now"
- **Master AI** on the Dashboard — Alex's instruction on 31 October
- **Sales OS capture portal** — purpose not yet settled

## Open questions

1. **Proof Production's six capture methods.** Each is independently
   activatable and autonomous to ready-to-distribute. Unclear whether proof
   production feeds campaigns or runs purely on its own cadence, which decides
   whether it belongs in Phase 3 beside the other factories or stands alone.
2. **Intelligence OS quality gate.** The notes ask for repetition testing with
   the answers scanned for false information. That is a quality exercise rather
   than a build, and it gates everything downstream because all business
   context originates there. Phase 0 task with a real output-quality gate, or
   run alongside?
3. **Approval route mapping** before Phase 2 rather than during Phase 4.

## Carried over from v6

Recorded in `V6_MERGE_ARCHIVE_RECORD.md` and still open:

- #254 and #298 are cherry-pick sources, never merges: pre-renumber migration
  filenames collide with versions already applied
- #257 (Q012 backup route) and #267 (Q014 secret custody) are blocked on
  decisions only Alex can make
- the `if:` guard on `production-release-approval.yml`, which currently reports
  red on every pull request, folded into the same pass as the
  `verify-github-release-candidate` workflow-file guard
- the fourteen-file stale migration-number doc sweep
- leaked-password protection is disabled in Supabase Auth

## A process note worth keeping

Two incidents during the v6 deploy — the runtime refusing to boot on
32-character secrets, and the paid widget silently refusing every request —
were both written down in #254's release hold before they happened. The
schema-first order was right; what was missing was reading the preconditions
attached to it. Those preconditions belong in a checklist, not in runbook prose.

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

**Not** Motion Design. The notes say it "can be left alone for now as I believe
we will discontinue it" — left alone, not removed. An earlier draft of this plan
listed it here *and* under deferred, which contradicted both the notes and
itself. It is deferred, and a v6.2 candidate on Alex's word rather than
inference.

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

### 1.2a The Evaluate and Strategise agents need a decision first

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

## Phase 2 — the campaign spine

3. **Campaign planner agent** — decides landing page or not, sales agent or not,
   organic volume and type, paid volume and type, pillars and positioning per
   route.
4. **Plan review gate** — correctable in the Inbox or in the campaign before the
   agent runs.
5. **The single multi-step sweep** — one run driving every asset to
   ready-to-distribute by calling the factories, each process individually.

## Phase 3 — the factories the sweep calls

6. **Website Studio** — five tabs collapse to a Sites table plus build buttons
   for landing pages and offer pages; agent builders; autonomous under the
   campaign worker; publish to GitHub after approval.
7. **Lead Magnet Studio** — one page, table plus a build button. Download only,
   no distribution. Opt-ins dropped.
8. **Sales OS** — Agents becomes the main table page. **Pipeline CRM moves to
   Attribution OS.** The agent distributes to its associated page without a
   developer. Capture portal left alone for now.
9. **Content Production tuning** — the two named defects: video generation, and
   the text inside image content. Repetition, not architecture.

## Phase 4 — the gate and distribution

10. **Approval Inbox unification** — four views into one. The notes say the
    approval routes are "specifically unknown", so the existing routes need
    mapping before any UI work, and that mapping should happen before Phase 2's
    plan review gate depends on it.
11. **Distribution workers** — organic on a cron schedule, paid bundles handed
    to the human paid-ads operator, page published to GitHub, lead magnet bundle
    delivered.
12. **Proof Distribution** — ten destinations as individual connect-modules,
    plus a Distribution Log table of what went where and when.
13. **Organic Content Distribution** — Destinations (Facebook, Instagram) plus a
    Distribution Log. The Engine tab retires into the Dashboard switch panel.

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
- **Motion Design** — see 0.3
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

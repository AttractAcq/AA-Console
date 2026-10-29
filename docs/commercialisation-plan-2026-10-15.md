# Finishing the build, then commercialising AA — 15 October 2026

Written against the strategic objective Alex set today: AA is the business that
generates capital, builds a team and develops operational capability, and must
become an asset rather than another job. Every item below is judged by one
question — does it help AA acquire customers, increase profitability, improve
delivery or reduce founder dependency? Items that do none of those are named
and dropped.

Read alongside `v5-backend-capability-map.md`, which holds the engineering
ledger. This document decides what "finished" means and what happens after.

---

## 1. Where this actually stands

Counted on production (`bancbdztffokwiifzoiv`) on 15 October, not inferred from
documents.

### The build is healthy

| Check | Result |
|---|---|
| `tsc -b` (console) and `tsc -p tsconfig.json --noEmit` (runtime) | Both clean |
| CI on PR #193 — frontend, agent runtime, MCP gateway | All three pass |
| Deployed runtime | Live, two workers, `V5_WORKFLOW_ENABLED=true` |
| Migrations | Through 210 applied; repo, staging and production agree |
| Open PRs | #193 (ready, mergeable); #141, #119, #107 (stale drafts) |

The engineering is not the problem. The workflow spine, the exact four-asset
daily planner, candidate lineage, bounded recovery, the launch manifest and the
attribution report are all code-complete and deployed.

### The commercial side is empty

| What a buyer would ask about | Production today |
|---|---|
| Paying clients | 1 contract row — Harbour Dental, `Growth — organic + paid`, £18,500/mo, signed 11 May 2026. Holdfast and WatchSchedule are `Internal — no fee`. **Alex to confirm whether Harbour Dental is billing revenue or a realistic seed row.** |
| Leads captured | `client_leads` = **0** |
| Measured results | `metrics_daily` = **0**, after **11 completed** `metrics_ingest` jobs, the last on 15 October. Meta, Facebook and Instagram integrations exist for one client since 4 October. Ingestion runs and writes nothing. |
| Published posts | `platform_publishing` = 5, recorded by hand. There is no publishing tick. |
| Content slots | `content_slots` = **0** |
| Human approvals outstanding | `approvals_queue` = 86 rows |

So the console can plan, generate and internally QA work, and it cannot yet
show a single measured outcome for a single client. That is the gap that
matters commercially, and it is much cheaper to close than the one currently
absorbing all the attention.

### Where the attention has gone

Nine daily packages and nine workflow runs exist. Almost all reached **3 of 4**
assets internally accepted and blocked on the reel. One (19 October package)
reached 4/4 and still has `review_status = pending` with no human approval.

`video_edit`: 7 completed, **13 failed**. PRs #179 through #193 — fifteen
merged releases between 9 and 15 October — are all reel quality: hook phrasing,
caption budget, end cards, CTA layout, cast continuity, brand safety, source
rebuild, opening state. The defect class has not changed: the motion model does
not perform the briefed physical action, so the first frame settles instead of
moving, props drift, and generated lettering appears where none was asked for.
Higgsfield's API balance is $15.04 and each loop spends real money.

This is a provider capability limit being treated as a sequence of code bugs.
It has produced zero accepted reels, and it is the single largest consumer of
founder time in the business right now.

---

## 2. What "finished" has to mean

The feature definition of finished — every v5 gate closed, reels generated
autonomously at premium quality — does not serve the objective. It has no
date, it depends on a third-party model's behaviour, and AA cannot invoice it.

**Finished means: AA can take a client from signed contract to launched
campaign to a daily approved package with measured leads, repeatably, without
Alex writing code or producing assets by hand.**

That is the state in which the console is an operational capability rather than
a project. Note what it does not require: it does not require the reel to be
generated end to end by a model. It requires a reel to exist, be on brand, be
approved and be published on time.

### The five gates, re-scoped against that definition

| v5 open gate | Keep as written? | Finishing definition |
|---|---|---|
| Reel accepted by internal QA and owner/SMM | **Re-scope** | A reel that ships on brand and on time, by whatever route produces it reliably. Autonomy is an efficiency target, not a release gate. |
| Seven consecutive four-asset days before cutoff | **Keep** | This is the delivery-reliability proof a client is buying. It is a gate about the *package*, not about the reel's provenance. |
| Launch package conversion probe and sales-agent scenarios | **Keep, raise priority** | This is the "launch in 24 hours" promise. It cannot be sold untested. |
| 24-hour launch dry run | **Keep** | Same. |
| Attribution and evidence-fed learning against observed outcomes | **Keep, raise priority** | With `metrics_daily` and `client_leads` at zero, there is nothing to attribute. This is the sales proof asset. |

---

## 3. The decision that unblocks everything

The reel route needs a policy, not another PR.

**Recommendation: timebox autonomy, ship a human-finish fallback now.**

1. Give the autonomous route **one** more bounded attempt: the frame-zero
   opening state from PR #193 carried into a fresh brief and one live run. That
   is the first test of the new contract; the last rebuild used an older brief,
   so nothing has yet validated it.
2. In parallel, build the fallback: when a reel's candidates fail creative QA,
   the package offers the six stored Higgsfield clips and the accepted caption
   plan for a **human finishing cut** — one editor, twenty minutes, inside the
   existing approval chain and versioning. The package reaches 4/4 and the
   seven-day gate becomes reachable this week instead of unbounded.
3. If the bounded attempt fails, stop reel-model work entirely until AA has
   paying clients. Revisit with a different provider or a template-driven
   motion route when there is revenue to fund the experiment, not before.

Against the filter: the fallback improves delivery and removes founder
dependency immediately. Continuing the autonomous loop improves neither until
it succeeds, and it has not succeeded in fifteen releases.

---

## 4. Finish order

Each step is a reviewable PR under the existing release boundary. Nothing
merges, migrates or deploys without Alex.

**P0 — Clear the decks (days)**
- Merge #193 once Alex clears it, and run the one bounded reel attempt above.
- Close or explicitly park #141, #119, #107. Stale drafts cost review attention.
- Record the reel policy decision in `v5-backend-capability-map.md`.

**P1 — Make a package completable (days)**
- Human-finish fallback for a failed reel, inside the existing candidate and
  approval contracts. A finished cut is a versioned artefact like any other.
- Clear the 19 October 4/4 package through actual human approval, so one
  package has traversed the whole chain including the human gate.
- Then run the seven-consecutive-day gate for Attract Acquisition as client
  zero. *Improves delivery; removes the reel from the critical path.*

**P2 — Switch measurement on (days)**
- Find why 11 completed `metrics_ingest` jobs wrote 0 rows to `metrics_daily`,
  and make one real client-day of metrics land.
- Make `client_leads` capture a real lead end to end from a published asset.
  *This is the proof a prospect asks for. Highest commercial value per hour of
  work in the whole plan.*

**P3 — Remove the daily founder task (1–2 weeks)**
- A publishing tick, so an approved asset posts itself on schedule rather than
  Alex posting it and `record_publication` marking it afterwards.
  *Without this, every new client adds daily founder labour and the business
  cannot take client #2 without getting worse.*

**P4 — Make the launch promise real (1–2 weeks)**
- The trusted conversion probe: form or conversation to lead, routing, consent,
  event capture, sales-agent scenarios. Then the 24-hour dry run on a real new
  client's inputs. *This is what gets signed.*

**P5 — Then stop building.**
- Attribution report populated with observed leads becomes the case study.
- Everything past this point waits behind paying clients.

### What to drop or defer
- Autonomous premium reel generation, unless P0's bounded attempt passes.
- The content engine proposal (#119) as a separate build — the v5 spine
  supersedes it.
- The public landing page PR (#141) as engineering work; AA's landing page
  should be produced *by* the console's `landing_page` agent as client-zero
  work, which is both cheaper and a proof point.
- Any further schema or quality work that does not sit on P1–P4.

---

## 5. Commercialising AA with the console

The sequence only starts once P1–P2 are done, because before that there is
nothing to show.

**Step 1 — AA as client zero, visibly.**
AA already has nine packages and three campaigns in the console. Run AA's own
daily package through the finished chain for two weeks and publish it. The
output is simultaneously AA's marketing, the delivery rehearsal, and the proof
that the system runs. Founder time goes into approvals, not production.

**Step 2 — Decide what is actually sold.**
Two sellable units exist and both are nearly provable:
- *Launch package* — campaign plan, landing page, sales agent, organic creative
  set, paused Meta handoff, measurement, inside 24 hours of complete inputs.
  One-off fee.
- *Daily package* — one reel, one story, two statics per client-day, approved
  by the client in the console, published on schedule, with measured leads.
  Monthly recurring.

Sell delivery reliability and speed. Do not sell autonomy: it is not proven,
and the client does not care who moved the pixels.

**Step 3 — First three paying clients.**
One niche, one playbook, three times. Harbour Dental's vertical is the obvious
first pick because the console already holds real strategy, pages and brand
rows for it. Use the launch package as the paid entry point — it is a discrete
deliverable with a 24-hour promise, which is easier to sell cold than a
retainer — then convert to the daily package.

**Step 4 — Only then systemise and hire.**
Phase 2 and 3 of the objective are earned by repetition, not anticipated by
architecture. The console already records SOPs, assignments, work logs and
approvals; the first hire's job description should be written from what the
seven-day gate and the first three launches actually cost in founder hours.

### The honest constraint
AA has one contract row and no measured client outcome. Until P2 lands, the
console cannot answer "what results have you produced?" — and no amount of
further engineering changes that answer. That is why measurement outranks the
reel.

---

## 6. Open decisions for Alex

1. **Reel policy.** Bounded attempt plus human-finish fallback, as recommended
   above? Or keep pursuing the autonomous route without a timebox?
2. **Harbour Dental.** Real billing client, or a realistic seed row? The answer
   changes whether Phase 1 of the objective is at one client or zero.
3. **Merge authority for the finish order.** The v5 note records authorisation
   to merge, migrate and deploy; `AGENTS.md` still names the Phase 6 boundary.
   Confirm which applies to P1–P4 so work does not stall at each release.
4. **Who edits a fallback reel.** Alex, or the first contracted editor? This is
   the first real test of whether delivery can leave the founder.

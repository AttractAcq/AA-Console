# The proprietary tools layer — what exists, what does not

AA Console is the layer the nine proprietary tools live in, and the surface ten
bots operate through. This document maps each tool to what is actually built
today, measured against the running database and the navigation tree rather
than recalled.

Companion to `gap-audit.md`, which tracks correctness and operational gaps.
This one tracks *product* gaps: the distance between the console as it is and
the nine tools it is meant to become.

Measured 7 September 2026: 45 tables, 16 agents, 25 admin nav entries.

---

## Scoring

- **Built** — exists and does the job the tool description asks for.
- **Partial** — a real implementation of part of it, with a named shortfall.
- **Stub** — a table or page exists, but not the capability.
- **Missing** — nothing.

---

## 1. Content Production OS — *Partial, and much further along*

The biggest tool, and the one with the most already standing.

| Module | State | What exists / what is missing |
|---|---|---|
| Ideation | **Built** | `client_ideas` (51 rows), ideation agent, Ideation → Generation. Has idea bank, status, selection, metadata |
| Brief Studio | **Built** | Twelve fields on `client_briefs`; the agent emits them and the readable body is composed from them, so prose and structure cannot drift. Video-only fields are absent on stills rather than blank. Proved live: HD-0016 came back with a real hook, shot list and B-roll, and stated "no proof point is used, deliberately" rather than inventing one |
| Production Router | **Partial** | `ApproveAndBuildModal` routes AI vs human, editor vs avatar. Missing: **AI video**, **client-created**, **AA internal**, and any *recommendation* of a method |
| Work Assignment | **Partial** | `brief_dispatches`, `job_assignments`. Missing the state machine: assigned → accepted → in production → submitted → revisions → approved |
| Asset Intake | **Partial** | `client_media_assets` takes uploads and generated output. No raw-footage / thumbnail / audio distinction |
| Repurposing Engine | **Built** | Eight formats; each produces a derivative *brief* rather than a fake file, since AA cannot cut video. Proved live: HD-0015 became a reel brief with a shot list and a text-post brief without one, and the two hooks were written differently for their formats rather than translated |
| Approval System | **Built** | `client_asset_reviews` with mandatory reasons, Approvals page, decision history on the asset |
| Distribution Engine | **Partial** | `scheduled_posts` schedules. **Nothing actually posts** — there is no publish step to any platform |
| Performance Layer | **Stub, but the plumbing is there** | `metrics_daily` has 0 rows, blocked on Meta. The chain back to the idea *does* exist and traverses: `metrics_daily.post_id → scheduled_posts.asset_id → client_media_assets.brief_id → client_briefs.source_idea_id`. Verified on real data — HD-0015 walks all four hops. What is missing is data, and anything that reads it |
| Iteration Engine | **Missing** | Nothing learns. This is the module that makes the loop compound |

**The Iteration Engine is now the only module of this tool that does not
exist.** Brief Studio came first because Iteration learns against `hook` and
`call_to_action`; Repurposing came second because a derivative is written from
those same two fields. Iteration itself is blocked on metrics, not on design —
the chain it would read already traverses.

Repurposing also widened attribution rather than complicating it: a derivative
brief records `derived_from_asset_id`, so a reel's performance can be traced to
the static ad it came from as well as to the idea underneath both.

**One thing to know about assets created outside the pipeline.** HD-0001 and
HD-0002 are uploads with no `brief_id`, so they fall out of the chain above by
construction. Attribution will always be partial for anything not produced
through a brief.

## 2. Conversion Site Builder — *Built to the console's actual job*

Scoped deliberately. The console is not a website builder: its job is to
**aggregate everything the business knows, hand it to an agent behind one
button, and show what came back**. The agent writes the page.

So `Build Page` now gathers business context, offer strategy, ICP, brand
strategy, **the brand profile including its palette, typefaces and the client's
own custom CSS**, the real contact identity, and **only cleared proof** — then
the agent returns one self-contained HTML document. This is the first consumer
of `client_brand_profiles.custom_css`, which had been stored and read by
nothing.

The Conversion tab shows the rendered page, the code behind it, a mobile width,
and a clickable link to where it is live.

**Three defences against generated script, because the preview renders model
output inside a console holding an admin session against every client's data:**
the agent is told never to emit script; the runtime rejects a page containing a
`<script>`, an inline event handler or an `<iframe>`; and the preview frame is
`sandbox=""` with `srcDoc` — no `allow-scripts`, no `allow-same-origin`. The
third is the only one that holds if the first two are wrong.

Still open: deploying a page anywhere (`published_url` is set by hand), page
types beyond landing and offer, and section-level editing. A page is one
document, so changing the hero means rebuilding it — which is the trade this
scoping accepts, since the bot regenerates rather than edits.

## 3. Sales Agent Builder — *Missing entirely*

Nothing exists. No table, no page, no agent. The whole tool is unbuilt:
knowledge base, sales instructions, qualification logic, objection handling,
CTA/booking rules, agent testing, deployment, conversation logging, learning.

## 4. Revenue Pipeline OS — *Built*

The acquisition chain, in the order it happens: lead → conversation →
qualified conversation → appointment → qualified appointment → showed → sale →
cash, with lost as its own end.

**Attention is deliberately not a stage.** Attention is impressions and reach,
which live in `metrics_daily` against a post; a lead begins when attention
becomes a name someone can contact. Modelling it here would double-count it and
put a column on the board that nobody can act on.

Each lead carries an owner, a **next action** and its due date, an opportunity
value, sale value and cash collected, an appointment with its own outcome, and
— the columns everything downstream depends on — **where it came from**:
channel, and foreign keys to the page, asset, post or campaign that produced
it. Without those, revenue can never be traced back to the content that caused
it, and the Iteration Engine has nothing to learn from.

`lead_events` records everything that happens to a lead **including stage
changes**, so "how long did this sit in qualified conversation" is answerable
rather than lost to an overwritten notes field. `advance_lead` moves a lead and
writes its event in one statement, so the two cannot come apart, clears the
next action that has just been completed, and refuses to mark a lead lost
without a reason — a lost lead with no reason teaches nothing.

`stalled_leads` answers the question the tool exists for: leads with nothing
scheduled next, or something overdue, oldest first. `cash` and `lost` are
excluded because they are finished rather than neglected. It leads the page,
above the board — a board shows the shape, this shows the work.

Proved on staging: of five leads, the two genuinely stalled were returned and
the healthy, the collected and the out-of-window ones were not; `advance_lead`
moved a stage, cleared the completed action, wrote the event with both stages,
and refused a lost with no reason.

The old `pipeline_stage` enum (`first_touch`, `second_touch`, `call_booked`) is
left in place, unused. Its values do not map onto the chain and the table held
no rows, so a new `lead_stage` was cleaner than mapping by guesswork.

Still open: nothing writes a lead automatically. Leads arrive by hand until a
conversion page or a sales agent creates them, which is tools 2 and 3.

## 5. Client Delivery OS — *Partial*

`client_onboarding_steps`, `client_assignments`, the Delivery Dashboard and the
whole Account section exist.

But the dashboard answers "what have the agents done", not **"what needs to
happen next for this client"**. Missing: delivery plan (what AA promised),
milestones, dependencies, deliverables, health (results, communication,
approvals, overdue, sentiment, scope), risks with owner and escalation, and
**next best action** — the single highest-value thing in the description.

## 6. Proof & Asset OS — *Built, and now waiting on people rather than code*

Proof is a structured record: type, claim, evidence, avatar relevance, service,
strength, usage rights, captured and expiry dates, on the same per-client
reference sequence as briefs and assets.

`usable_proof(client, avatar, limit)` answers the question the rest of the
stack depends on — **the strongest proof a client may actually use** — filtered
to cleared and unexpired, strongest first. Proved on staging against six
deliberately awkward records: a high-strength but uncleared one, a restricted
one and an expired one were each excluded, and a different-avatar one dropped
out under a filter.

**Usage rights default to `not_cleared`, deliberately.** A customer result
needs permission before it appears in advertising, so nothing is usable until a
person says it is. That means the two existing records stopped being offered to
agents the moment this shipped, which is correct rather than convenient, and
the Proof Bank leads with the gap: *"1 of 3 cleared for use — the rest are not
offered to any agent."*

The brief agent now reads this instead of a flattened list, and can tell "none
exists" from "some exists, nobody cleared it" — different problems needing
different action, and only the second is a job someone can do.

A brief now **links** to the proof it relies on rather than naming it in prose.
The agent chooses from an enum of the references it was actually offered, so an
invented reference is impossible to submit — the same failure as an invented
phone number, one step earlier — and the choice is resolved back to a foreign
key rather than trusted as text. A derivative inherits its root's link, because
the claim carries over and re-asking a model could reach a different answer for
the same piece. The brief view shows the backing claim and warns when a proof
has since lost its clearance, since a brief can outlive the permission that
justified it.

**Proof Finder** closes the other half: an agent that searches the web for the
proof a business has already published — reviews and ratings, directory
listings, press, awards, registrations, case studies — and files each find as a
structured record.

Built as a native agent rather than as instructions for a bot to follow,
because the runtime already carries web search and an agent writing structured
records lands the result in the shape the rest of the system queries. A bot
following instructions produces prose somebody then retypes.

Two rules shape it. **Nothing without a URL is filed** — a claim nobody can
open looks like evidence and is worse than nothing. And **nothing a machine
found is ever cleared**: finding a review is not permission to advertise with
it, and the agent cannot know whether a customer agreed to be quoted. Both are
enforced in code and both are tested, after mutation testing showed the
clearing rule could be flipped without a single test failing.

**What is left is data entry, not code.** Both original records need a claim,
an avatar and a rights decision. Still deferred: several evidence files per
proof, since the table holds one `storage_path`.

## 7. Attribution & Reporting OS — *Stub*

Reporting has five tabs, a `reporting` agent and a `metrics_ingest` agent.
`metrics_daily` has 0 rows, blocked on Meta.

Even connected, it would be platform metrics only. The tool's actual purpose —
**what caused what**, campaign → content → distribution → lead → conversation →
appointment → sale → cash — has no representation at all. None of the five
example questions ("which ten assets created the most revenue") can be answered
by the current schema, because nothing links an asset to revenue.

## 8. Campaign Execution Builder — *Stub*

`campaigns` (5 rows, 14 columns) under Operations, plus a `campaign_intel`
agent that produces strategy records.

The existing table tracks spend and status. The tool is an **orchestrator**:
objective, audience, offer, message, proof, channels, budget, assets required,
landing page, sales agent, distribution schedule, dates, KPIs — and then it
invokes tools 1, 2, 3, 4 and 7. That orchestration does not exist.

## 9. Client Economics OS — *Missing*

`client_billing`, `contract_payments`, `finance_entries`, `finance_periods` and
Admin → Financials all exist — but these are **AA business finance**, which the
architecture explicitly separates from client economics.

Client economics — ad spend, lead cost, appointment value, customer value,
revenue generated, ROAS, CAC, payback — is unbuilt. `campaigns` carries
`daily_spend` and `total_spend`, and nothing joins that spend to revenue.

---

## Where the console already is genuinely strong

Worth stating, because the gaps above are long and the foundation is not thin:

- **The agent runtime.** 16 agents, durable queue, leases, retries, per-attempt
  deadlines, cost tracking. This is what the bots will actually execute through.
- **Intelligence and Strategy.** Seven intelligence tabs and three strategy
  tabs, 57 records against 81 templates. This is the input every other tool
  needs and it is done.
- **The build pipeline.** Idea → brief → concept → render → review → schedule
  works end to end, with brand and identity enforced at both stages.
- **Isolation and audit.** RLS proven across two live client logins, decisions
  recorded with reasons, everything client-scoped.

## The shape of the remaining work

Built: 1 (bar its Iteration Engine), 2, 4 and 6. Partial with real substance:
5. Stubs with a page and a table: 7 and 8. Unbuilt: 3 and 9.

The dependency worth noticing: **7 (Attribution) is what makes 9 (Economics)
possible, and 1's Iteration Engine depends on both.** Revenue cannot be
attributed to an asset until leads and sales are modelled, which is tool 4. So
4 → 7 → 9 → the Iteration Engine is a single chain, and it is the chain that
turns the console from a production tool into a compounding one.

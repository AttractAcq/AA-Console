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

"Built" is a claim about the code, not about use. Three tools are built,
mutation-tested and proved on staging but have **never run in production** —
their agents have zero jobs against real data. That is recorded here rather
than rounded up to Built, because the difference is the whole gap between a
tool that works and a tool that is working.

## Where the nine stand — 11 September 2026

| # | Tool | State | The one-line shortfall |
|---|---|---|---|
| 1 | Content Production OS | **Partial** | Iteration Engine doesn't exist; nothing publishes automatically |
| 2 | Conversion Site Builder | **Built, never run** | No page in production has HTML — the agent has never been run |
| 3 | Sales Agent Builder | **Built, never run** | Nothing serves a visitor, so no conversation has ever happened |
| 4 | Revenue Pipeline OS | **Built** | Leads arrive by hand or from a sales agent; no page form writes one |
| 5 | Client Delivery OS | **Partial** | Still answers "what have agents done", not "what's next for this client" |
| 6 | Proof & Asset OS | **Built** | 0 of 2 records cleared for use — data entry, not code |
| 7 | Attribution & Reporting OS | **Built (revenue half)** | Attention half is zero: `metrics_daily` has no rows |
| 8 | Campaign Execution Builder | **Built, never run** | No campaign has been planned; content attaches rather than auto-generates |
| 9 | Client Economics OS | **Built** | Manual spend operational; Meta remains an ingestion adapter |

Measured against the production database, not recalled: 2 leads, 0
`metrics_daily` rows, 0 `client_integrations`, 12 repurposed briefs from 6
completed `repurpose` runs, 2 proof records with none cleared, and zero
`landing_page`, `sales_agent` or `campaign_plan` jobs ever enqueued.

**Release risk worth recording (not Phase 9's to fix).** Migrations applied
through the Supabase API are recorded under an apply-time version, not their
filename version, so `schema_migrations` and the filenames can disagree.
`67_sales_agents` is recorded as `20260908192515` against a file named
`20260908220000_67_…`, and `79_client_marketing_spend` as `20260911205529`
against `20260911000000_79_…`. `72_campaign_execution` has two rows because a
later CLI push reconciled it; `72_mcp_cos_orchestration` has **none** — it is
applied in production but unrecorded, and shares the version prefix
`20260909020000` with `72_campaign_execution`. A rebuild from files would
therefore re-run some migrations and skip others. The fix is a reconciliation
pass over `schema_migrations` plus renumbering the duplicate 72; both belong to
whoever owns the release process.

**The MCP work is a different layer.** Phases 3–12 — bot auth, domain RLS,
Production Manager, Distribution Manager, Marketing Director, Sales Ops, Chief
of Staff orchestration — give the bots scoped access to these tools. They are
layer 3 of the architecture, not the tools themselves, so none of them moves a
row in this table. `mcp_internal.mcp_delivery_tasks` is a bot task ledger, not
tool 5.

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

## 3. Sales Agent Builder — *Built; deployment to a live page is the open half*

The agent a client's own visitors talk to. Tool 2 builds the page; this builds
the thing standing on it, and the console's job is the same in both: gather
everything the business knows behind one button, hand it over, and then show
what came back.

What comes back is not HTML. A client-facing sales agent **is** its operating
definition, so that is what `client_sales_agents` holds: how it opens, the
qualification questions in the order they are asked, the objections this ICP
actually raises, when it books, when it hands over, and what it may never
promise. Qualification is `[{question, why, good_answer, disqualifier}]` rather
than prose, so a bot can revise one question later without rewriting the agent.

**The stakes are why this is not just page copy.** A bad page is bad copy. A
bad sales agent repeats an invented promise to a client's own customers at
whatever rate the client sends traffic. So the offer strategy's stated limits
arrive as hard guardrails, only cleared proof is quotable, and the agent is
told never to claim to be a person. The console puts **"Never says" above the
script** when you open an agent, because that section is what decides whether
it is safe to deploy.

Six rules refuse a definition rather than storing it: no greeting, operating
instructions too thin to run on, fewer than three qualification questions, no
booking rule, no escalation rule, no guardrails. Two more coerce model output —
a qualification step with no question is dropped, an objection with no answer
is dropped — and an unfilled `[PLACEHOLDER]` or `{{variable}}` anywhere a
visitor would read it is rejected outright.

**Conversations become leads, which is the hole tool 4 was left with.**
`capture_sales_agent_lead` turns a conversation into a `client_leads` row
attributed to both the page and the agent — the page earned the visit, the
agent earned the contact, and only `source_sales_agent_id` can tell a good
qualification script from a good page. It is idempotent by construction: the
conversation holds the lead it created, so a visitor who refreshes and finishes
twice is still one person. It refuses a conversation that captured no way to
contact anyone. A captured contact lands at `conversation`, never at `lead`,
because a conversation demonstrably happened; the agent's own judgment of fit
lifts it to `qualified_conversation` and nothing there claims an appointment.

Proved on staging end to end: a no-contact conversation was refused, an
unqualified one landed at `conversation` with both source keys and its
opportunity value, capturing the same conversation twice returned the same lead
and left the client on one lead, a qualified one landed at
`qualified_conversation`, both wrote their `lead_events` row, and a stranger
with a real conversation id was refused for its own reason — "Not permitted for
this client" — while the same row captured cleanly as `service_role`, so the
refusal was the permission check and not a missing row.

Conversations are kept **whether or not they produced anything**. The ones that
went nowhere are what show which question is losing people, and a system that
only stored wins would throw exactly those away.

**What is open: nothing yet talks to a visitor.** The definition is built,
reviewable and safe; the runtime that serves it on a live page, and the widget
that embeds it, are not written. Until then `sales_agent_conversations` fills
only if something else writes to it, and the panel says "No conversations yet"
rather than implying silence is a result.

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

Leads no longer only arrive by hand: `capture_sales_agent_lead` (tool 3) writes
one from a sales agent conversation, attributed to the agent and the page. What
is still missing is a page form that does the same without a conversation.

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

## 7. Attribution & Reporting OS — *Built on the revenue half; the attention half waits on Meta*

The point of this tool is not a dashboard. It is to answer **what caused
what** — and specifically to let AA say "R2,000 of spend created R38,000 of
closed revenue" instead of "84 leads".

`content_attribution` walks the chain the business actually runs:

```
idea → brief → asset → post → (attention) → lead → sale → cash
```

Each asset carries its idea's hook and angle, its brief's reference, where it
was posted, and the leads, sales and cash collected behind it. A lead counts
against an asset if it names **either** the asset or the post it came from —
both paths are real in the data, and matching on only one silently loses half
the revenue.

Two functions sit on top. `top_content_by_revenue()` ranks content by cash
collected rather than by reach, which is the ranking the ranking is for.
`acquisition_funnel()` returns the stage counts and the three ratios between
them.

**The funnel returns `null`, not `0`, when a ratio is unknown.** No leads yet
is not a 0% close rate — it is an unanswered question, and a 0% displayed to a
client is a claim about their business that the data does not support. The
panel renders those as "—" with the reason. This was the first thing mutation
testing checked: replacing the nulls with zeros must, and does, fail the tests.

Proved on staging against a seeded chain end to end: two leads, one sale,
R38,000 collected, correctly attributed back through post *and* asset, while an
unattributed walk-in lead stayed out of the content view and inside the funnel
totals — which is exactly right, since the revenue is real even though its
cause is unknown.

**Two honest limits, both written into the migration:**

- **Attention is zero until Meta is connected.** Impressions, reach and clicks
  come from `metrics_daily`, which has no rows. The revenue half of the chain
  works today; the top of the funnel is a shape with no numbers in it, and the
  panel says so rather than showing zeros as though they were measurements.
- **Stage counts are by *current* stage, not furthest reached.** A lead that
  bought is counted at "sale", not also at "appointment", so the funnel
  understates the upper stages. `lead_events` records every transition, so
  furthest-reached is derivable later without a schema change.

## 8. Campaign Execution Builder — *Built; content attaches rather than auto-generates*

The orchestrator. A campaign brief becomes a plan, the plan becomes real rows
in the other tools, and the campaign cannot launch until those rows actually
exist.

`campaigns` already existed and is an **ad-platform tracker** — target_role,
daily_spend, external_id. Conflating the two would have meant a campaign could
not be planned before somebody opened an ad account, so `client_campaigns`
holds the plan and links to the ad campaign when there is one.

**The Campaign Planner** writes objective, audience, offer, core message,
channels, budget, dates, KPI — and, critically, the numbers that say what must
be built: how many pieces of content, whether it needs a landing page, whether
it needs a sales agent. A plan asking for **nothing** to be built is rejected
rather than stored: it would report itself ready the moment it was written,
which is the exact false "ready" this tool exists to prevent.

The planner also refuses to invent. A budget, date or target it has no basis
for is omitted rather than guessed, because an invented number here becomes a
commitment somebody else has to meet. `asAmount` therefore distinguishes a real
zero from an unknown, and `asDate` rejects anything Postgres would choke on —
a malformed date would fail the whole write and lose a plan already paid for.

**`provision_campaign` is the orchestration**, and it is real: one call creates
the `client_pages` row and the `client_sales_agents` row, queues the
`landing_page` and `sales_agent` agents against them, attaches the agent to the
page it was built with, and records each as a `campaign_artifact`. It is
idempotent, because the common way to break a build button is to press it
twice.

**Readiness is derived, never stored.** `campaign_readiness` computes every
requirement from the artifact itself:

- A landing page counts when it has **HTML**. A page row carrying a brief is a
  request, not a page.
- A sales agent counts when it is **built and live**. Built-but-draft is the
  state that would otherwise launch a campaign pointing at an agent nobody
  turned on.
- Content counts when a brief is **written** or an asset is **approved**. A
  queued brief is an intention.

`launch_campaign` refuses until every one is met and names the specific missing
requirement, because "not ready" tells whoever pressed the button nothing they
can act on. The console shows that refusal verbatim.

Proved on staging, twice — once against the functions and again against the
migration file itself after dropping everything, so the evidence is the file
rather than a hand-patched database. An unplanned campaign failed all four
checks; provisioning refused without a plan; launch refused naming the missing
content; provisioning then created two artifacts and queued both jobs; a second
call created nothing; a page row with no HTML still did not count; a built but
draft agent still did not count, with the right reason; and only once the page
had HTML, the agent was live and two briefs were written did it launch. A
stranger was refused on all three RPCs for their own reason while the same rows
read cleanly as `service_role`.

**What is open: content attaches, it does not auto-generate.** Ideation is
client-level, not campaign-level, so a campaign's content is linked from what
tool 1 produces rather than commissioned by the plan. Wiring ideation to a
campaign is the remaining half of "invokes tool 1", and it is deliberately not
faked here — the readiness count is honest about what is attached.

## 9. Client Economics OS — *Built. Manual spend operational; Meta is an adapter, not a missing capability*

The tool that answers what is economically happening for a client: what was
spent, what it bought, and what acquisition costs.

**It was never really blocked on Meta.** It was blocked on there being no
canonical place to put a cost. Four tables looked like one and none was:
`finance_entries` and `finance_periods` are **AA's own P&L** — that `cac` is
what it costs AA to win a client, not what it costs a client to win a customer;
`client_billing` is what a client pays AA; `contract_payments` is what AA pays
contractors. `campaigns.total_spend` was closest and still unusable, because a
lump sum covering a two-month campaign cannot answer "spend in the last 30
days".

`client_marketing_spend` is that canonical ledger. Manual entry works today and
Meta, Google and file imports become **adapters writing into the same table** —
the engine never branches on where a row came from. Import duplication is
guarded per `(client_id, source, external_ref)` rather than globally, because
two providers can legitimately emit the same id and a global constraint would
reject the second as a duplicate of something unrelated.

### The window is the cohort, not the revenue period

"Last 30 days" means: spend recorded in those 30 days, leads **acquired** in
those 30 days, and what those leads have produced so far. It does **not** mean
revenue that landed in the last 30 days.

That was forced by the schema, and the audit is worth recording. `client_leads`
has no sale date and no cash date; `sale_value` and `cash_collected` are
running totals. Event-period reporting would therefore have to pair "the date
the sale transition happened" with "the amount as it stands today", which
breaks twice: a closed month would change when an old deal is topped up, and
cash collected in instalments has no history to split at all — and Cash ROAS is
the metric AA's whole economic claim rests on. Cohort economics pairs spend with
the revenue that spend actually bought, which is also what makes CAC mean
anything. It is additionally what `acquisition_funnel` already did, so the two
surfaces agree rather than disagreeing about revenue while agreeing about spend.

The cost is stated in the UI rather than buried: **a young cohort understates.**
September's ROAS is a floor that rises as those leads close.

Event-period reporting needs a dated revenue ledger — `lead_revenue_events`
with `amount` and `occurred_at`. That is the enabling change and belongs in the
Revenue Pipeline / Attribution sweep, not here.

### Counting by furthest stage reached

Counting by *current* stage is the trap: a lead sitting at `cash` would not be
counted as having had an appointment, so cost-per-appointment would be wildly
overstated. `lead_progress` takes `greatest(current stage, max(lead_events))`,
which also solves the legacy case without a branch — a lead with no events falls
back to its current stage, and that is half the leads in production today.

Proved on staging: a lead that went conversation → appointment → **lost** is
credited with the appointment it reached and flagged `ever_lost`; a lead at
`sale` with no events at all still counts as a customer.

### Metric contract

| Metric | = | Null when |
|---|---|---|
| CPL / CPQL / CPA / CAC | spend ÷ leads / qualified / appointments / customers | that count is 0 |
| ROAS | `sale_value` ÷ spend | spend is 0 |
| Cash ROAS | `cash_collected` ÷ spend | spend is 0 |
| RPL / ACV | `sale_value` ÷ leads / customers | that count is 0 |

Qualified is furthest rank ≥ 3, appointments ≥ 4, customers ≥ 7. `until` is
exclusive. A window mixing currencies returns spend but **nulls every ratio** —
a ratio across two currencies is not a number. v1 assumes one currency per
client, which every ratio already implied, since `client_leads` carries no
currency at all.

**One display rule sits above the maths.** When spend exists and revenue is
zero, ROAS is mathematically `0.00`, and the database returns that. The panel
shows "—" with *"No revenue from this cohort yet"*, because a bare 0.00 reads as
"this failed" when the truth is "nothing has landed yet". The RPC still returns
the true 0.00 for anything calling it directly.

### Attribution

Channel economics matches `spend.channel` to `lead.source_channel` on exact
equality. Nothing is guessed: unmatched spend and unmatched leads both land in
`(unattributed)`, and a channel with spend but no leads still appears — so
bucket totals reconcile to the totals. Verified on staging: three buckets
summing to R10,000 spend / 4 leads / 2 customers / R40,000 revenue, matching
`client_economics` exactly.

### One source of truth for spend

`acquisition_funnel` read `metrics_daily.spend`, which has no rows and will not
until Meta is connected — so its `cost_per_lead` and `return_on_spend` had
always been null in production. It now reads `client_marketing_spend`. Its
signature, column names and null behaviour are unchanged.

**Legacy naming caveat:** `acquisition_funnel.return_on_spend` computes
`cash_collected / spend`, which is **Cash ROAS, not ROAS**. The name is kept for
compatibility; Client Economics exposes `roas` and `cash_roas` separately and
correctly. Renaming belongs in the tool 7 sweep.

### Production evidence — 11 September 2026

A real manual spend row against a real client, entered under an **authenticated
admin JWT with RLS active**, not service_role:

- R85.00 on 2026-09-10 for Attract Acquisition, linked to campaign AA-C001, at
  that campaign's own recorded `daily_spend`.
- Economics for 1–30 September: **spend R85.00, 1 lead, CPL R85.00**; qualified,
  appointments and customers all 0, so CPQL, CPA, CAC and ACV are all null.
- Hand-checked against raw rows: raw spend 85.00, raw leads 1, raw revenue 0 —
  all three match what the function reported.
- `acquisition_funnel` spend **85.00**, identical to `client_economics` spend —
  one ledger, two surfaces.
- Harbour Dental's client user sees **0** AA spend rows, is **refused** on
  `client_economics` for AA, and is **refused by RLS** when writing AA spend.
- ROAS, Cash ROAS and ACV are **not calculable from genuine production data**,
  because production has no won revenue. They render "—" with the reason. No
  revenue was manufactured to make them light up; the positive arithmetic is
  proved by deterministic fixtures instead (R10,000 spend → 4 leads, 2
  customers, R40,000 revenue → CPL 2,500, CAC 5,000, ROAS 4.00, Cash ROAS 2.00,
  ACV 20,000).

### Still open

- **Meta ingestion** — an adapter writing into `client_marketing_spend`. The
  economics engine needs no change when it arrives.
- **Event-period reporting** — needs the dated revenue ledger above.
- **Bot tool surface** — deliberately not added. No MCP permission was widened.
- **Channel vocabulary** — spend `channel` and lead `source_channel` are free
  text matched exactly. A shared vocabulary would remove a class of silent
  mismatch, and until then mismatches are visible as `(unattributed)` rather
  than hidden.

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

Built: 1 (bar its Iteration Engine), 2, 3, 4, 6, 7, 8 and 9. Partial with real
substance: 5. Nothing unbuilt.

Three of the built tools now share one open edge: **nothing of ours is yet
serving a visitor.** Tool 2 generates a page nobody has published, tool 3
builds an agent nobody has embedded, and tool 4's automatic lead capture is
waiting on both. That is one piece of work — a public runtime — rather than
three gaps, and it is worth naming as such rather than counting it three times.

The dependency worth noticing: **7 (Attribution) is what makes 9 (Economics)
possible, and 1's Iteration Engine depends on both.** Revenue cannot be
attributed to an asset until leads and sales are modelled, which is tool 4, and
7 is now built on top of it — so the chain 4 → 7 is closed and 7 → 9 → the
Iteration Engine is what remains. That chain is what turns the console from a
production tool into a compounding one.

Both of the remaining links have a prerequisite that is not code. 9 needs ad
spend, which arrives with Meta. The Iteration Engine needs enough attributed
outcomes to learn from, which needs 9 and needs time — a hook cannot be judged
against three assets.

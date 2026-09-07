# Gap audit — 6 September 2026

The current reference for what is built, what is not, and what is built but
unproven. Every claim was checked against the running system rather than
recalled, and the method is stated so each can be re-run rather than trusted.

Supersedes the status framing in `ui-data-entry-mapping.md`.

---

## Where the build is

| Area | State | Checked by |
|---|---|---|
| Admin console | **Complete.** Every leaf page resolves to a real panel. | Parsing `navigation.ts` against the registries in `Page.tsx`. |
| Client and employee consoles | **Complete.** No page says "coming soon". | Parsing `consoleNav.ts` against the `page.id ===` branches in both console pages. |
| Agent runtime | **16 agents registered, 16 runners.** Nothing can be queued that cannot execute. | `agents` table vs `RUNNERS` in `dispatch.ts`. |
| Deployment | **Current.** Railway reports `c859fe6`, matching HEAD. | `agent_runtime_status`. |
| RLS | **Every table enabled with policies. No client can see anything of another client's, by any path.** | `pg_class.relrowsecurity`, `pg_policy`, and `scripts/rls-isolation-test.mjs` against two live client logins. |
| Exposed functions | **No `SECURITY DEFINER` function is reachable by `anon`.** | `has_function_privilege('anon', ...)` across `public`. |
| Schema in git | **52 migrations, and the chain now provably replays** onto an empty database. | `supabase db push` onto a fresh staging project. |
| Idea → brief → asset → scheduled | **Built end to end**, AI and human routes. | See gap 1: the AI half has never completed a render. |
| Reporting ingest | **Built end to end**, steps 1–6, scheduled daily. | See gap 1: no live pull has ever succeeded. |

---

## 1. Nothing external is connected — the only substantial blocker

One gap, not three, because it is one shape: the code exists, the failure
paths are verified against the real services, and no call has ever succeeded
because no credential is configured.

| Integration | Unlocks | State |
|---|---|---|
| **OpenAI** | The AI build route — creative concept *and* image render | **Connected and proven end to end.** Both model ids resolve; a real build produced a publishable asset in 78s for $0.115 |
| **Meta** (`meta` + `instagram`) | Metrics ingest, and everything downstream: Reporting panels, the commentary agent | 0 rows in `client_integrations`, 0 Vault secrets |
| **Resend** | The email telling an editor a brief is waiting | Key configured locally, **no email sent yet** — that reaches a real inbox, so it needs a deliberate decision |

Everything around each boundary is verified. Meta's failure path was tested
against the real API — an invalid token came back correctly classified as
non-retryable and flipped the integration to `error`. The email path ran on
Railway and **completed rather than failed**, marking itself `skipped`,
because the assignment is the work and the email is only the notification.
The image build fails cleanly with "No image renderer is configured", having
refused to pay for a concept it could never render.

What is unproven is the success path of all three.

**The model ids are confirmed.** `gpt-image-2` and `gpt-5.6-sol` both resolve
against the live API. That caveat is retired.

**What the first real build found.** It produced a genuinely publishable
asset — and invented the client's identity. The footer carried a fabricated
practice name, a fabricated logo and a fabricated WhatsApp number, on an ad
for a real business. The concept had done the right thing and written a
*placeholder*; the renderer, handed a placeholder, filled it in. Every
evidence rule in this pipeline lived in the concept stage and none of it
reached the renderer. Both stages now carry the ban, and **Account → Contact & Identity** holds the
real values — phone, WhatsApp, website, socials, address, logo — so the ban
does not simply mean a blank corner forever. Each detail is either given
verbatim or explicitly forbidden; there is no third state, because a renderer
told nothing about a phone number invents a plausible one. A build with real
details on file rendered "Harbour Dental" correctly and invented nothing.

The logo is deliberately never drawn. A diffusion model approximates a
wordmark, and an approximated logo is still the wrong mark, so the render
leaves a clear band and the real file is composited into it afterwards with
sharp — pixel for pixel, the actual mark. A failed composite keeps the render
rather than losing an image that has already been paid for.

See **Configuration required** below for exactly what goes where.

---

## 2. Leaked-password protection is off

Supabase Auth is not checking new passwords against HaveIBeenPwned. It
matters more than usual here: console passwords are short and shared (`123`
for every employee), and there are now two client logins on the same pattern.

**To close:** Supabase dashboard → Authentication → Policies. Not something
that can be done from this repo.

---

## 3. Landing and offer page reporting has no data source

`metric_surface` carries `landing` and `offer`, and both tabs render, but
nothing writes those rows and nothing will: page performance comes from site
analytics, not the ad platform. The tabs say so rather than showing an empty
state that reads as a bug.

**To close:** a second connector — GA4 or Plausible — behind the same
`MetricsSource` interface the Meta one implements. Schema, scheduler, queue
and panels need no change.

---

## 4. The commentary agent cannot describe a trend

Asked to report, it correctly says *"there is no prior-period data in this
summary, so nothing here can be called up or down"*. Right behaviour, but a
permanent ceiling: `metrics_daily` holds the history,
`metrics_period_summary()` does not compute a comparison.

**To close:** a prior-window block in that function. Both the panels and the
agent pick it up automatically, because they read the same one. Blocked
behind gap 1 — it delivers nothing until metrics exist.

---

## 5. ~~Two audit tables written and never read~~ — CLOSED, and one was worse

They turned out to be different problems, and the audit had one of them wrong.

**`client_asset_reviews`** was genuinely written and never read — every
approve and reject since the beginning. Worse, only admins and the client
could read it, so the editor or avatar whose work was rejected, the one
person who has to act on the reason, could not see it. And nothing ever
captured a reason: both existing rows had `reason: null`, because the UI
never asked.

Now: rejecting asks why and will not proceed without an answer, the decision
history shows on the asset, and the maker can read the reviews of assets they
made. Verified across four accounts — each maker sees exactly their own work
and nothing else, and an AI-generated asset with no maker is visible to no
employee at all.

**`agent_tool_calls`** was not "written but never read". **Nothing ever wrote
to it.** It was built for a tool-audit design the runtime did not adopt: the
record agents call exactly one tool, and the only real tool user is the
Master AI, which already writes a full audit to `master_ai_messages.tool_calls`.
An empty table shaped like an audit trail is worse than no table — it reads as
evidence that tool calls are logged when they are not — so it is dropped.

---

## 6. ~~Frontend test coverage is thin~~ — CLOSED, and it was not thinness

The audit said "thin". It was **absent**, for a reason thinness does not
describe: there was no DOM test environment at all. The three frontend suites
were pure-logic — no jsdom, no testing-library — so "no panel renders under
test" was not a coverage choice anyone had made. Nothing *could* render.

Now: jsdom and Testing Library are configured, and the four surfaces of the
build pipeline have suites — **29 tests to 121**.

| Suite | Covers |
|---|---|
| `AgentActivityBar` (12) | In-flight and failure states, and dismissal |
| `ApproveAndBuildModal` (20) | AI/human routing, dispatch, reference upload |
| `ConceptWorkspace` (21) | Concept editing, re-render, approve, schedule |
| `BriefDetailModal` (19) | Provenance, build history, dispatch status |
| `MediaDetailModal` (20) | Preview by type, provenance, decision history |

They are written against the invariants that have actually broken or would be
expensive to break, not against the markup:

- **Video never reaches the AI route.** The rule the modal exists to enforce.
- **A dismissed failure stays dismissed across an unmount** — the tab-change
  regression, locked.
- **Deselecting a category drops the people picked from it**, so a brief
  cannot go to someone the operator believes they deselected.
- **A generated asset is never attributed to a person**, and both models are
  credited.
- **Saving a concept edit spends nothing** — asserted by the absence of a
  render call, which is the property that makes the split worth having.
- **`attempts` is only reported when retries really happened.**
- **A rejection shows its reason**, the gap-5 fix, now held in place.

**The tests were checked for teeth rather than trusted.** Two mutations were
introduced into `ApproveAndBuildModal` and reverted: forcing `isVideo` false
failed 3 tests, and dropping the orphaned-selection cleanup failed 1. A suite
that passes against broken source is worse than no suite.

CI already runs `npm test`, so these gate every push with no workflow change.

The RLS half remains as it was: `scripts/rls-isolation-test.mjs` is a real
harness meant to be re-run whenever a policy changes or a table is added. It is
not in CI because it needs two live client credentials.

---

## 7. ~~Everything is tested against production~~ — STAGING EXISTS

**Closed.** `AA-Console-Staging` (`vmmertwoboqiazcsougw`) was created and the
whole migration chain replayed onto it from git. That required freeing a slot:
the plan allows two active free projects, and `Cockpit` — v5, still
heartbeating at the time — was paused for it.

**The replay immediately failed, which is the entire point of having it.**

Migration 10 revokes execute on `rls_auto_enable()`, a function **no migration
creates**. It existed only in the live database, put there outside the
migration history, so nothing in git described it.

It is not a trivial object. An event trigger, `ensure_rls`, calls it on every
DDL and turns row level security on for any new table in `public`. So part of
the "every table has RLS" property this document keeps verifying is
*automatic* — and a fresh environment built from git would not have had it. A
new table there could have shipped without RLS and nothing would have
complained.

Both are now captured in `09b_rls_auto_enable.sql`, ordered to run before the
revoke, written idempotently, and applied to production as well so the two
share one lineage.

A second difference surfaced on comparison: staging had the function callable
by `anon` while production had it locked to `service_role`. Same cause as the
`is_channel_member` trap — migration 10 revokes from `authenticated`, which
does nothing, because functions grant EXECUTE to PUBLIC by default. The
migration now reproduces production's grants exactly.

Staging and production now agree on every count checked: 44 tables, 8 views,
44 functions, 105 policies, no table without RLS, no `SECURITY DEFINER`
function reachable by `anon`, 16 agents and 81 record templates seeded.

**The rule from here:** migrations land on staging first. Production was
verified unchanged after the catch-up push — 2 clients and 5 assets still
present.

---

## 8. Smaller things

- **A finished render has no route to distribution beyond scheduling.** It can
  be approved and booked in from the brief, but nothing links it onward.
- **No backfill UI.** `enqueue_metrics_ingest_jobs(p_days)` accepts a window;
  nothing calls it with anything but the default.
- **`brief` is excluded from master runs by matching its `agent_key` string.**
  `scheduled_only` now exists and is the cleaner mechanism.
- ~~**The Master AI has no spend ceiling.**~~ **Closed.** Two limits, because
  they catch different failures: `MASTER_AI_DAILY_LIMIT_USD` (default $20)
  bounds the bill, and `MASTER_AI_CONVERSATION_LIMIT_USD` (default $5) catches
  one thread going in circles, which is the shape a runaway actually takes and
  which a daily limit would only notice after it had eaten the day.

  Defaults were calibrated against real use rather than guessed: 13 turns had
  cost **$1.15 in total**, the dearest single turn $0.16, the busiest day
  $1.10. Both ceilings sit far above that — they exist to stop a runaway, not
  to budget. Zero is accepted and means stop entirely, a deliberate off switch;
  a negative or non-numeric value refuses to boot, because a ceiling that
  silently falls back to a default is worse than none.

  Enforced in two places, because one turn is up to twelve model calls:
  **before the turn** (refuses with 429 and writes nothing to the thread) and
  **inside the loop** (stops before running the tools it just asked for — a
  tool call implies another model call to read the result, so continuing is
  what actually spends). It **fails closed**: if the total cannot be read, the
  turn does not run.

  `master_ai_spend()` is the single source of truth — the runtime enforces
  against it and the console shows the same figure, so what is displayed and
  what is enforced cannot drift. The chat header carries today's spend, turning
  destructive past 80% of the limit.
- **Stale worker rows** in `agent_runtime_status` from local testing. Cosmetic —
  `is_live` reports them correctly.
- **`react-router-dom` 6.30.6 carries two moderate advisories**, and the fix is
  a semver-major move to 7.x. Checked rather than assumed: neither is reachable
  here. The SSR hydration one needs SSR, and this is a Vite SPA with no server
  entry. The open redirect needs an attacker-controlled navigation target, and
  every `navigate()` and `to={}` in `src/` is a literal, a lookup in a constant
  role map, or a database UUID. Worth doing as its own migration, not urgent.

---

## Configuration required

Two places, and both are needed. The local file only affects a runtime you
start yourself; the deployed worker reads Railway's own variables.

### `agent-runtime/.env` — local runs

```
OPENAI_API_KEY=sk-...
RESEND_API_KEY=re_...
```

Optional, with working defaults already in code:

```
MASTER_AI_DAILY_LIMIT_USD=20
MASTER_AI_CONVERSATION_LIMIT_USD=5
OPENAI_IMAGE_MODEL=gpt-image-2
CREATIVE_CONCEPT_PROVIDER=openai
CREATIVE_CONCEPT_MODEL=gpt-5.6-sol
RESEND_FROM=AA Console <briefs@attractacq.com>
CONSOLE_URL=http://localhost:5173
```

### Railway → the service → Variables — the deployed worker

The same two keys. Nothing else is needed while the console runs locally:
`CONSOLE_URL` and `MASTER_AI_ALLOWED_ORIGINS` both default to
`http://localhost:5173`.

**The console is now deployed** to `console.attractacq.com` from
`.github/workflows/deploy.yml` (GitHub Pages), so these are required, not
optional:

```
CONSOLE_URL=https://console.attractacq.com
MASTER_AI_ALLOWED_ORIGINS=https://console.attractacq.com
```

`CONSOLE_URL` is where the "Open it in the console" button in a brief email
points. `MASTER_AI_ALLOWED_ORIGINS` is which origins a browser may call the
Master AI from — until it names the deployed origin, **the Master AI will not
work from the hosted front end**, because the browser blocks the request
before it is sent.

### GitHub → the repo → Settings → Secrets and variables → Actions

The browser app is built in CI, so its configuration is repository secrets
rather than a local file. The deploy fails loudly if either of the first two
is missing, rather than publishing a bundle that renders a login page it
cannot authenticate against.

| Secret | Required | Notes |
|---|---|---|
| `VITE_SUPABASE_URL` | Yes | |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | Yes | Safe to ship — RLS decides what it can see |
| `VITE_AGENT_RUNTIME_URL` | For the Master AI | Absent means the chat reports itself unconfigured rather than failing |

Also needed once, outside the repo: **Settings → Pages → Source: GitHub
Actions**, and a DNS `CNAME` for `console` pointing at `attractacq.github.io`.
`public/CNAME` pins the domain into the build artifact so a deploy cannot
quietly drop it.

### Meta, per client — in the app

Account → Integrations → Add, one row per surface:

| Provider | Account ID field | Pulls |
|---|---|---|
| `meta` | `act_<ad account id>` | Paid campaign metrics |
| `instagram` | the IG user id | Organic post and account metrics |

Then turn **Daily sync** on for each. It defaults to off, so connecting a
credential does not silently start billing API calls.

---

## Closed, with what proved it

| Gap | Closed by | Evidence |
|---|---|---|
| Cross-client RLS isolation | A second client login and an attack suite | No leak in either direction across 26 tables; every policy also read statically, since nine tables were empty and would have passed vacuously |
| Chat handed over whole profile rows | `chat_participants()` replacing the peer policy | Profiles readable by a client: 5 → 1. Chat unchanged |
| `account` unimplemented in four consoles | Two panels, built from what each role can read | Verified signed in as the client and as EDITOR1; a payment raised against the avatar stayed invisible to the editor |
| `is_channel_member` callable by `anon` | Revoking from `PUBLIC`, not just `anon` | No `SECURITY DEFINER` function is now reachable by `anon` |
| A build could not be re-run, edited or compared | Splitting the concept from its renders | A re-render spends 0 tokens on the concept, against 33,484 for the first build |
| Concept context far larger than needed | An allow-list of the sections a creative uses | 33,484 → 13,023 input tokens, same output, on the same brief and model |
| No panel could be rendered under test | jsdom, Testing Library, and five suites over the build pipeline | 29 tests → 121. Two deliberate mutations of the source failed 3 and 1 test respectively, so the suites are not vacuous |
| Master AI spend was unbounded | Daily and per-conversation ceilings over `master_ai_spend()` | Day window proved against seeded rows on staging: $9.99 one second before UTC midnight is excluded from the day and still counted against the conversation. Five mutations — ignoring the conversation cap, an off-by-one at the limit, an unreadable total reading as zero, the ceiling computed but not enforced, unbounded headroom handed to the turn — each failed the tests that name them |

---

## Traps worth not re-learning

1. **`ALTER TYPE ... ADD VALUE` needs its own migration.** Postgres refuses to
   use an enum value in the transaction that added it. Migrations 20, 26 and 36
   exist for this.
2. **`supabase migration fetch` overwrites migration 11** and restores the five
   plaintext console passwords for commit. Always
   `git checkout HEAD -- supabase/migrations/*_11_auth_users_*` afterwards and
   sweep the staged diff.
3. **`UNIQUE` treats NULLs as distinct.** Migration 22 undoes this;
   `metrics_daily.external_id` is `NOT NULL` so its identity key cannot repeat it.
4. **A worker must only claim agents it implements.** Not passing the filter to
   `claim_agent_job` meant a container claimed agents it had no runner for and
   burned their attempts.
5. **Lease renewal by a live worker defeats lease expiry.** The runtime
   recovers a wedged job by letting its lease lapse — but a worker holding a
   stalled call is alive, keeps renewing, and the lease never lapses. A brief
   sat "running" for ten minutes with no output and no way to reclaim it. The
   Anthropic client also had no timeout, so the call itself was unbounded.
   Both are now capped: renewal stops past a maximum job age, and every model
   call carries a per-request timeout. Every write already asserts lease
   ownership, so a stale run cannot corrupt the job it lost.

   A second lesson from the same incident: `started_at` was set once and never
   on retry, so `now() - started_at` reads as the age of the *job*, not of the
   current attempt. A retry that had been running 30 seconds looked like 12
   minutes — long enough to read as the stall it had just recovered from, and
   it produced a wrong diagnosis before the numbers were checked. It is now
   stamped per attempt.
6. **Changing a job's `params` shape is a deploy-ordering problem**, and the
   claim filter does not cover it — it matches on `agent_key`. Deploy the
   runtime *before* migrating the RPC that changes what it is sent.
7. **A renderer will invent an identity from a placeholder.** Given
   "practice name as it appears on the door" it produced a plausible name, a
   logo and a phone number, on a real company's advertising. Rules that live
   only in the reasoning stage do not reach the stage that makes the pixels —
   put them in both, and give the renderer the real value so it never has to
   guess one.
8. **Revoking a function grant from `anon` alone does nothing.** Functions grant
   `EXECUTE` to `PUBLIC` by default and `anon` inherits it. Revoke from
   `PUBLIC`, then grant back explicitly — and check
   `has_function_privilege` afterwards, because the no-op is silent.
9. **An audit line can name a symptom and hide its cause.** "Test coverage is
   thin" reads as a backlog item — write more tests. The actual state was that
   no test *could* render a component, because no DOM environment existed. The
   count was a consequence, not the problem, and counting is what made it look
   like one. When a gap is phrased as a quantity, check what the quantity is
   made of before planning to increase it.
10. **A limit read from the environment must refuse to boot on nonsense.**
    `MASTER_AI_DAILY_LIMIT_USD=twenty` parsing to `NaN` and falling back to a
    default gives a process that looks configured and is not. Zero is a
    legitimate value here (stop entirely), so the check rejects negatives and
    non-numbers specifically rather than anything falsy.
11. **A suite that passes on first run has not been shown to work.** Every one
    of these did. The check is to break the source deliberately and confirm the
    right tests fail: `isVideo = false` must fail the video tests, and removing
    the orphaned-selection cleanup must fail that one. Both did, and both were
    reverted. Without that step a green run only proves the tests execute.

---

## How to re-run this audit

- **Unimplemented pages:** parse `src/config/navigation.ts` and
  `src/config/consoleNav.ts` against the registries in `src/pages/Page.tsx`
  and the `page.id ===` branches in the two console pages.
- **Agents without runners:** `agents` table vs `RUNNERS` in
  `agent-runtime/src/orchestration/dispatch.ts`.
- **Deployed version:** `select version from agent_runtime_status where is_live`.
- **RLS coverage:** `pg_class.relrowsecurity` and `pg_policy` over `public`.
- **Cross-client isolation:** `node scripts/rls-isolation-test.mjs`, with
  `.env.local` sourced and `RLS_TEST_CLIENT_A_PASSWORD` /
  `RLS_TEST_CLIENT_B_PASSWORD` set (the script holds no credentials).
- **Exposed functions:** `has_function_privilege('anon', p.oid, 'execute')`
  over `pg_proc` where `prosecdef`.
- **Orphaned schema:** grep each table name across `src/`, excluding
  `types/database.ts`. Tables read through an RPC or a view look like false
  positives — `metrics_daily` and `agent_runtime_heartbeats` are.
- **Whether the frontend suites still bite:** break one invariant in the source
  on purpose, run `npm test`, confirm the expected tests fail, and revert. A
  passing suite is evidence only if it can fail.

# Gap audit — 7 September 2026

The current reference for what is built, what is not, and what is built but
unproven. Every claim was checked against the running system rather than
recalled, and the method is stated so each can be re-run rather than trusted.

Supersedes the status framing in `ui-data-entry-mapping.md`.

---

## Where the build is

| Area | State | Checked by |
|---|---|---|
| Admin console | **Complete.** Every nav leaf resolves to a real panel. | Diffing nav ids against the two panel registries in `Page.tsx`; only `clients` is unmatched, and it has its own route |
| Client and employee consoles | **Complete.** No page says "coming soon". | Parsing `consoleNav.ts` against the `page.id ===` branches in both console pages |
| Agent runtime | **16 agents, 16 runners.** Nothing can be queued that cannot execute. | `agents` table vs `RUNNERS` in `dispatch.ts`, exact set match |
| **Hosting** | **Live.** Console at `console.attractacq.com` (Pages, HTTPS enforced), runtime at `aa-console-production.up.railway.app`. Nothing runs on localhost. | `gh api .../pages`, `/health`, and `agent_runtime_status` showing one live worker |
| Deployment | **Current**, and CI and deploy are both green on every recent push. | `agent_runtime_status.version` matches HEAD; `gh run list` |
| RLS | **45 tables, all with RLS. 106 policies. No client can see another client's data by any path.** | `pg_class.relrowsecurity`, `pg_policy`, and `scripts/rls-isolation-test.mjs` against two live logins |
| Exposed functions | **No `SECURITY DEFINER` function is reachable by `anon`.** | `has_function_privilege('anon', ...)` across `public` |
| Schema in git | **54 migrations, replaying onto a fresh database.** Staging matches production: 45 tables, 0 without RLS, 106 policies, 16 agents. | `supabase db push` onto staging, then a count-for-count comparison |
| Tests | **276** — 155 frontend, 121 runtime. | `npm test` in both packages |
| Brand | **On file and enforced.** Palette, typography, imagery direction and per-brand bans reach both stages of a build. | `client_brand_profiles`, and the render block printed from a real row |
| Idea → brief → asset → scheduled | **Built end to end**, AI and human routes, and the AI half has produced real assets. | 2 completed renders, 5 media assets, 7 scheduled posts |
| Reporting ingest | **Built end to end**, scheduled daily. | See gap 1: no live pull has ever succeeded |

Agent spend to date: **$5.26**.

---

## The open gaps, in the order they block things

### 1. Meta is not connected — the largest remaining blocker

`client_integrations` holds **0 rows** and `metrics_daily` **0 rows**. Everything
downstream is therefore inert: the Reporting panels, the daily ingest cron, and
the commentary agent.

The code either side of the boundary is verified. Meta's failure path was tested
against the real API — an invalid token came back correctly classified as
non-retryable and flipped the integration to `error`. What has never happened is
a successful pull.

**To close:** Account → Integrations → Add, one row per surface (`meta` with
`act_<ad account id>`, `instagram` with the IG user id), then turn Daily sync on.
It defaults to off so a credential does not silently start billing API calls.

### 2. No email has ever been sent

`brief_dispatches` holds 1 row and `email_status = 'sent'` holds **0**. The path
ran on Railway and completed rather than failed, marking itself `skipped`,
because the assignment is the work and the email is only the notification.

This is deliberate, not an oversight: the first real send reaches
`editor1@attractacq.com`, a real inbox, and needs a verified sending domain in
Resend plus an explicit decision to send. `RESEND_API_KEY` is not set on Railway.

### 3. Leaked-password protection is off

Supabase Auth is not checking new passwords against HaveIBeenPwned. Confirmed
still disabled by the security advisor today. It matters more than usual here:
console passwords are short and shared, and there are two client logins on the
same pattern.

**To close:** Supabase dashboard → Authentication → Policies. Not doable from
this repo.

### 4. ~~A job has no true deadline~~ — CLOSED

`providerTimeoutMs` (600s) bounds one HTTP request, on a client built with
`maxRetries: 2`, inside a loop of up to `maxTurns` turns — worst case was
turns × 3 × 600s. And the worst of it was not the arithmetic: at
`maxJobSeconds` the worker stopped **renewing** the lease but the job kept
**executing**. A wedged attempt became a zombie holding a worker slot and
still spending, while a second worker was free to claim the same row. Writes
were safe — every one asserts lease ownership — but neither the work nor the
cost was bounded.

Now `dispatchJob` computes a deadline and hands it to every runner, so an
agent added later is bounded whether or not it thinks to ask. It is
deliberately the same `maxJobSeconds` the lease-renewal cap uses: a job stops
working at the instant it stops being renewable, which is what removes the
zombie rather than merely shortening it.

Inside the loop it does two things. It refuses to **start** a turn past the
deadline — the property that actually saves money, since the alternative is
paying for a call that cannot finish in time. And each request carries
`AbortSignal.timeout` clamped to whatever time is left, because an abort is
not retried where the SDK's own `timeout` option is; without it the last
request of a job could start just inside the deadline and run three more
timeouts beyond it. An abort is classified as this runtime's deadline rather
than as a provider fault, so it stops reading as an Anthropic outage.

The OpenAI paths were checked and left alone: both already abort hard, at
300s for a concept and 180s for a render, so 480s worst case against a 1800s
job bound. The unbounded multiplier really was the Anthropic loop.

### 5. Landing and offer page reporting has no data source

`metric_surface` carries `landing` and `offer`, both tabs render, and 2 pages
exist — but nothing writes those rows and nothing will: page performance comes
from site analytics, not the ad platform. The tabs say so rather than showing an
empty state that reads as a bug.

**To close:** a second connector — GA4 or Plausible — behind the same
`MetricsSource` interface the Meta one implements. Schema, scheduler, queue and
panels need no change.

### 6. The commentary agent cannot describe a trend

Asked to report, it correctly says *"there is no prior-period data in this
summary, so nothing here can be called up or down"*. Right behaviour, permanent
ceiling: `metrics_daily` holds the history, `metrics_period_summary()` does not
compute a comparison.

**To close:** a prior-window block in that function. Panels and agent both pick
it up, because they read the same one. Blocked behind gap 1.

### 7. Smaller things

- ~~**`brief` is excluded from master runs by a string match.**~~ **Closed, and
  it was hiding a live bug.** The string was load-bearing rather than
  redundant — `brief.scheduled_only` is false, so it was the only thing
  excluding it. It also only ever covered `brief`: `creative_build` and
  `landing_page` have the same shape and *were* being queued by every master
  run, failing on their first line ("No render to produce.", "it has no page to
  work on"). So "Run All Agents" produced two guaranteed failures every time.

  `scheduled_only` was the wrong flag to reuse — it means "driven by a schedule
  rather than by a person", which is true of `metrics_ingest` and
  `brief_dispatch` and false of all three of these. They now carry
  `requires_input`, which says the actual reason: they act on a row a person
  chose, and a master run has none to pass. Eleven agents are queued by a
  master run now, down from thirteen.
- **Brand CSS is stored and unused.** `client_brand_profiles.custom_css` exists
  and the page says so plainly, but nothing renders a generated page as HTML —
  `client_pages.body` is markdown shown as plain text in both the admin panel
  and the client view. The palette and treatment tokens *are* used; the CSS is
  waiting on a page renderer that does not exist yet.
- **No backfill UI.** `enqueue_metrics_ingest_jobs(p_days)` accepts a window;
  nothing calls it with anything but the default.
- **A finished render has no route to distribution beyond scheduling.** It can
  be approved and booked in from the brief, but nothing links it onward.
- **`react-router-dom` 6.30.6 carries two moderate advisories**, and the fix is
  a semver-major move to 7.x. Checked rather than assumed: neither is reachable.
  The SSR hydration one needs SSR and this is a Vite SPA with no server entry.
  The open redirect needs an attacker-controlled navigation target, and every
  `navigate()` and `to={}` in `src/` is a literal, a constant role-map lookup or
  a database UUID. Worth doing as its own migration, not urgent.
- **`SectionCard` is dead code.** Nothing imports it but a comment in `Panel.tsx`.
- **26 advisor warnings for `SECURITY DEFINER` functions callable by
  `authenticated`.** Reviewed as a set today: every one is an intended RPC that
  carries its own guard (`is_admin()`, `can_access_client()`, an actor check).
  None is a finding on its own, but the safety of all 26 rests on those internal
  guards rather than on the grant, so a new one added without a guard would not
  be caught by the linter — it would look exactly like these.

---

## Configuration required

Three places. The local file affects only a runtime you start yourself; the
deployed worker reads Railway's variables; the browser app is built in CI and
reads repository secrets.

**Nothing runs on localhost any more.** The console is served only from
`console.attractacq.com` and the runtime only from
`aa-console-production.up.railway.app`. The local runtime was stopped, and
`MASTER_AI_ALLOWED_ORIGINS` names the deployed origin alone — so `npm run dev`
against the deployed runtime will be refused by CORS until localhost is added
back to that variable. That is deliberate, and it is one variable to reverse.

Railway also has a **watch path of `/agent-runtime/**`**, so a frontend-only
commit no longer rebuilds and restarts the worker. It used to, and any job in
flight at that moment was orphaned until its lease lapsed.

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
CONSOLE_URL=https://console.attractacq.com
MASTER_AI_ALLOWED_ORIGINS=https://console.attractacq.com
```

The last two are the code defaults now, not placeholders — set them only to
point a different environment somewhere else.

### Railway → the service → Variables — the deployed worker

`OPENAI_API_KEY` is set. `RESEND_API_KEY` is **not** — see gap 2.

Both of the following are set explicitly, and are also the code defaults, so
they would hold even if the variables were removed:

```
CONSOLE_URL=https://console.attractacq.com
MASTER_AI_ALLOWED_ORIGINS=https://console.attractacq.com
```

`CONSOLE_URL` is where the "Open it in the console" button in a brief email
points — an unset value used to put `http://localhost:5173` in front of a real
recipient. `MASTER_AI_ALLOWED_ORIGINS` is which origins a browser may call the
Master AI from; an origin not on it gets no
`access-control-allow-origin` header and the browser blocks the request before
it is sent.

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

All three secrets are set, and so is the DNS. Two things that cost time and
are worth recording:

- **GoDaddy already had an `A` record for `console`** pointing at a parking
  IP, and GitHub rejected it with `InvalidARecordError`. DNS forbids an A
  record and a CNAME on the same name, so the A had to be deleted before the
  `CNAME console → attractacq.github.io` could be added. The apex and the
  `alex`, `portal` and `studio` records were left untouched.
- **The runtime had no public URL at all.** Railway had it on private
  networking only — "Unexposed service" — which is why there was nothing to
  put in `VITE_AGENT_RUNTIME_URL`. It is now
  `https://aa-console-production.up.railway.app`, and CORS was verified in
  both directions: the console origin gets an
  `access-control-allow-origin` header back, and an unlisted origin gets none.

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
| Two audit tables written and never read | Reviews surfaced on the asset with a mandatory reason; `agent_tool_calls` dropped as never-written | Verified across four accounts — each maker sees their own work only, and an AI asset with no maker is visible to no employee |
| Everything tested against production | `AA-Console-Staging`, replayed from git | The replay failed on migration 10 and exposed `rls_auto_enable()`, an event trigger living only in production. Both now in git; staging and production agree count for count |
| No panel could be rendered under test | jsdom, Testing Library, and five suites over the build pipeline | 29 tests → 142. Two deliberate mutations of the source failed 3 and 1 test respectively |
| Master AI spend was unbounded | Daily and per-conversation ceilings over `master_ai_spend()` | Day window proved on staging: $9.99 one second before UTC midnight is excluded from the day and still counted against the conversation. Five mutations each failed the tests that name them |
| The console was not deployed anywhere | GitHub Pages, custom domain, HTTPS enforced | Live at `console.attractacq.com`; deep links serve the app via a 404.html fallback; icons and manifest serve |
| A frontend commit restarted the agent worker | A Railway watch path of `/agent-runtime/**` | Railway's own log: the runtime commit deployed, the next docs commit shows SKIPPED — "No changes to watched files" |
| OpenAI unproven end to end | A real two-stage build | A publishable asset in 78s for $0.115, with the client's real identity composited rather than invented |
| Master runs queued agents that could not succeed | A `requires_input` flag replacing a string match | `creative_build` and `landing_page` were queued by every master run and failed immediately; 13 agents queued became 11. The rewritten `start_master_run` was diffed against the live definition on staging — access check, paused, archived, dedupe, the empty guard, `SECURITY DEFINER` and `search_path` all confirmed intact |
| A job could run past any stated bound | A deadline computed in `dispatchJob` and enforced between turns | Four mutations: never checking the deadline, dropping the per-request abort, an unbounded deadline, and forgetting to pass one. The third passed all 118 tests on the first attempt — the dispatch wiring had no test until it did |
| Every build invented its own look | `client_brand_profiles`, fed to concept and render on the identity pattern | The render block printed from Harbour Dental's real row quotes `exactly #0F4C5C`; a client with no profile gets "No brand palette is on file" instead of silence. Four mutations — a hex as a suggestion, an empty row counting as a brand, dropping the hex guard, saving blanks as empty strings — each failed the tests that name them |

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

   **A correction to the above, found later.** "Every model call carries a
   per-request timeout" is true and does less than it sounds like. The 600s is
   the Anthropic client's *per HTTP request* timeout, and the client is built
   with `maxRetries: 2` inside a loop of up to `maxTurns` turns. The worst case
   is therefore turns x 3 x 600s, not 600s. The only real outer bound on a job
   is lease expiry and reclaim. That is the mechanism that actually works —
   see trap 12 — but the audit should not have implied the timeout bounded the
   job.
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
11. **A long-lived local worker is indistinguishable from a broken one.** An
    ideation job sat "running" for fifteen minutes. The cause was a local
    runtime started fifteen *hours* earlier, from source that predated the
    lease-renewal work: it claimed the job, set a 900s lease, and never
    renewed it. Both workers poll the same queue, and nothing in `agent_jobs`
    records which one holds a job, so the only way to tell them apart was
    arithmetic — `lease_until - started_at` was exactly 900, the local
    `AGENT_RUNTIME_LEASE_SECONDS`, and a decaying static lease rather than a
    renewed one.

    That distinction produced a wrong diagnosis first: "544s left, so a live
    worker is renewing it" reads the same as "900s lease set once, 356s ago".
    Compare the lease *span* against the lease *remaining* before concluding
    anything about ownership. Stopping the stale worker let the lease lapse
    and Railway completed the job on the next attempt, unaided.
12. **A model told nothing does not leave a gap — it invents one.** This was
    learned from a fabricated phone number and it generalises further than it
    first appeared. The same silence that produced an invented practice name
    also produced a different palette on every asset, because "make it on
    brand" with no brand on file is a instruction to choose one. Anything the
    output is expected to be consistent about needs the two-state treatment:
    the real value quoted verbatim, or its absence stated explicitly. There is
    no third state, and a blank is not the absence — it is an invitation.
13. **A suite that passes on first run has not been shown to work.** Every one
    of these did. The check is to break the source deliberately and confirm the
    right tests fail: `isVideo = false` must fail the video tests, and removing
    the orphaned-selection cleanup must fail that one. Both did, and both were
    reverted. Without that step a green run only proves the tests execute.

---

## How to re-run this audit

- **Unimplemented pages:** diff the nav ids in `src/config/navigation.ts` and
  `src/config/consoleNav.ts` against the two registries in `src/pages/Page.tsx`
  and the `page.id ===` branches in the console pages. Grepping for "coming
  soon" does **not** work: `getPanelBody` falls back to a bare `EmptyState` for
  any id it does not know, so an unimplemented page looks like an empty one.
  Today only `clients` was unmatched, and it has its own route.
- **Supabase advisors:** run the security advisor. It is how the
  leaked-password gap stays visible, and it re-lists the 26 `SECURITY DEFINER`
  functions callable by `authenticated` — all intended, all relying on their own
  internal guard rather than on the grant.
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
- **Who is actually holding a job:** compare
  `lease_until - started_at` (the span the holder asked for) against
  `lease_until - now()` (what is left). A span equal to a worker's configured
  `AGENT_RUNTIME_LEASE_SECONDS` with no renewals means the lease was set once —
  the holder is not progressing, whatever its heartbeat says.
- **Whether the frontend suites still bite:** break one invariant in the source
  on purpose, run `npm test`, confirm the expected tests fail, and revert. A
  passing suite is evidence only if it can fail.

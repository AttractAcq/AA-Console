# Gap audit — 7 October 2026

The current reference for what is built, what is not, and what is built but
unproven. Every claim was checked against the running system rather than
recalled, and the method is stated so each can be re-run rather than trusted.

Supersedes the status framing in `ui-data-entry-mapping.md`, and the
7 September revision of this file. One row of that revision was wrong rather
than stale, and it is called out below.

---

## Where the build is

Counts are staging unless stated. Staging is ahead of production by eleven
migrations, which is the headline of this revision — see **Drift**.

| Area | State | Checked by |
|---|---|---|
| Admin console | **Complete.** Every nav leaf resolves to a real panel. | Diffing nav ids against the two panel registries in `Page.tsx` |
| Client and employee consoles | **Complete.** No page says "coming soon". | Parsing `consoleNav.ts` against the `page.id ===` branches |
| Agent runtime | **32 agents, 32 runners.** Nothing can be queued that cannot execute. | `agents` table vs `RUNNERS` in `dispatch.ts`, exact set match |
| Hosting | **Live.** Console at `console.attractacq.com`, runtime on Railway. | `/health` and `agent_runtime_status` |
| RLS | **81 tables, all with RLS. 146 policies.** | `pg_class.relrowsecurity`, `pg_policies` |
| Exposed functions | **Staging: no `SECURITY DEFINER` function is reachable by `anon`. Production: 21 are.** | `select * from security_definer_exposure` |
| Schema in git | **174 migrations.** Staging has 157–167; production stops at 156. | `supabase/migrations/`, and a per-object comparison of the two databases |
| Tests | **3,028** — 950 console, 2,078 runtime. | `npm test` in both packages |
| Idea → brief → asset → scheduled → published | **Built end to end, and inert at the last step by design.** Both publishing switches are off. | Migrations 144–166; `publish_due` |
| The one human gate | **Reachable.** Approvals → Engine calls `approve_slot`. | `src/pages/approvals/EngineInboxPanel.tsx` |
| Reporting ingest | **Paid works; organic fails on one metric name.** Three paid pulls completed 6–7 Oct. | `agent_jobs` for `metrics_ingest`, and `client_integrations.status` |

Agent spend to date, production: **$83.50**.

---

## Drift: staging is eleven migrations ahead of production

This is the thing to read first. Migrations 157–167 are applied to staging and
not to production, and one of them is a security fix.

| # | What it is | Why it matters that production lacks it |
|---|---|---|
| 157 | Token health | An errored integration cannot clear itself |
| 158 | QA | The engine has no gate before a person |
| 159 | The approval inbox | An approved asset never reaches a calendar |
| 160 | The publisher | Nothing can go out at all |
| **161** | **anon cannot drive the engine** | **See below. A live authorisation hole.** |
| 162 | Three the sweep could not fix | Cross-client write via `create_content_slot` |
| 163–164 | Held jobs | A monthly cap discards the rest of the month |
| 165 | Backfill | No history can be asked for |
| 166 | Assignment states | A rejection reaches nobody |
| 167 | A missing figure is not a zero | Organic ingest fails; a panel reports a 0 nobody measured |

### The 7 September row that was wrong

That revision claimed "**No `SECURITY DEFINER` function is reachable by
`anon`**", checked by `has_function_privilege('anon', ...)` across `public`.
The check was the right one; the answer has not been that since long before
the claim was written.

Supabase grants EXECUTE on every new function in `public` to `anon`,
`authenticated` and `service_role` by name, and PostgreSQL grants it to
PUBLIC, which `anon` belongs to. `revoke all on function x from public` —
which migrations 158, 159 and 160 all do while describing the function as
service_role only — removes the second and leaves the first.

Production today: **21 SECURITY DEFINER functions are callable with the anon
key that ships in the browser bundle.** Three of them have no check of any
kind in their own body and are in `public`:

- `advance_slot` — the engine's entire state machine, and the only thing
  permitted to write `content_slots.stage`. A slot id was the whole
  credential, and slot ids appear in job events and engine views. The move
  it would not refuse is `awaiting_approval → scheduled`, which is the one
  human gate the engine exists to stop at.
- `create_content_slot` — creates slots against any `client_id`, which the
  tick then picks up and spends that client's budget on.
- `plan_slots` — plans a whole horizon for any client, which is the same bill
  at a larger size.

The `mcp_internal` lead-reading functions are also in the 21 and are **not**
exposed: each calls `require_active_bot` and `require_bot_client_grant`, so a
caller needs a bot id and a grant. They are in the list because the heuristic
that found them looks for `can_access_client` and `auth.role()`, not for the
MCP's own equivalents.

Migrations 161 and 162 close all of this on staging. `ALTER DEFAULT
PRIVILEGES` cannot prevent a recurrence and fails silently — verified against
this project on 7 October: after revoking EXECUTE on functions from both
PUBLIC and `anon`, a freshly created function was still executable by both
and `pg_default_acl` had no row for the schema. Revoking the implicit
EXECUTE-to-PUBLIC default is a revoke of nothing. An event trigger on CREATE
FUNCTION would work and needs superuser, which Supabase does not grant. So
the mechanism is `lock_down_definer_functions()`, which every migration that
adds such a function calls, and `security_definer_exposure`, which is how
anybody notices one did not.

**To close:** apply 161 and 162 to production. Needs Alex via Chief of Staff
under the Phase 6 release boundary.

---

## The open gaps, in the order they block things

### 1. Meta is connected. Paid pulls; organic does not — and the reason is known

The September revision said `client_integrations` held 0 rows and no live pull
had ever succeeded. Both have changed, and not in the same direction.

Production, checked today:

| Provider | Status | Last checked | What it means |
|---|---|---|---|
| `meta` | **active** | 7 Oct | Only a successful ingest writes `active`. Paid works. |
| `instagram` | **error** | 6 Oct | Fails on the account call. See below. |
| `facebook` | connected | never | Stored, not synced; no connector reads it. |

Three paid pulls completed on 6 and 7 October. What unblocked them was
migration 156: `integration_secret` required `status = 'active'`, nothing but
a successful ingest writes `active`, and an ingest cannot succeed without the
token — so a freshly connected integration could never be used. The same
fault had been fixed in the TypeScript on 24 September and the comment left
on that fix describes this bug exactly, two weeks before it was found again
in the SQL.

`metrics_daily` is still **0 rows**, and that is now a different statement
from "not connected": the pulls succeeded and the ad account had no delivery
in the trailing week they asked for. Migration 165 is what lets somebody go
and ask for a window that does.

**Organic fails for a reason the API states outright.** The 6 October jobs
carry:

```
(#100) metric[0] must be one of the following values: reach, follower_count,
website_clicks, profile_views, online_followers, accounts_engaged,
total_interactions, ...
```

`metric[0]` was `views`. The media endpoint accepts `views` — that is the
2024 replacement for per-post `impressions`, and reading it is a fix that
already landed — and the **account** endpoint does not. Asking for it failed
the whole call, so reach and interactions were lost along with it. Migration
167 and the change beside it ask the account endpoint only for what it
accepts, which leaves account impressions unobtainable per day: the
replacement needs `metric_type=total_value` and returns a period total, and
this table holds daily rows. `organic_account.impressions` is therefore null
rather than 0, and both readers say "not available" rather than reporting a
number nobody measured.

**To close:** apply 157 and 167 to production, then let the 03:15 cron run —
or press Pull history on Account → Integrations for a window with delivery in
it. The Instagram row will clear itself once a call succeeds; until 157 is
applied, an errored integration cannot clear itself at all.

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
panels need no change, and `request_metrics_backfill` already takes a window,
so a new connector arrives with history rather than only a future.

### 6. ~~The commentary agent cannot describe a trend~~ — CLOSED

The prescription here was "a prior-window block in that function. Panels and
agent both pick it up, because they read the same one." Done slightly
differently and for a reason: putting the comparison inside
`metrics_period_summary` changes the shape both readers parse, so instead both
read that function twice — once per window — and share the delta arithmetic
through a mirrored module, the same mechanism the platform limits use.

What it refuses is the part worth keeping:

- **Individual posts are never compared.** Those figures are
  lifetime-to-date snapshots, so the earlier snapshot of a post that existed
  in both windows is contained in the later one. Subtracting them gives a
  confident, wrong growth figure, and always a positive one.
- **Uneven coverage is refused.** Thirty days of data against three is not a
  trend however the arithmetic comes out, and because the ingest backfills a
  trailing window this is the normal case rather than the edge one.
- **A base under 20 gets no percentage.** One click becoming three is +200%.

The panels show the same numbers, from the same code, with the same
refusals — `npm run sync:metrics-compare` and a mirror test keep the two
copies byte-identical. Not because the agent needed company, but because a
chart saying "+25%" beside a write-up saying "+30%" gives a reader no way to
know which to believe and both look authoritative.

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
- ~~**No backfill UI.**~~ **Closed, and the comment next to the switch had
  been wrong for weeks.** The Integrations panel said the daily-sync toggle
  "gates the schedule only — the ingest can still be run by hand, which is
  what you want for a one-off backfill without arming a recurring job."
  `enqueue_metrics_ingest_jobs` requires `ingest_enabled`, so the one case
  that sentence described was the one case it refused.
  `request_metrics_backfill` ignores that switch on purpose, caps the window
  at 400 days and says so rather than clamping, and refuses a window already
  being pulled. `metrics_coverage` sits above the date picker, because
  without it the picker is a guess and these are real requests against the
  client's own quota.
- ~~**A finished render has no route to distribution beyond scheduling.**~~
  **Closed.** Approving a slot creates the scheduled post, copies its copy
  onto it, and the publisher claims it when its time comes. Inert until both
  switches are on — `PUBLISH_ENABLED` in the runtime and
  `publishing_enabled` for that client — and that is two switches on purpose:
  one env var would mean the day somebody turns publishing on for one
  account it is on for every account the engine has ever planned a slot for.
- **`react-router-dom` 6.30.6 carries two moderate advisories**, and the fix is
  a semver-major move to 7.x. Checked rather than assumed: neither is reachable.
  The SSR hydration one needs SSR and this is a Vite SPA with no server entry.
  The open redirect needs an attacker-controlled navigation target, and every
  `navigate()` and `to={}` in `src/` is a literal, a constant role-map lookup or
  a database UUID. Worth doing as its own migration, not urgent.
- **`SectionCard` is dead code.** Nothing imports it but a comment in `Panel.tsx`.
- ~~**A monthly cap discards the rest of the month.**~~ **Closed, and it was
  never written down as a gap.** A client reaching its cap had its job failed
  non-retryably and its slot failed with it, and nothing resumed when the cap
  was raised or when the month rolled over — the cap row is per month, so the
  refusal stopped being true on the 1st and the work was already gone. `failed`
  now means something broke; a cap is a hold, and `resume_paused_jobs` runs
  hourly and re-checks the reason rather than trusting the recorded one.
- **Node 25's `localStorage` shadows jsdom's and has no methods on it.** Fixed
  in the test setup, and worth recording because the visible half was cheap
  (five failing AdCopyModal tests) and the expensive half was silent: FormModal
  restores a cancelled edit from `localStorage` and AgentActivityBar keeps
  dismissals in `sessionStorage`, and under test both were reading and writing
  a store that quietly did nothing. The setup file's own `clear()` was wrapped
  in a try/catch, which swallowed the first sign of it.
- **101 advisor warnings for `SECURITY DEFINER` functions callable by
  `authenticated`** (26 at the last revision). The September note ended with
  the right worry: "the safety of all 26 rests on those internal guards
  rather than on the grant, so a new one added without a guard would not be
  caught by the linter — it would look exactly like these." Three had been
  added without one by the time anybody looked, and
  `security_definer_exposure.body_checks_the_caller` now answers the question
  the linter cannot:

  ```sql
  select * from security_definer_exposure where not body_checks_the_caller;
  ```

  Twenty rows on staging. Fifteen are fine and the reason is written into
  migration 162 so it is not re-litigated on every review: `is_admin`,
  `is_member`, `current_role_of` and the rest are the permission primitives
  themselves, so "check the caller" is what they are; `lead_stage_rank` is
  arithmetic on an enum; the trigger functions are run by Postgres without
  consulting EXECUTE at all; the MCP entry points check a bot's own grant.
  The remaining five are the engine's own drivers, which are service_role
  only. Any row that is none of those is a finding.

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
  leaked-password gap stays visible. It also re-lists every `SECURITY DEFINER`
  function callable by `authenticated` — 101 now — and the useful question is
  not that count but which of them check their own caller. Ask the database
  rather than the advisor: `select * from security_definer_exposure where not
  body_checks_the_caller`, and compare the rows against the fifteen migration
  162 explains. Anything else is a finding.
- **Agents without runners:** `agents` table vs `RUNNERS` in
  `agent-runtime/src/orchestration/dispatch.ts`.
- **Deployed version:** `select version from agent_runtime_status where is_live`.
- **RLS coverage:** `pg_class.relrowsecurity` and `pg_policy` over `public`.
- **Cross-client isolation:** `node scripts/rls-isolation-test.mjs`, with
  `.env.local` sourced and `RLS_TEST_CLIENT_A_PASSWORD` /
  `RLS_TEST_CLIENT_B_PASSWORD` set (the script holds no credentials).
- **Exposed functions:** `select * from security_definer_exposure where
  anon_can_execute`, which is the same `has_function_privilege` check the
  September revision used and reports it as rows rather than as a claim. Any
  row is a finding. If the count is non-zero after a migration that added a
  function, that migration forgot `select
  public.lock_down_definer_functions();` — `ALTER DEFAULT PRIVILEGES` cannot
  do this and fails silently, so the call is the mechanism.
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

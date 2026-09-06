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
| Schema in git | **47 migrations, all exported.** | `supabase/migrations/`. |
| Idea → brief → asset → scheduled | **Built end to end**, AI and human routes. | See gap 1: the AI half has never completed a render. |
| Reporting ingest | **Built end to end**, steps 1–6, scheduled daily. | See gap 1: no live pull has ever succeeded. |

---

## 1. Nothing external is connected — the only substantial blocker

One gap, not three, because it is one shape: the code exists, the failure
paths are verified against the real services, and no call has ever succeeded
because no credential is configured.

| Integration | Unlocks | State |
|---|---|---|
| **OpenAI** | The AI build route — creative concept *and* image render | `OPENAI_API_KEY` unset |
| **Meta** (`meta` + `instagram`) | Metrics ingest, and everything downstream: Reporting panels, the commentary agent | 0 rows in `client_integrations`, 0 Vault secrets |
| **Resend** | The email telling an editor a brief is waiting | `RESEND_API_KEY` unset |

Everything around each boundary is verified. Meta's failure path was tested
against the real API — an invalid token came back correctly classified as
non-retryable and flipped the integration to `error`. The email path ran on
Railway and **completed rather than failed**, marking itself `skipped`,
because the assignment is the work and the email is only the notification.
The image build fails cleanly with "No image renderer is configured", having
refused to pay for a concept it could never render.

What is unproven is the success path of all three.

**Two model ids cannot be verified from here.** `gpt-image-2` and
`gpt-5.6-sol` came from another conversation and are past what this codebase
can check. Both are environment variables, so a wrong id is a config edit,
and a 404 reports itself as *"check CREATIVE_CONCEPT_MODEL — not found"*.

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

## 5. Two audit tables are written and never read

Zero frontend references to either.

- `agent_tool_calls` — every tool call an agent makes, with a permission class.
- `client_asset_reviews` — approve/reject decisions with reasons.

Both matter only on the day someone asks "who approved this, and when" —
which is the day it is too late to start collecting. The collecting is done.

---

## 6. Frontend test coverage is thin

Four frontend test files against five in the runtime. No panel renders under
test, and none of the build pipeline — the modal, the brief detail, the
concept workspace, the reference upload — has one.

The RLS half is addressed: `scripts/rls-isolation-test.mjs` is a real harness
meant to be re-run whenever a policy changes or a table is added. It is not in
CI because it needs two live client credentials.

---

## 7. Everything is still tested against production

One Supabase project. Every migration was applied to it directly, and every
verification run seeded and deleted rows in it. Safe so far because the data
is demo data and each seed was removed — but not a practice that survives real
client data.

**To close:** a second project as staging, `supabase db push` from the
migrations now in git, and a rule that migrations land there first.

---

## 8. Smaller things

- **A finished render has no route to distribution beyond scheduling.** It can
  be approved and booked in from the brief, but nothing links it onward.
- **No backfill UI.** `enqueue_metrics_ingest_jobs(p_days)` accepts a window;
  nothing calls it with anything but the default.
- **`brief` is excluded from master runs by matching its `agent_key` string.**
  `scheduled_only` now exists and is the cleaner mechanism.
- **The Master AI has no spend ceiling.** Turns cost $0.06–$0.16; per-turn cost
  is recorded in `master_ai_messages.cost_usd` and never totalled.
- **Stale worker rows** in `agent_runtime_status` from local testing. Cosmetic —
  `is_live` reports them correctly.

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
OPENAI_IMAGE_MODEL=gpt-image-2
CREATIVE_CONCEPT_PROVIDER=openai
CREATIVE_CONCEPT_MODEL=gpt-5.6-sol
RESEND_FROM=AA Console <briefs@attractacq.com>
CONSOLE_URL=http://localhost:5173
```

### Railway → the service → Variables — the deployed worker

The same two keys, plus:

```
CONSOLE_URL=<the deployed console URL>
MASTER_AI_ALLOWED_ORIGINS=<the deployed console origin>
```

`MASTER_AI_ALLOWED_ORIGINS` defaults to `http://localhost:5173` only. Until it
names the hosted origin, **the Master AI will not work from a deployed front
end** — the browser blocks it before the request is made. This has not bitten
yet only because the console has been run locally.

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
5. **Changing a job's `params` shape is a deploy-ordering problem**, and the
   claim filter does not cover it — it matches on `agent_key`. Deploy the
   runtime *before* migrating the RPC that changes what it is sent.
6. **Revoking a function grant from `anon` alone does nothing.** Functions grant
   `EXECUTE` to `PUBLIC` by default and `anon` inherits it. Revoke from
   `PUBLIC`, then grant back explicitly — and check
   `has_function_privilege` afterwards, because the no-op is silent.

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

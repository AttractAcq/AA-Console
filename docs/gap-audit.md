# Gap audit — 5 September 2026

*Updated the same day: gap 2 closed and re-verified; gap 2a added.*

The current reference for what is built, what is not, and what is built but
unproven. Every claim below was checked against the running system rather
than recalled; how each was checked is stated so it can be re-run.

Supersedes the status framing in `ui-data-entry-mapping.md`, which still
describes this as "a wireframe/mockup app with no backend yet". That has not
been true for some time.

---

## Where the build actually is

| Area | State | How this was checked |
|---|---|---|
| Admin console pages | **Complete.** Every leaf page resolves to a real panel; nothing falls through to a bare `EmptyState`. | Parsed `navigation.ts` against the registries in `Page.tsx`. The only unmatched ids are `delivery` and `account`, which are parent groups, not pages. |
| Agent runtime | **14 agents registered, 14 runners.** No agent can be queued that the runtime cannot execute. | `agents` table vs `RUNNERS` in `dispatch.ts`. |
| Deployment | **Current.** Railway reports `version: 8e0f5ce`, the latest commit. | `agent_runtime_status`. |
| RLS | **Every table has RLS enabled and at least one policy, and cross-client isolation is now tested.** | `pg_class.relrowsecurity`, `pg_policy`, and `scripts/rls-isolation-test.mjs` run against two live client logins. |
| Schema in git | **38 migrations, all exported.** | `supabase/migrations/`. |
| Reporting pipeline | **Built end to end**, steps 1–6. | See "Unproven" below — built is not the same as working. |

---

## Gaps, most consequential first

### 1. No live call to Meta has ever succeeded — reporting is unproven at its only external boundary

There are **zero** rows in `client_integrations` and zero secrets in Vault, so
no ingest has ever returned real data. Everything either side of the network
call is verified: credential read, error classification, normalisation of
real response shapes, id mapping, idempotent upsert, scheduling, the on/off
gate. The fetch returning data is not.

The failure path *is* verified against the real API — an invalid token came
back correctly classified as non-retryable and flipped the integration to
`error`. That is the closest anything has come to Meta.

**To close:** a Meta system-user token stored as provider `meta` with an
`act_<id>` label (paid) and provider `instagram` with an IG user id label
(organic), then turn on Daily Sync. No further code is expected — but that
expectation is exactly what is untested.

### 2. ~~Cross-client RLS isolation~~ — TESTED AND HOLDING (5 Sep 2026)

**Closed.** A second client login was created for Harbour Dental, and both
accounts were used to attack each other's data. `scripts/rls-isolation-test.mjs`
re-runs the whole thing.

What was attempted, in both directions, across all 26 client-scoped tables:

| Attack | Result |
|---|---|
| Unfiltered read of every table | No foreign rows returned |
| Read filtered explicitly to the other client's id | 0 rows |
| `clients` table | Each account sees only itself |
| `agent_job_events` (no `client_id` of its own) | Attract Acquisition, which has no jobs, saw 0 |
| Cross-client `UPDATE` of business context | 0 rows changed; overview verified intact afterwards |
| Cross-client `INSERT` of an audit note | 403 |
| Cross-client `DELETE` of campaigns | 0 rows; all campaigns verified still present afterwards |
| `can_access_client(other)` | `false` |

The write attempts returned HTTP 200 with an empty body rather than 403,
because RLS filters them to zero rows rather than rejecting the statement.
That is a refusal, and the follow-up query confirmed nothing changed — but it
means a caller cannot tell "forbidden" from "no match", so any future test
must verify the data, not the status code.

A static audit ran alongside it, because the live test can only prove tables
that hold data on both sides — nine were empty and would have passed
vacuously. Every policy on every client-scoped table was read directly: all
are admin-only, scoped through `can_access_client()` / `is_client_user()`, or
an equivalent inline `client_users` lookup. None lacks a predicate.

### 2a. Clients can read the profile of anyone sharing a chat channel (NEW)

Found while investigating an oddity in the test above: the Attract Acquisition
account could read all five `profiles` rows, while Harbour Dental could read
one. The cause is `profiles_channel_peer_read`, which grants read access to
the profile of anyone you share a channel with. AA is in `general` alongside
the admin and all three employees; HD is in no channel.

This is deliberate — chat has to render author names — but it has two edges:

- It exposes staff **email addresses and roles** to a client, which is more
  than rendering a name requires.
- **If an admin ever adds two clients to the same channel, they can read each
  other's profile.** Nothing prevents it; the Add Members UI lists every user.
  Today only one client is in a channel, so it has not happened.

This is not cross-client *data* leakage — no client row, campaign, brief or
metric crosses over — but it is the one path by which two clients could see
anything of each other's.

**To close:** expose a narrow view (`id`, `full_name` only) for the chat
author lookup and drop the peer policy on `profiles`. Column privileges are
not an option here, as they are role-wide and would blind admins too.

### 3. `account` is unimplemented in both non-admin consoles

`ClientConsolePage` handles `dashboard`, `active-campaigns`, `active-organic`,
`active-conversion`, `chat`. `EmployeeConsolePage` handles `dashboard`, the
current/past pages for all three roles, and `chat`. Neither handles
`account`, so it renders "coming soon" — in four console variants.

**To close:** one panel, reused. Client-side it wants contact details,
billing status and who their account manager is; employee-side, their own
details, category and compensation.

### 4. `is_channel_member` is callable by `anon`

It is the only `SECURITY DEFINER` function granted to unauthenticated
callers, and it has no caller check of its own. The practical exposure is
small — `anon` has no `auth.uid()`, so it returns false — but it is
inconsistent with migration 10, which revoked exactly this kind of grant
everywhere else.

The other 18 advisor warnings were checked individually and are **not**
findings: `admin_create_team_member` and `admin_store_integration_credential`
both verify `is_admin()` internally, and every client-scoped RPC verifies
`can_access_client()`. They are correctly-built RLS helpers that the linter
cannot tell apart from mistakes.

**To close:** `revoke execute on function is_channel_member(uuid) from anon;`

### 5. Leaked-password protection is off

Supabase Auth is not checking new passwords against HaveIBeenPwned. This
matters more than usual here because console passwords are short and shared
(`123` for every employee account).

**To close:** one setting in the Supabase dashboard, plus a decision about
whether the seeded employee passwords should survive it.

### 6. Landing and offer page reporting has no data source

`metric_surface` carries `landing` and `offer`, and both tabs render, but
nothing writes those rows and nothing will: page performance comes from site
analytics, not the ad platform. The Meta credential cannot produce these
numbers. The tabs say so rather than showing an empty state that reads as a
bug.

**To close:** a second connector — GA4 or Plausible — behind the same
`MetricsSource` interface the Meta one implements. The schema, scheduler,
queue and panels need no change.

### 7. The commentary agent cannot describe a trend

Asked to report, it correctly says: *"There is no prior-period data in this
summary, so nothing here can be called up or down — everything below is a
level, not a trend."* That is the right behaviour given what it is handed,
but it is a permanent ceiling on how useful the commentary can be.

`metrics_daily` holds the history to support it; `metrics_period_summary()`
simply does not compute a comparison.

**To close:** extend that function with a prior-window block. Both the panels
and the agent pick it up automatically, because they read the same function.

### 8. Two audit tables are written but never read

- `agent_tool_calls` — every tool call an agent makes, with a permission
  class, recorded and never surfaced anywhere.
- `client_asset_reviews` — approve/reject decisions with reasons, written by
  `review_media_asset`, and the history is never shown next to the asset.

Both are the kind of record that only matters the day someone asks "who
approved this, and when" — which is the day it is too late to start
collecting it. The collecting is already done; the reading is not.

### 9. Frontend test coverage is thin

29 frontend tests across three files (`fields`, `markdown`, `media`) against
54 in the runtime. No panel renders under test.

The RLS half of this is now addressed: `scripts/rls-isolation-test.mjs` is a
real harness and is meant to be re-run whenever a policy changes or a table
is added. It is not wired into CI, because it needs two live client
credentials.

### 10. Everything is tested against production

There is one Supabase project. Every migration in this build was applied to
it directly, and every verification run in this session seeded and deleted
rows in it. That has been safe so far because the data is demo data, and each
seed was removed afterwards — but it is not a practice that survives real
client data.

**To close:** a second Supabase project as staging, `supabase db push` from
the migrations now in git, and a rule that migrations land there first. The
export in `supabase/migrations/` is what makes this possible; it was not
before.

### 11. Smaller things

- **No backfill UI.** `enqueue_metrics_ingest_jobs(p_days)` accepts a window,
  but nothing calls it with anything but the default. Re-pulling a bad month
  currently means SQL.
- **`brief` is excluded from master runs by matching its `agent_key` string.**
  `scheduled_only` now exists and is the cleaner mechanism; the string
  comparison is a leftover.
- **The Master AI has no spend ceiling.** Turns cost $0.06–$0.16 and nothing
  caps a session. Per-turn cost is recorded in `master_ai_messages.cost_usd`
  but never totalled anywhere.
- **Five stale worker rows** in `agent_runtime_status` from local testing.
  Cosmetic — `is_live` reports them correctly as false — but they clutter the
  runtime view.

---

## Things worth not losing

Three traps in this codebase have each been hit more than once. They are
recorded here because the next person will hit them too.

1. **`ALTER TYPE ... ADD VALUE` needs its own migration.** Postgres refuses to
   use an enum value in the transaction that added it. Migrations 20, 26 and
   36 all exist because of this.
2. **`supabase migration fetch` overwrites migration 11** and restores the
   five plaintext console passwords for commit. Always
   `git checkout HEAD -- supabase/migrations/*_11_auth_users_*` afterwards and
   sweep the staged diff. Documented in `supabase/README.md`.
3. **`UNIQUE` treats NULLs as distinct.** Migration 22 exists to undo this;
   `metrics_daily.external_id` is `NOT NULL` specifically so its identity key
   cannot repeat it.

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
  Add any new client-scoped table to the `TABLES` list in that file, and
  remember it only proves tables holding data on both sides — pair it with the
  static policy read for the rest.
- **Security warnings:** Supabase advisors — then check each
  `SECURITY DEFINER` function for an internal `is_admin()` or
  `can_access_client()` guard before treating it as a finding.
- **Orphaned schema:** grep each table name across `src/`, excluding
  `types/database.ts`. Tables read through an RPC or a view will look like
  false positives — `metrics_daily` and `agent_runtime_heartbeats` are.

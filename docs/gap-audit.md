# Gap audit — 5 September 2026

*Third revision, same day. Gap 2 closed and re-verified; the brief→asset
pipeline landed; gaps renumbered around what is now the single biggest item.*

The current reference for what is built, what is not, and what is built but
unproven. Every claim was checked against the running system rather than
recalled, and the method is stated so each can be re-run rather than trusted.

Supersedes the status framing in `ui-data-entry-mapping.md`, which still
describes this as "a wireframe/mockup app with no backend yet".

---

## Where the build is

| Area | State | Checked by |
|---|---|---|
| Admin console pages | **Complete.** Every leaf page resolves to a real panel. | Parsing `navigation.ts` against the registries in `Page.tsx`. The two unmatched ids are parent groups, not pages. |
| Agent runtime | **16 agents registered, 16 runners.** Nothing can be queued that cannot execute. | `agents` table vs `RUNNERS` in `dispatch.ts`. |
| Deployment | **Current.** Railway reports `0b9a444`, matching HEAD. | `agent_runtime_status`. |
| RLS | **Every table enabled with policies, and cross-client isolation is tested.** | `pg_class.relrowsecurity`, `pg_policy`, and `scripts/rls-isolation-test.mjs` against two live client logins. |
| Schema in git | **41 migrations, all exported.** | `supabase/migrations/`. |
| Idea → brief → asset | **Built end to end**, both the AI and the human route. | See gap 1: the AI half has never completed. |
| Reporting ingest | **Built end to end**, steps 1–6. | See gap 1: no live pull has ever succeeded. |

---

## 1. Three integrations are built and none is connected

This is now one gap, not three, because it is one shape: the code exists, the
failure paths are verified, and no call has ever succeeded because no
credential is configured.

| Integration | What it unlocks | State |
|---|---|---|
| **Meta** (`meta` / `instagram`) | Paid and organic metrics ingest, and everything downstream: Reporting panels, the commentary agent | 0 rows in `client_integrations` |
| **OpenAI** (`OPENAI_API_KEY`) | The AI build route — the creative concept *and* the image render | Unset on the runtime |
| **Resend** (`RESEND_API_KEY`) | The email that tells an editor a brief is waiting | Unset on the runtime |

Everything around each boundary is verified. Meta's failure path was tested
against the real API — an invalid token came back correctly classified as
non-retryable and flipped the integration to `error`. The email path ran for
real on Railway and **completed rather than failed**, marking itself
`skipped` because the assignment is the work and the email is only the
notification. The image build failed cleanly with "No image renderer is
configured", having correctly refused to pay for a concept it could never
render.

What is unproven is the success path of all three.

**Two model ids cannot be verified from here.** `gpt-image-2` and
`gpt-5.6-sol` came from another conversation and are past what this codebase
can check. Both are environment variables — `OPENAI_IMAGE_MODEL` and
`CREATIVE_CONCEPT_MODEL` — so a wrong id is a config edit, and a 404 reports
itself as *"check CREATIVE_CONCEPT_MODEL — not found"* rather than something
obscure.

**To close:** credentials on the Railway service, and a Meta system-user
token in `client_integrations`. No further code is expected — but that
expectation is exactly what is untested.

---

## 2. ~~Cross-client RLS isolation~~ — TESTED AND HOLDING

**Closed.** A second client login was created for Harbour Dental and both
accounts were used to attack each other's data. `scripts/rls-isolation-test.mjs`
re-runs it.

| Attack, in both directions across 26 tables | Result |
|---|---|
| Unfiltered read of every table | No foreign rows |
| Read filtered explicitly to the other client's id | 0 rows |
| `clients` table | Each account sees only itself |
| Child rows with no `client_id` of their own | 0 for the client with no jobs |
| Cross-client `UPDATE` / `INSERT` / `DELETE` | Nothing changed, verified afterwards |
| `can_access_client(other)` | `false` |

The write attempts return **HTTP 200 with an empty body**, not 403 — RLS
filters them to zero rows rather than rejecting the statement. Any future
test must verify the data, not the status code.

A live test only proves tables holding data on both sides; nine were empty
and would have passed vacuously. So every policy on every client-scoped table
was also read directly. None lacks a predicate.

### 2a. Clients can read the profile of anyone sharing a chat channel

`profiles_channel_peer_read` grants read access to the profile of anyone you
share a channel with. Deliberate — chat renders author names — but it exposes
staff **email addresses and roles** to a client, and **if an admin ever adds
two clients to the same channel they can read each other's profile**. Nothing
prevents it; the Add Members UI lists every user.

No client data crosses over. This is the one path by which two clients could
see anything of each other's.

**To close:** a narrow view (`id`, `full_name`) for the chat author lookup,
and drop the peer policy. Column privileges are role-wide and would blind
admins too.

---

## 3. `account` is unimplemented in all four consoles

Confirmed still open. The client console handles `dashboard`,
`active-campaigns`, `active-organic`, `active-conversion`, `chat`; the
employee console handles `dashboard`, the current/past pages for all three
roles, and `chat`. Neither handles `account`, so it renders "coming soon" in
the client console and for editors, avatars and SMMs.

**To close:** one panel, reused. Client-side: contact details, billing
status, who their account manager is. Employee-side: their own details,
category, compensation.

---

## 4. ~~`is_channel_member` callable by `anon`~~ — CLOSED

**Closed.** No `SECURITY DEFINER` function in `public` is now reachable
without signing in.

Worth recording how: the first attempt, `revoke execute ... from anon`,
changed nothing. Functions grant `EXECUTE` to `PUBLIC` by default and `anon`
inherits it, so revoking from a role that never held its own grant is a
no-op — and `has_function_privilege('anon', ...)` still returned true
afterwards. The working form is to drop the `PUBLIC` grant and grant back
explicitly, which is what migration 10 did originally.

The other advisor warnings were checked individually and are not findings:
`admin_create_team_member` and `admin_store_integration_credential` both
verify `is_admin()` internally, and every client-scoped RPC verifies
`can_access_client()`.

---

## 5. Leaked-password protection is off

Supabase Auth is not checking new passwords against HaveIBeenPwned. It
matters more than usual here because console passwords are short and shared
(`123` for every employee account), and there are now two client logins on
the same pattern.

---

## 6. ~~A build cannot be re-run, edited, or compared~~ — BUILT

**Closed.** The concept and its renders are now separate rows: a generation
owns the concept, `creative_renders` holds every image made from it.

- **Re-render** an existing concept at any quality. The runner reuses the
  stored concept and logs that it cost nothing, so iteration pays for the
  render only — cents against $0.28.
- **Edit the concept** in place. Saving does not render; the prompt is
  recomposed from the edited text on the next render, so an edit is free
  until an image is asked for. Edits are stamped, like human-edited records.
- **Compare and select.** Renders show side by side with quality, cost and
  status; one can be selected per concept.

Image cost is estimated from quality because the API returns none — without
that a re-render would read as $0.00, wrong in the direction that makes
iteration look free.

**The loop is now closed too.** Selecting a render used to set a flag with
no consequence. The selected render now carries the next action inline:
approve it, then book it in with a date and channel, without leaving the
brief. Verified end to end — a render approved and scheduled from inside the
brief produced a `scheduled_posts` row on the client's calendar, with
`client_id` filled by the existing trigger, the review logged to
`client_asset_reviews`, and the whole thing traceable back to the brief it
came from.

---

## 7. Concept generation sends far more context than it needs

The one measured build cost **$0.28** for the concept alone, on 33,484 input
tokens — the full client intelligence.

The design doc this feature was built from warns against precisely this in
its own section 15: *"Do not simply dump the full client brain into every
generation request"*, suggesting 5–15k tokens via relevant retrieval. The
implementation does the thing the doc warns about.

At 100 creatives a month that is roughly $28 in concepts before a single
image is rendered.

**To close:** select the context a creative concept actually needs — ICP,
brand voice, offer, proof — rather than passing every upstream record.

---

## 8. Landing and offer page reporting has no data source

`metric_surface` carries `landing` and `offer`, and both tabs render, but
nothing writes those rows and nothing will: page performance comes from site
analytics, not the ad platform. The tabs say so rather than showing an empty
state that reads as a bug.

**To close:** a second connector behind the same `MetricsSource` interface.
Schema, scheduler, queue and panels need no change.

---

## 9. The commentary agent cannot describe a trend

Asked to report, it correctly says *"there is no prior-period data in this
summary, so nothing here can be called up or down"*. Right behaviour, but a
permanent ceiling: `metrics_daily` holds the history,
`metrics_period_summary()` simply does not compute a comparison.

**To close:** a prior-window block in that function. Both the panels and the
agent pick it up automatically, because they read the same one.

---

## 10. Two audit tables are still written and never read

Re-checked: zero frontend references to either.

- `agent_tool_calls` — every tool call an agent makes, with a permission class.
- `client_asset_reviews` — approve/reject decisions with reasons.

Both matter only on the day someone asks "who approved this, and when" —
which is the day it is too late to start collecting. The collecting is done.

*(`creative_generations` and `brief_dispatches` were in this list an hour ago
and are now both surfaced in the brief detail modal.)*

---

## 11. Frontend test coverage is thin

Four frontend test files (`fields`, `markdown`, `media`, plus the RLS script)
against five in the runtime. No panel renders under test, and none of the new
build pipeline — the modal, the brief detail, the reference upload — has a
test.

The RLS half is addressed: `scripts/rls-isolation-test.mjs` is a real harness
meant to be re-run whenever a policy changes or a table is added. It is not in
CI because it needs two live client credentials.

---

## 12. Everything is still tested against production

One Supabase project. Every migration was applied to it directly, and every
verification run seeded and deleted rows in it. Safe so far because the data
is demo data and each seed was removed — but not a practice that survives real
client data.

**To close:** a second project as staging, `supabase db push` from the
migrations now in git, and a rule that migrations land there first.

---

## 13. Smaller things

- **No backfill UI.** `enqueue_metrics_ingest_jobs(p_days)` accepts a window;
  nothing calls it with anything but the default. Re-pulling a bad month means
  SQL.
- **`brief` is excluded from master runs by matching its `agent_key` string.**
  `scheduled_only` now exists and is the cleaner mechanism.
- **The Master AI has no spend ceiling.** Turns cost $0.06–$0.16; per-turn cost
  is recorded in `master_ai_messages.cost_usd` and never totalled.
- **Five stale worker rows** in `agent_runtime_status` from local testing.
  Cosmetic — `is_live` reports them correctly.
- **A generated asset has no route to distribution from the brief.** It lands
  in Media pending review and must be found there; nothing links a build to
  the scheduling step.

---

## Traps worth not re-learning

Each of these has been hit more than once.

1. **`ALTER TYPE ... ADD VALUE` needs its own migration.** Postgres refuses to
   use an enum value in the transaction that added it. Migrations 20, 26 and 36
   all exist for this reason.
2. **`supabase migration fetch` overwrites migration 11** and restores the five
   plaintext console passwords for commit. Always
   `git checkout HEAD -- supabase/migrations/*_11_auth_users_*` afterwards and
   sweep the staged diff. Documented in `supabase/README.md`.
3. **`UNIQUE` treats NULLs as distinct.** Migration 22 undoes this;
   `metrics_daily.external_id` is `NOT NULL` specifically so its identity key
   cannot repeat it.
4. **A worker must only claim agents it implements.** `claim_agent_job` always
   accepted the filter; not passing it meant a container claimed agents it had
   no runner for and burned their attempts. Registering an agent before its
   runner ships was destructive until this was fixed.
5. **Changing a job's `params` shape is a deploy-ordering problem, and the
   claim filter does not cover it.** That filter matches on `agent_key`, so the
   live runner happily claims a job for a key it knows and then cannot read the
   arguments. This was hit when `creative_build` moved from `generation_id` to
   `render_id`: the RPC was migrated first, the runtime was still one commit
   behind, and the job burned all three attempts on "No generation to build."
   **Deploy the runtime before migrating the RPC that changes what it is sent**,
   or make the runner accept both shapes across the transition.

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
- **Security warnings:** Supabase advisors — then check each
  `SECURITY DEFINER` function for an internal `is_admin()` or
  `can_access_client()` guard before treating it as a finding.
- **Orphaned schema:** grep each table name across `src/`, excluding
  `types/database.ts`. Tables read through an RPC or a view look like false
  positives — `metrics_daily` and `agent_runtime_heartbeats` are.

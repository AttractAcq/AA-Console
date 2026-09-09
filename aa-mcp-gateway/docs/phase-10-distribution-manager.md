# Phase 10 — Distribution Manager (approved asset → schedule → record publication → read)

Status: design locked for implementation; **Sec review required before merge/cutover**.
Base: main at `d91c3a1`, on top of Phases 3–9b (migrations 65–74). No production apply or
Railway deploy from this change. The [Phase 3–4](phase-3-4-bot-auth-rls.md),
[Phase 5](phase-5-production-manager.md) and [Phase 9b](phase-9b-production-bot-decide.md)
binding Sec rules remain binding **except** where this note explicitly and narrowly lifts one:
Bot-safe distribution scheduling and publication recording, for `bot_distribution` only.

## Alex CLEAR (2026-09-09) — implement with brief defaults

1. Realize **`content.queue_distribution`** as the primary schedule write (Bot-safe wrapper
   around `schedule_asset` / `scheduled_posts`). Add minimal companion tools only if Gate 10
   cannot complete otherwise; prefer registry names over inventing a parallel `distribution.*`
   namespace. (One companion write was needed: `content.record_publication`, plus reusing the
   existing `content.get_production_status` read rather than inventing a distribution-read tool.)
2. Until platform publish exists, **`record_publication` / mark_published on `scheduled_posts`**
   is acceptable for Gate 10 "publish".
3. First token/grant: **Harbour Dental only**.
4. Prefer **exact allowlist** (Marketing-style). Trim unused seed workflow writes only if they
   widen risk; document final matrix. (None widen risk; full suite kept — see §5.)
5. No merge/Railway/token/connector until Sec APPROVE + Alex CLEAR.

Hard requirements: Sec design note + isolation tests **before** any merge/cutover. No
`workflow.record_decision`. No SQL from Bots. No `can_access_client` on any new RPC. Do **not**
grant `content.queue_distribution` / `content.record_publication` to Marketing / Production /
CDM / CoS. This is a narrow, explicit, Sec-reviewable exception, mirroring Phase 9b's shape
exactly — it does not reopen the Phase 5/6 posture for any other Bot or tool.

---

## 1. Classification matrix (after this change)

| Class | Action | Scope | Notes |
| --- | --- | --- | --- |
| Autonomous (new) | `content.queue_distribution` (schedule) | `bot_distribution`, granted client, `approved` asset only | Bot-safe wrapper around the `scheduled_posts` insert `schedule_asset()` already performs for humans. Writes `scheduled_posts` + `created_by_bot`. |
| Autonomous (new) | `content.record_publication` (Gate 10 "publish") | `bot_distribution`, granted client, `scheduled` row only | Minimal companion write (Alex CLEAR #1/#2): marks a scheduled row `published`/`failed` with `external_id`/`failure_reason`, attributed to the Bot. Stands in for live platform publish, which AA does not have yet. |
| Autonomous (extended, unchanged tool name) | `content.get_production_status` | Granted client only | Additive `distribution` field: the scheduled/publication rows for the resolved asset (or every asset on the resolved brief). No existing key changed. This is the "read schedule/publication status" surface from the brief — reusing the existing tool rather than inventing a new read, per Alex CLEAR #1. |
| Autonomous (unchanged) | `content.get_brief`, workflow task/approval suite | Granted client only | Phase 5/Phase 3–4 contract unchanged; already real and already seeded to `bot_distribution` (migration 65). |
| Deferred (out of scope) | Reschedule / cancel a `scheduled_posts` row | — | Gate 10's happy path does not need it (brief §"Proposed capability classes" item 2: "add only if needed for Gate 10; otherwise defer"). Add as a follow-on `content.queue_distribution` variant or new companion tool, with its own isolation review, if Distribution's live use surfaces the need. |
| Documented gap (unchanged, honest) | `content.get_performance`, `attribution.get_content_performance` | — | Remain **stubs**. `metrics_daily` is frequently empty; there is no live Meta/TikTok/etc. read today. Still granted to `bot_distribution` (migration 65 seed, kept — Alex CLEAR #4 only asks to trim workflow writes, not these), so a future implementation activates with zero permission-matrix change, but until then a call returns `not_implemented`/is invisible outside `MCP_DISCOVER_STUBS=true`, identical to any other stub. |
| Forbidden (unchanged) | `workflow.record_decision` | All Bots | Hard-denied in gateway code forever (`allowed()`), independent of any DB grant. |
| Forbidden (unchanged) | Bot SQL access | All Bots | Gateway has no Postgres client; all AA access is `SECURITY DEFINER` RPC over the internal HTTP hop. |
| Forbidden (new, explicit) | `content.queue_distribution`, `content.record_publication` for any Bot other than `bot_distribution` | Production, Marketing, CoS, Client Delivery, Sales Ops, Admin, Finance, Engineering, Security | Hard-coded deny in gateway `allowed()` **and** a hard-coded `p_bot_id <> 'bot_distribution'` check inside both new AA RPCs — exactly the Phase 9b pattern. Not expressed through the permission-grant matrix (see §5) because `bot_production` already holds `content.*` and must keep it for its other real content tools. |
| Forbidden (unchanged, restated) | `content.select_idea`, `content.approve_asset`, `content.generate_brief`, `content.generate_ideas`, `content.assign_production`, `content.submit_asset` for `bot_distribution` | `bot_distribution` | Never granted to Distribution (see `distribution-manager.ts` `forbidden`); Distribution has no `content.*` wildcard, so these are absent by construction, not by a second hard gate. |
| Forbidden (unchanged, restated) | `campaign.*` writes for `bot_distribution` | `bot_distribution` | Never granted; no campaign context read granted either (not needed for Gate 10's asset/schedule/publication path). |
| Out of scope / stub (unchanged) | `content.assign_production`, `content.submit_asset`, `content.generate_ideas` | — | Not touched by this phase. |

---

## 2. Schedule: `content.queue_distribution`

**Naming choice.** Realizes the existing `content.queue_distribution` contract (catalogued since
Phase 3–4, `tool-registry.md`, `src/registry/tools.ts`) rather than a new `distribution.schedule`
name, per Alex CLEAR #1 — one name for one concept, every existing reference (docs, permission
matrix, `MCP_DISCOVER_STUBS` output) stays pointed at it.

**AA tables:** `scheduled_posts`, `client_media_assets` (both migration 06/05). No new table.
Two additive columns on `scheduled_posts`: `created_by_bot` (Bot attribution, mutually exclusive
with the existing human `created_by`, mirroring Phase 9b's `reviewed_by_bot`), and the
`publication_status`/`external_id`/`failure_reason`/`published_by_bot` group used by
`record_publication` (§3).

**Not a call to `schedule_asset()`.** `schedule_asset()` (migration 06) is `SECURITY DEFINER` but
gates on `can_access_client()`, which resolves against `auth.uid()` — there is no Bot session to
resolve, so a Bot cannot call it (Sec Phase 5 #3: never `can_access_client` on Bot paths, in
either direction). `queue_distribution` performs the **same business rule** (approved asset only)
directly against `scheduled_posts` under `require_active_bot` + `require_bot_client_grant`
instead. Console's `schedule_asset()` is untouched and remains the human path.

**RPC:** `mcp_internal.queue_distribution(p_bot_id, p_request_id, p_execution_id, p_client_id,
p_asset_id, p_scheduled_for, p_channel default 'organic')` → `public.mcp_queue_distribution`
wrapper. Same posture as every Phase 5/9b write RPC: `require_active_bot` then
`require_bot_client_grant` (never `can_access_client`), resource `client_id` must match the
granted client (`client_mismatch` otherwise), `REVOKE ALL` from `public`/`anon`/`authenticated`,
`GRANT EXECUTE` to `service_role` only.

**Bot restriction.** Hard-codes `if p_bot_id <> 'bot_distribution' then raise 'bot_forbidden'`,
identical rationale to Phase 9b's `bot_production` checks: `bot_production` already holds
`content.*` for its other real content tools and would otherwise match this exact name too. The
migration asserts (informationally) no `mcp_bot_permissions` row grants either new tool by exact
name to a Bot other than `bot_distribution`; that assertion cannot see through `bot_production`'s
pre-existing `content.*` wildcard, which is why the two hard-coded checks (gateway + RPC), not the
permission matrix, are the real control (see §5).

**Business rule.** Asset must be `client_media_assets.review_status = 'approved'`
(`invalid_asset_status` otherwise); unknown asset is `asset_not_found`; a different client's asset
is `client_mismatch`. `p_channel` must be `organic` or `paid` (the only two values AA's
`post_channel` enum supports today — migration 01; this is the "AA-supported `post_channel` enum"
Gate 10 asks to document as the channel-selection source). `p_scheduled_for` is required.

**Idempotency.** Same ledger as every Phase 5/6/9b Bot content write:
`mcp_internal.mcp_content_requests`, keyed `(bot_id, execution_id)`, via the existing
`take_content_request` helper. The `tool` check constraint is extended (additively, same
find-by-column-then-drop-and-recreate pattern Phase 9b used) to allow
`'content.queue_distribution'` and `'content.record_publication'`. A new nullable `schedule_id`
column links a ledger row to its `scheduled_posts` row without a second ledger table.

**Result.** `{ client_id, asset_id, schedule_id, scheduled_for, channel, publication_status:
'scheduled', created_by_bot, replayed }`.

---

## 3. Record publication: `content.record_publication`

**Why a new tool name, not a `mark_published` flag on `queue_distribution`.** Scheduling and
recording an outcome are different authorization moments separated by real time (a post is
scheduled today, published — or not — later) and, per Alex CLEAR #2, this is deliberately the
Gate 10 stand-in for a capability AA does not have yet (live platform publish). Keeping it a
distinct, separately audited call makes the gap visible in the audit trail and in `tools/list`,
rather than folding a "did it actually go out" claim into the scheduling call.

**AA table:** `scheduled_posts` only (no new table). Additive columns: `publication_status`
(`scheduled | published | failed`, default `scheduled`), `external_id`, `failure_reason`,
`published_by_bot`.

**RPC:** `mcp_internal.record_publication(p_bot_id, p_request_id, p_execution_id, p_client_id,
p_schedule_id, p_status, p_external_id default null, p_failure_reason default null)` →
`public.mcp_record_publication` wrapper. Same `require_active_bot` + `require_bot_client_grant` +
resource `client_id` match posture. `p_status` is `'published' | 'failed'`; anything else is
`invalid_request`. Row must currently be `publication_status = 'scheduled'`
(`invalid_schedule_status` otherwise — no re-decide, matching Phase 9b's asset-decide asymmetry:
there is no human override path for this row today, so there is no override case to preserve
either). Unknown schedule id is `schedule_not_found`; a different client's row is `client_mismatch`.

**Bot restriction:** identical hard-coded `p_bot_id <> 'bot_distribution' → bot_forbidden` check.

**Full audit trail:** the `scheduled_posts` row itself (`publication_status`, `external_id`,
`failure_reason`, `published_by_bot`, `published_at` set only on success), the
`mcp_content_requests` ledger row (`tool = 'content.record_publication'`, full payload, idempotent
replay), and the gateway's own request audit log (`Store.audit`) — same three-way trail Phase 9b
established for `content.approve_asset`.

**Gateway risk/approval classification.** `content.queue_distribution` was previously in the
gateway's generic HIGH-risk `approval` array (`src/registry/tools.ts`), which would force every
call through the gateway's separate reviewer-approval queue before the AA RPC ever runs — on top
of, and unrelated to, AA's own authorization. Since the tool was a stub, this was never exercised.
Making it real while leaving it in that list would mean a human must click approve at the gateway
for every single schedule, defeating Alex's CLEAR ("realize `content.queue_distribution` as the
primary schedule write" — an autonomous capability). We **removed** `queue_distribution` from that
array, matching Phase 9b's identical move for `content.approve_asset`: both now sit at **MEDIUM**
risk and rely on AA RPC authorization (active bot + client grant + hard bot check) rather than a
second gateway-level human click. `content.record_publication` was never in that list (new tool)
and is unaffected. **Sec question, same shape as Phase 9b's:** is MEDIUM + AA-RPC-only
authorization the right posture for both, or should the gateway reviewer gate be restored for one
or both pending a longer trial period? One-line change in `src/registry/tools.ts`, no AA RPC or
isolation-test impact either way.

---

## 4. Read: extending `content.get_production_status`

Rather than add a `distribution.get_status` (or similar) read tool, the existing
`mcp_internal.get_production_status` RPC — already real and already seeded to `bot_distribution`
since migration 65 — gains one additive JSON field, `distribution`: the `scheduled_posts` rows for
the resolved asset (or, when only a brief/idea was given, every asset on that brief), each with
`id, asset_id, scheduled_for, channel, publication_status, external_id, failure_reason,
published_at, created_by_bot, published_by_bot`. No existing key's shape or meaning changed; every
existing Phase 5/6/9b consumer of this RPC (Production, Marketing's read of it, CoS) is
unaffected — the field is simply absent from their concern. This is the "CoS (or Distribution)
reads resulting status via allowed tools" surface Gate 10 asks for, and it satisfies Alex CLEAR
#1's "prefer registry names" principle for reads as well as writes.

---

## 5. Auth

Both new RPCs follow the Phase 3–5/9b pattern exactly:

- `mcp_internal.require_active_bot(p_bot_id)` — active-bot check, `service_role` only.
- `mcp_internal.require_bot_client_grant(p_bot_id, p_client_id)` — `mcp_bot_clients` membership,
  `FOR SHARE`, never `can_access_client`.
- Resource `client_id`/ownership match: loaded `FOR UPDATE`, checked before any write; mismatch is
  `client_mismatch`, raised before the row is used.
- `REVOKE ALL … FROM public, anon, authenticated; GRANT EXECUTE … TO service_role` on both the
  `mcp_internal` RPC and the `public` wrapper.
- **New, additive to this phase:** a hard-coded `p_bot_id <> 'bot_distribution'` check inside both
  RPCs (`bot_forbidden`), independent of the grant matrix — the mechanism that keeps the
  capability off `bot_production`/`bot_marketing`/`bot_chief_of_staff`/`bot_client_delivery` even
  though `bot_production` already holds a `content.*` wildcard it must keep for its other real
  content tools. The gateway mirrors this with a hard-coded check in `allowed()` (exported as
  `DISTRIBUTION_ONLY_TOOLS`, alongside Phase 9b's `PRODUCTION_ONLY_TOOLS`), so the deny happens
  **before** AA is ever called.
- **New, additive to this phase (exact-allowlist ceiling):** `allowed()` also gains a
  `bot_distribution`-specific ceiling — `identity.bot === "bot_distribution" &&
  !distributionManager.grants.some(...)` denies — mirroring the existing Marketing ceiling. This
  is what makes Alex CLEAR #4 ("exact allowlist like Marketing") actually load-bearing against a
  stale or overbroad future DB grant/wildcard, not just documentation.
- No SQL from Bots: both new tools go through the same `AA_INTERNAL_API_URL` +
  `AA_MCP_SERVICE_SECRET` HTTP hop as every other content RPC, terminating in a `SECURITY DEFINER`
  function.

---

## 6. Production / Marketing / CoS / CDM stay denied — explicit

- `bot_production`'s permission-matrix grant is **unchanged**: it keeps `content.*`, needed for
  its Phase 5/9b real content tools (`list_ideas`, `get_idea`, `select_idea`, `generate_brief`,
  `get_brief`, `request_revision`, `get_production_status`, `approve_asset`,
  `create_repurpose_plan`, `request_approval`). `content.queue_distribution` and
  `content.record_publication` are removed from `bot_production`'s **effective** tool list by the
  hard gate in §5, even though the wildcard still lexically matches both names — confirmed by the
  updated `bot-permissions.md` (`bot_production` effective tools drops from 27 to 26).
- What is new: `src/policy/permissions.ts` `allowed()` gains a hard, non-grant-based deny —
  `content.queue_distribution` and `content.record_publication` return `false` for any
  `identity.bot !== "bot_distribution"`, evaluated **before** the normal grant-pattern match,
  exactly like `workflow.record_decision` and Phase 9b's `PRODUCTION_ONLY_TOOLS`. A future PR that
  wants to extend either tool to another Bot must touch this line explicitly and go through Sec
  again; it cannot happen by adding a permission row.
- `bot_marketing`, `bot_chief_of_staff`, `bot_client_delivery` never held `content.*`, `content.
  queue_distribution`, or `content.record_publication`, and are unaffected either way; `bot_
  marketing`'s onboarding config already lists `content.queue_distribution` in its `forbidden`
  array from Phase 9.
- No change to the pre-existing `mcp_bot_permissions` seed rows for any Bot other than
  `bot_distribution` (which gains exactly one new row, `content.record_publication` —
  `content.queue_distribution` was already seeded in migration 65). Migration 75 asserts
  (informationally) that no future exact-name grant row targets either new tool outside
  `bot_distribution`; the hard-coded gateway + RPC checks are what actually enforces the boundary.

---

## 7. Distribution's final grant matrix (Alex CLEAR #4)

Locked, exact allowlist — `src/onboarding/distribution-manager.ts` — 14 grants, mirroring
Marketing's shape:

| Group | Tools | Discoverable by default |
| --- | --- | --- |
| Reads (6) | `content.get_brief`, `content.get_production_status`, `workflow.get_task`, `workflow.list_tasks`, `workflow.get_pending_approvals`, `workflow.get_activity` | Yes |
| Writes (6) | `content.queue_distribution`, `content.record_publication`, `workflow.create_task`, `workflow.assign_task`, `workflow.complete_task`, `workflow.create_approval` | Yes |
| Granted stubs (2) | `content.get_performance`, `attribution.get_content_performance` | No (stub; requires `MCP_DISCOVER_STUBS=true`) |

**Workflow write suite kept in full** (`create_task`, `assign_task`, `complete_task`,
`create_approval` — the same four every other Bot with a workflow grant holds): none of the four
widen risk beyond what Production/Marketing already exercise, so Alex CLEAR #4's "trim only if it
widens risk" finds nothing to trim. `workflow.record_decision` remains categorically absent (hard
gateway deny, not merely unlisted).

No campaign grant of any kind (read or write) — Distribution's Gate 10 flow never needs campaign
context, and campaign writes are hard out of scope per the brief regardless of bot.

---

## 8. Isolation tests plan

Both the SQL-layer (`agent-runtime/src/mcp/isolation-rls.test.ts`, RLS-enabled PGlite) and the
HTTP-layer (`agent-runtime/src/mcp/content-route.test.ts`) suites gain a Phase 10 block covering,
for both `queue_distribution` and `record_publication`:

1. **Same-client success** — `bot_distribution` schedules an approved asset / records publication
   on its granted client; state transitions as documented; ledger row inserted; response echoes
   `client_id`.
2. **Cross-client id** (`client_id` not on `mcp_bot_clients` for this Bot) — `client_forbidden`,
   before any row lookup.
3. **Cross-client resource** (granted `client_id`, but the asset/schedule belongs to another
   client) — `client_mismatch`, no write.
4. **Revoked grant** — delete the `mcp_bot_clients` row, replay is `client_forbidden`.
5. **Suspended bot** — `mcp_bots.status = 'suspended'`, `bot_not_active`, even with a live grant.
6. **`anon` / `authenticated` cannot execute** — both public wrappers and their `mcp_internal`
   counterparts reject with Postgres `permission denied`.
7. **`bot_forbidden` for every non-distribution Bot** — `bot_production` (which has `content.*`)
   is denied at the RPC layer even with an active status and a valid client grant.
8. **Idempotent replay** — same `(bot_id, execution_id)` returns the cached ledger result
   (`replayed: true`); a different payload under the same key is `idempotency_conflict`.
9. **State-guard correctness** — `queue_distribution` on a non-`approved` asset is
   `invalid_asset_status`; on an unknown asset is `asset_not_found`. `record_publication` on a
   non-`scheduled` row is `invalid_schedule_status`; on an unknown schedule id is
   `schedule_not_found`.
10. **Composition** — after `queue_distribution`, `record_publication` succeeds on the returned
    `schedule_id`; after `record_publication`, `content.get_production_status`'s `distribution`
    field reflects the final `publication_status`.
11. **Source assertions** — both new RPCs' `pg_get_functiondef` contain `require_active_bot` and
    `require_bot_client_grant`, never `can_access_client`, never `schedule_asset(`, and contain the
    `bot_forbidden` literal.
12. **Gateway deny-before-AA** — `distribution-manager.test.ts` proves a non-distribution identity
    (including one with a synthetic wildcard `content.*` permission set) is rejected with zero
    adapter hits for both new tool names, and that `bot_distribution` + other-client is
    `"Client scope denied."` before AA, matching every other real content tool.

A tool is only added to `realContent` in `src/registry/tools.ts` once all of the above are green —
same bar as Sec Phase 5 requirement 6 and Phase 9b.

**Nonsecret Gate 10 fixture shape** (mirrors Marketing's Gate 9 shape):

```json
{
  "client_id": "<Harbour UUID>",
  "brief_id": "<Harbour brief UUID>",
  "approved_asset_id": "<Harbour asset UUID, review_status=approved — reuse post-Phase-9b AA-0004 if still granted>",
  "pending_asset_id": "<Harbour asset UUID, review_status=pending, for the unapproved-asset negative test>",
  "denied_client_id": "<ungranted client UUID>",
  "denied_task_id": "<task owned by that ungranted client>",
  "denied_asset_id": "<asset owned by that ungranted client>",
  "assignee": "bot_distribution"
}
```

`npm run smoke:distribution -- fixtures.json headers` (`scripts/distribution-onboarding-smoke.ts`,
`scripts/distribution-gate.ts`) runs the discovery-equality check, the schedule →
record-publication → read cycle with replay, the unapproved-asset denial, the full workflow
task/approval suite, and the client-scope/foreign-resource/forbidden-tool denials, against the
existing Harbour stdio connector — no connector change.

---

## 9. Rollback plan if Sec rejects post-cutover

Additive-only migration, no destructive step required:

1. **Gateway (fast, no DB change):** move `content.queue_distribution` and
   `content.record_publication` back out of `realContent` in `src/registry/tools.ts` (or redeploy
   the prior gateway image/commit). Both instantly return `not_implemented`/are hidden from
   discovery again.
2. **RPC (defense in depth, optional):** widen the `bot_forbidden` hard-code to unconditionally
   reject, or revoke `GRANT EXECUTE … TO service_role`, without dropping the function/migration.
3. **No data to unwind:** any schedule/publication decisions already made by the Bot before
   rollback remain valid, audited records (same shape a human `schedule_asset()` call would
   produce, modulo the human/Bot attribution column). Rollback stops *new* Bot writes; it does not
   retroactively invalidate ones already recorded.
4. **Migration 75 itself is never reverted** — the added columns, check-constraint widening, and
   new functions are inert once the gateway stops calling them.

---

## Sec questions (also flagged inline above)

1. §3: is MEDIUM risk + AA-RPC-only authorization (no gateway reviewer gate) acceptable for both
   `content.queue_distribution` and `content.record_publication`, matching the posture Sec already
   reviewed for `content.approve_asset` in Phase 9b?
2. §3: confirm the no-override asymmetry (a Bot can only decide a currently-`scheduled` row, never
   redecide; there is no human "override a publication decision" path today, unlike Phase 9b's
   asset-decide, which explicitly preserves Console override) is acceptable, or whether a
   human-override path should be scoped before cutover.
3. §5: confirm hard-coding `bot_distribution` inside the two new RPCs (rather than only in the
   gateway) is the right belt-and-suspenders layer, same question Phase 9b raised for
   `bot_production`.
4. §1: confirm leaving `content.get_performance` / `attribution.get_content_performance` as
   documented stubs (rather than attempting a real, frequently-empty `metrics_daily` read in this
   phase) is acceptable for Gate 10 closure — Alex CLEAR did not ask for performance reads to go
   live, only for the schedule → publish → read loop.

Ping Sec on the PR before merge, as required by Sec Phase 5 requirement 1 and repeated by every
subsequent phase's CLEAR. No merge, Railway deploy, or production migration apply without Alex via
CoS after Sec APPROVE.

# Phase 11 — Sales Ops CRM loop (lead → qualify/stage → follow-up → pipeline visibility)

Status: design locked for implementation; **Sec review required before merge/cutover**.
Base: main at `2bf9e47`, on top of Phases 3–10 (migrations 65–75). No production apply or Railway
deploy from this change. The [Phase 3–4](phase-3-4-bot-auth-rls.md), [Phase 5](phase-5-production-manager.md),
[Phase 9b](phase-9b-production-bot-decide.md) and [Phase 10](phase-10-distribution-manager.md)
binding Sec rules remain binding. This phase adds one further exception, narrow and explicit:
Bot-safe pipeline reads + safe pipeline writes + sales-agent reads, for `bot_sales_ops` only.

## Alex CLEAR (2026-09-10) — implement with brief defaults

1. Harbour-only first token/grant (declaration only in this PR — no token issued, see §5 below).
2. Exact 17-tool allowlist for `bot_sales_ops` only; replace the `pipeline.*` / `sales_agents.*`
   wildcards (and the seeded `proof.search` / `proof.get`) with exact names.
3. Migration 76, additive only.
4. Realize: `pipeline.list_leads` / `get_lead` / `get_stalled_leads` / `get_pipeline_summary` +
   `update_stage` + `create_followup`; `sales_agents.list` / `get` / `get_conversations`;
   the 8-tool workflow task/approval suite (already real, unchanged).
5. Defer/keep-stub/forbidden: `pipeline.record_sale`, all `sales_agents` writes/`test`/`deploy`,
   `proof.*` — HIGH/CRITICAL reviewer posture stays on the registry names that remain; none of
   these are realized or granted in this phase.
6. Design note first, isolation green before unstub. Draft PR against main. No merge, no deploy,
   no production migration apply, no token issue, no connector change.

Hard requirements carried forward: no `workflow.record_decision`; no SQL from Bots; no
`can_access_client` on any new RPC; `require_active_bot` + `require_bot_client_grant` on every new
Bot RPC; content decide/distribution tools and campaign writes stay absent from Sales Ops; other
live Bots' grants stay untouched.

---

## Sec bar response (SEC_BAR.md, locked 2026-09-10) — all 9 points

**1. `bot_sales_ops` only; exact 17-tool allowlist + code ceiling (Marketing/Distribution
pattern) — replace `pipeline.*`/`sales_agents.*` wildcards; stale/overbroad DB grants must not
widen discovery/call.**
Done three ways, matching the Marketing/Distribution precedent exactly:
- `src/onboarding/sales-ops.ts` declares the exact 17 names (`reads`/`writes`/`grants`/
  `expectedDiscovery`), same shape as `marketing-director.ts`/`distribution-manager.ts`.
- `src/policy/permissions.ts` `grants.bot_sales_ops` now spreads `salesOps.grants` (was the two
  wildcards + `proof.search`/`proof.get`), and `allowed()` gains a ceiling check —
  `identity.bot === "bot_sales_ops" && !salesOps.grants.some(name => name === tool.name)` denies —
  identical in shape to the existing Marketing/Distribution ceiling checks two lines above it.
  This is what stops a stale or overbroad database row from widening what `bot_sales_ops` can
  discover or call, independent of what is actually granted in the DB.
- Migration 76 `delete`s the `pipeline.*` / `sales_agents.*` / `proof.search` / `proof.get` rows
  for `bot_sales_ops` and `insert`s the 17 exact names, then asserts (a) the wildcards are gone,
  (b) `pipeline.update_stage` is present, confirming the replace happened, not just an add.
  `test/sales-ops.test.ts` ("exact discovery set equality") and
  `agent-runtime/src/mcp/isolation-rls.test.ts` ("permission grants no exact-name row … and the
  wildcard/proof.* rows are gone") both assert the final row count is exactly 17.

**2. Defer `record_sale` and `sales_agents.deploy` (and any other CRITICAL/HIGH money-or-deploy
path) — remain stub/forbidden; keep gateway HIGH/CRITICAL reviewer posture if those names stay in
registry; do not make them real in this phase.**
Neither is touched. `src/registry/tools.ts` gains two new sets, `realPipeline` and
`realSalesAgents`, holding exactly the nine names Alex CLEARed; `pipeline.record_sale` and every
`sales_agents` write/`test`/`deploy` name is absent from both, so `implementation` stays `"stub"`
for all of them — unchanged from before this phase. `pipeline.record_sale` stays in the registry's
generic `approval` array (`action === "record_sale"`), so it is still `risk: "HIGH"`,
`approval: true` if it is ever made real later — the gateway's reviewer-approval queue posture is
untouched. `sales_agents.deploy` stays `risk: "CRITICAL"`, `approval: true` (the `action === "deploy"`
branch). Neither is granted to `bot_sales_ops` (dropped from the permission-row replace in
migration 76, §1), so — being both ungranted *and* stub — they are unreachable by two independent
mechanisms, not one. `test/sales-ops.test.ts` asserts both stay `implementation: "stub"` and both
are absent from discovery and denied ("Tool unavailable or unauthorized.") if called directly, and
again under a synthetic wildcard grant (belt-and-suspenders against the exact-allowlist ceiling).

**3. Drop `proof.*` from Sales Ops grants as Alex locked.**
`proof.search` / `proof.get` are removed from `bot_sales_ops`'s grant row set in migration 76 (§1)
and are not in `sales-ops.ts`'s `grants`/`expectedDiscovery`; they are recorded in `future` (not
`forbidden`'s "hard-coded deny" sense — nothing else holds them either) as an explicit "dropped,
revisit only with a fresh Alex CLEAR" marker, matching the brief's framing ("optional keep if Alex
wants"). The extended `assert_cos_prohibitions()` trigger (§8) also rejects any future row that
tries to re-grant either name to `bot_sales_ops`.

**4. `require_active_bot` + `require_bot_client_grant` on every new Bot RPC; never
`can_access_client`; resource `client_id` match.**
All nine new `mcp_internal.*` RPCs in migration 76 (`list_leads`, `get_lead`, `get_stalled_leads`,
`get_pipeline_summary`, `list_sales_agents`, `get_sales_agent`, `get_sales_agent_conversations`,
`update_lead_stage`, `create_followup`) open with `perform mcp_internal.require_active_bot(p_bot_id);
perform mcp_internal.require_bot_client_grant(p_bot_id, p_client_id);` before touching any table,
and every write additionally locks and checks `v_row.client_id <> p_client_id → client_mismatch`
before writing. None calls `can_access_client` — `get_stalled_leads` calls the existing
`public.stalled_leads()` SQL function only *after* its own Bot-specific check has already passed,
so `stalled_leads()`'s own `(auth.role() = 'service_role' or can_access_client(...))` guard is
inert for this path (the gateway's DB session is always `service_role`); it is not the control.
`agent-runtime/src/mcp/isolation-rls.test.ts`'s "every new RPC uses require_active_bot +
require_bot_client_grant, never can_access_client" test asserts this by reading
`pg_get_functiondef` for all nine signatures.

**5. Harbour-only `mcp_bot_clients` for first token/grant.**
This PR does not issue a token or insert an `mcp_bot_clients` row for `bot_sales_ops` at all — Alex
CLEAR #6 and the brief both say no token/connector until Sec APPROVE + a separate Alex cutover
CLEAR. When that happens, the row should be `('bot_sales_ops', '<harbour-client-id>')` only, same
as Marketing's and Distribution's first grants. **Open question for Sec/Alex, not resolved by this
PR:** whether an `mcp_bot_clients` row for `bot_sales_ops` already exists in the live database is
unknown from migration source alone (migration 65's seed inserts the `bot_sales_ops` *identity* row
only, never a client grant — no migration in this repo grants any Bot a live client). See §Report
back item 6.

**6. `workflow.record_decision` stays hard-denied; no Bot SQL; no bank/transfer paths.**
Untouched. `allowed()`'s `if (tool.name === "workflow.record_decision") return false;` is
unconditional and runs before any Bot-specific branch — Sales Ops is denied by the same line every
other Bot is. Nothing in this phase adds a Postgres client to the gateway (still HTTP-only to
`AA_INTERNAL_API_URL`) or touches `client_billing`/`finance_entries`/any payment table.
`test/sales-ops.test.ts` and the isolation suite both re-assert the denial for `bot_sales_ops`
specifically (not just "some other Bot"), including under a synthetic wildcard grant.

**7. Isolation tests before `realContent`: same-client, cross-client id/resource, revoked grant,
suspended bot, anon/auth denied, gateway deny-before-AA, exact discovery equality.**
`agent-runtime/src/mcp/isolation-rls.test.ts`'s new "Phase 11 Sales Ops isolation" `describe` block
(9 tests) covers, for the two writes and cross-cutting for the reads: same-client success with a
Bot-attributed timeline event and one ledger row; idempotent replay and `idempotency_conflict` on a
different payload under the same key; cross-client id (`client_forbidden`, before any row lookup)
and cross-client resource (`client_mismatch`); a revoked `mcp_bot_clients` row denying replay;
`bot_not_active` on a suspended bot even with a live grant; `bot_forbidden` for every other Bot even
with a valid grant; `anon`/`authenticated` rejected with Postgres `permission denied` on every
public wrapper; and the permission-row assertions from §1/§3/§8. `test/sales-ops.test.ts` (gateway
layer) separately proves gateway deny-before-AA (zero adapter hits on cross-client calls) and exact
discovery-set equality. `src/registry/tools.ts` only adds the nine names to `realPipeline`/
`realSalesAgents` (i.e. only flips them to `implementation: "real"`) in the same PR that adds these
tests, already green — this note documents that bar being met, not a promise to meet it later.

**8. Hard per-tool gates only if another Bot's wildcard would otherwise match a new Sales write
(document whether needed; Production/Marketing do not hold `pipeline.*`/`sales_agents.*` today —
confirm in note).**
Confirmed: grepping migration 65's seed (the only place any Bot's `pipeline.*`/`sales_agents.*`
grant has ever existed) shows exactly one row for each wildcard, both `bot_sales_ops`. No other Bot
(`bot_production`, `bot_marketing`, `bot_distribution`, `bot_chief_of_staff`, `bot_client_delivery`,
`bot_admin`, `bot_finance`, `bot_engineering`, `bot_security_devops`) holds either domain, as a
wildcard or an exact name, anywhere in the migration history. That means the Phase 9b/10 situation
— *"bot_marketing already holds `content.*` and must keep it, so a hard hand-coded hard-coded deny
in `allowed()` is the only way to keep two tools off it"* — does not exist here: the exact-allowlist
ceiling from §1 (`allowed()` denying `bot_sales_ops` calls outside `salesOps.grants`) already fully
constrains `bot_sales_ops`, and no other Bot has anything that would match `pipeline.*`/
`sales_agents.*` for the gateway ceiling to need to counteract. **So: no gateway-level
`SALES_OPS_ONLY_TOOLS`-style set (the `PRODUCTION_ONLY_TOOLS`/`DISTRIBUTION_ONLY_TOOLS` pattern) is
needed or added.** What *is* added, per SEC_BAR-brief item 1 ("hard-coded bot check where
appropriate — Phase 9b/10 pattern") and as defense-in-depth independent of the grant matrix:
- A hard-coded `if p_bot_id <> 'bot_sales_ops' then raise 'bot_forbidden'` inside both new write
  RPCs (`update_lead_stage`, `create_followup`), identical in shape to Phase 9b/10's per-RPC check,
  even though no other Bot currently holds a matching grant — this is what protects the RPC layer
  if it is ever reached by something other than the gateway (a future direct caller, a bug in a
  later phase's grant), not what protects against today's known grant state.
- An *ongoing* database-level guard: `mcp_internal.assert_cos_prohibitions()` (the same
  `AFTER INSERT OR UPDATE OR DELETE` trigger function that already stops `bot_production` from
  getting finance/security/deploy grants) gains a fourth check — any `mcp_bot_permissions` row
  outside `bot_sales_ops` matching `pipeline.%`/`sales_agents.%` raises an exception — plus a fifth
  check that `bot_sales_ops` itself can never regain a domain wildcard or the deferred/dropped
  names. Unlike Phase 9b/10 (which only needed the RPC-layer check because the grant-matrix state
  they were guarding against — Marketing's `content.*` — already existed), this phase's exposure is
  purely *future* stray grants, so a standing trigger is the more direct control than a one-time
  migration assertion; migration 76 still also asserts the invariant once, informationally, at
  apply time. `isolation-rls.test.ts`'s last Phase 11 test inserts a stray `bot_production` /
  `pipeline.list_leads` row directly and confirms the trigger rejects it.

**9. Design note must call out: any tool leaving stub→real that is currently on the gateway
approval/HIGH list (same Q as Phase 9b/10 MEDIUM vs reviewer gate for `update_stage` /
`create_followup`).**
Checked against `src/registry/tools.ts`'s generic `approval` array (`["deploy", "record_sale",
"record_decision"]`, which forces the gateway's own separate human-reviewer queue on top of AA
authorization). Neither `update_stage` nor `create_followup` is in it, and never has been — unlike
Phase 9b's `content.approve_asset`, which *was* on that array as a stub and had to be explicitly
removed when it went real. So there is no "remove from the HIGH/approval array" step here, and no
`realContent`-style array to move a name off. Both land at `risk: "MEDIUM"` (read defaults to LOW,
`deploy` is CRITICAL, everything else in the `approval` array is HIGH; MEDIUM is what is left) with
`approval: false`, purely AA-RPC-authorized (`require_active_bot` + `require_bot_client_grant` +
resource match + the `bot_sales_ops`-only hard gate from §8) — the same posture Phase 9b settled on
for `content.approve_asset` and Phase 10 for `content.queue_distribution`/`content.record_publication`,
just arrived at without needing a removal step. **Sec question, restated for this phase:** is
MEDIUM + AA-RPC-only authorization (no gateway reviewer gate) still the right posture for a Bot
*moving a lead's pipeline stage* and *writing a follow-up*, or should either be pulled onto the
gateway `approval` array pending a trial period? This note's recommendation is MEDIUM, unchanged —
both are reversible (a lead's stage/next_action can be moved again; `reversible: true` on both in
the registry), scoped to a single already-granted client and an already-existing lead, and (per §8)
explicitly cannot reach the two revenue-adjacent stages (`sale`/`cash`) that would make a wrong Bot
call costly to unwind.

---

## 1. Classification matrix (after this change)

| Class | Action | Scope | Notes |
| --- | --- | --- | --- |
| Autonomous reads (new) | `pipeline.list_leads`, `pipeline.get_lead`, `pipeline.get_stalled_leads`, `pipeline.get_pipeline_summary` | `bot_sales_ops`, granted client only | New `mcp_internal.*` RPCs over `client_leads`/`lead_events`; `get_stalled_leads` wraps the existing (migration 61) `public.stalled_leads()` after its own Bot check passes. |
| Autonomous reads (new) | `sales_agents.list`, `sales_agents.get`, `sales_agents.get_conversations` | `bot_sales_ops`, granted client only | New `mcp_internal.*` RPCs over `client_sales_agents`/`sales_agent_conversations` (migration 67). Conversations are read as a roster + turn count, not the raw transcript — see §Data minimization. |
| Autonomous writes (new) | `pipeline.update_stage` | `bot_sales_ops`, granted client, existing lead only | Bot-safe sibling of `advance_lead` (migration 61): same "lost needs a reason" / "clear next_action on a real move" rules, but Bot grant + client match instead of `can_access_client`, idempotency ledger, Bot-attributed timeline event, and — new — `sale`/`cash` target stages refused (money-adjacent guard, §8/§9). |
| Autonomous writes (new) | `pipeline.create_followup` | `bot_sales_ops`, granted client, existing lead only | Writes `next_action`/`next_action_due`; inserts a new `lead_events.kind = 'followup'` row (additive to the kind check constraint) with Bot attribution. |
| Autonomous (unchanged) | Workflow task/approval suite (8 tools) | Granted client only | Already real (Phase 3–8), already seeded to `bot_sales_ops`; this phase only re-confirms the exact 8 names stay in the allowlist. |
| Human-required (unchanged) | Console lead/stage edit, sales-agent build/deploy | All clients | Untouched; this phase adds a parallel Bot-safe path, it does not remove or gate the human one. |
| Forbidden (unchanged) | `workflow.record_decision` | All Bots | Hard-denied in gateway code forever. |
| Forbidden (unchanged) | Bot SQL access | All Bots | No Postgres client in the gateway. |
| Forbidden (new, explicit) | `pipeline.update_stage`, `pipeline.create_followup` for any Bot other than `bot_sales_ops` | Every other Bot | Hard-coded `bot_forbidden` inside both new AA RPCs (§8), on top of the fact that no other Bot is granted either name. |
| Deferred / stub (unchanged posture, now explicit) | `pipeline.record_sale`; `sales_agents.create`/`update_knowledge`/`update_qualification_rules`/`test`/`deploy` | — | Stay stub, ungranted. `record_sale` stays HIGH+approval, `deploy` stays CRITICAL+approval in the registry (§2). |
| Dropped from grants (unchanged posture) | `proof.search`, `proof.get` | — | No longer granted to `bot_sales_ops` (§3); remain generic stubs in the registry, as before. |
| Out of scope | External CRM sync, dialer integration, live bank/payment settlement | — | Not attempted; no AA-native equivalent exists. |

---

## 2. AA RPC mapping

All nine new RPCs follow the exact Phase 5/9b/10 shape: `mcp_internal.<name>(p_bot_id, ...)` doing
the real work, a thin `public.mcp_<name>` wrapper that only calls `require_service_role()` and
forwards, both `revoke all ... from public, anon, authenticated` / `grant execute ... to
service_role`. Reads are declared without `stable` (plain volatile, matching Phase 9b/10's writes
and the Phase 5 hotfix migration 69's lesson — `require_bot_client_grant`'s `for share` needs a
non-read-only transaction).

| Tool | RPC | AA table(s) | New idempotency ledger row? |
| --- | --- | --- | --- |
| `pipeline.list_leads` | `mcp_internal.list_leads` | `client_leads` | no (read) |
| `pipeline.get_lead` | `mcp_internal.get_lead` | `client_leads` | no (read) |
| `pipeline.get_stalled_leads` | `mcp_internal.get_stalled_leads` | `client_leads` via `public.stalled_leads()` | no (read) |
| `pipeline.get_pipeline_summary` | `mcp_internal.get_pipeline_summary` | `client_leads` (aggregate) | no (read) |
| `pipeline.update_stage` | `mcp_internal.update_lead_stage` | `client_leads`, `lead_events` | yes — `mcp_internal.mcp_pipeline_requests` |
| `pipeline.create_followup` | `mcp_internal.create_followup` | `client_leads`, `lead_events` | yes — `mcp_internal.mcp_pipeline_requests` |
| `sales_agents.list` | `mcp_internal.list_sales_agents` | `client_sales_agents` | no (read) |
| `sales_agents.get` | `mcp_internal.get_sales_agent` | `client_sales_agents` | no (read) |
| `sales_agents.get_conversations` | `mcp_internal.get_sales_agent_conversations` | `sales_agent_conversations` | no (read) |

**New ledger, not a reuse of `mcp_content_requests`.** `mcp_internal.mcp_pipeline_requests` is a
separate table from Phase 5's content ledger — different domain, different resource column
(`lead_id`, not `idea_id`/`brief_id`/`asset_id`) — but identical shape, RLS posture (`enable` +
`force` + `revoke all from public, anon, authenticated, service_role`), and replay helper
(`take_pipeline_request`, a line-for-line mirror of `take_content_request`).

**Why not call `advance_lead`/`stalled_leads` directly for the writes.** `advance_lead` (migration
61) is the human/Console path: it authorizes with `can_access_client`, which Sec Phase 3–4 forbids
for any Bot RPC (§4), and it has no request/execution id, no idempotency ledger, and a different
error-message shape (`raise exception 'Not permitted for this client'` as plain text, not the
`errcode = 'P0001'` + machine-readable `message` convention every Bot RPC in this repo uses).
`update_lead_stage` reimplements `advance_lead`'s two business rules (lost needs a reason; a real
stage move clears the stale next-action) rather than calling through it, for the same reason Phase
9b's `approve_idea`/`approve_asset` reimplement rather than call `review_media_asset` — the
authorization posture is different, so the entry point has to be different, even though the
underlying business rule is the same. `get_stalled_leads` is the one read where reuse *is* safe: it
calls `public.stalled_leads()` only after `require_active_bot`+`require_bot_client_grant` have
already passed, at which point `stalled_leads()`'s own `service_role`-satisfied guard is provably
inert, not a bypass.

**Money-adjacent guard, restated.** `update_lead_stage` accepts seven of the nine `lead_stage`
enum values as a target — every one except `sale` and `cash`. Both are rejected with
`invalid_stage` before any row is touched, at three independent layers: the gateway's Zod schema
(`leadStage.exclude(["sale", "cash"])` in `registry/tools.ts`, so the call never reaches the
adapter), the AA RPC's own `if p_stage not in (...) then raise 'invalid_stage'`, and (documented,
not enforced in code) the `pipeline.record_sale` name itself staying the only path Alex has
proposed for a Bot to ever declare revenue. A lead can still reach `sale`/`cash` today only through
Console (`advance_lead`, unchanged) or a future, separately-CLEARed `record_sale`.

**Data minimization on `sales_agents.get_conversations`.** The RPC returns `transcript_turns`
(`jsonb_array_length`) rather than the `transcript` column itself. Sales Ops's stated job is lead
visibility and coordination — who talked to which agent, whether they qualified, what happened
next — which the structured columns (`contact_name`/`contact_email`/`contact_phone`/`qualified`/
`outcome`/`handed_over`/`lead_id`) already answer. The verbatim conversation text is not read by
this phase's tools; if a future phase needs it, that is a new, separately-reviewable field, not an
oversight here.

---

## 3. Auth

Identical posture to every Phase 5/9b/10 Bot RPC (see §Sec bar response items 4 and 8 above for the
specifics): `require_active_bot` → `require_bot_client_grant` → (writes only) `require_mcp_ids` →
(writes only) hard-coded `bot_sales_ops` check → resource lookup `for update` (writes) with
`client_id` match before any write → ledger insert. `REVOKE ALL … FROM public, anon, authenticated`
(writes additionally revoke from `service_role`-adjacent paths the same way Phase 5/9b/10 do) /
`GRANT EXECUTE … TO service_role` on every new function, both `mcp_internal` and `public`.

---

## 4. Isolation tests

`agent-runtime/src/mcp/isolation-rls.test.ts`, new `describe('Phase 11 Sales Ops isolation')` block,
9 tests (57/57 green in the full file after this change, including the pre-existing Phase 4/5/9b/10
blocks, which are unaffected):

1. Source assertions: all nine RPCs contain `require_active_bot`/`require_bot_client_grant`, never
   `can_access_client`; the two writes additionally contain `bot_forbidden`.
2. Reads are client-scoped: same-client succeeds and never returns the other client's rows;
   cross-client id is `client_forbidden`; cross-client resource id is `client_mismatch`.
3. `update_lead_stage` moves the lead, writes one Bot-attributed (`created_by_bot`, `created_by`
   null) `stage_change` timeline event, writes exactly one ledger row, and replays idempotently;
   a different payload under the same key is `idempotency_conflict`.
4. `update_lead_stage` refuses `sale`/`cash` (`invalid_stage`), refuses `lost` with no reason
   (`lost_reason_required`), and is client-scoped (`client_forbidden`/`client_mismatch`).
5. `create_followup` writes `next_action`, one Bot-attributed `followup` timeline event, one ledger
   row, replays idempotently, and is client-scoped.
6. `bot_forbidden` for every Bot other than `bot_sales_ops`, even with an active status and a valid
   client grant (`bot_production` tested explicitly, matching Phase 9b/10's pattern).
7. Suspended bot is `bot_not_active`, even with a remaining grant, on both a read and a write.
8. Revoked grant denies replay (writes) and fresh reads before any lookup.
9. Permission-row assertions: no exact-name row for either write outside `bot_sales_ops`; exactly
   17 rows for `bot_sales_ops`; the wildcard/`proof.*` rows are gone; nothing outside
   `bot_sales_ops` matches `pipeline.%`/`sales_agents.%`; a fresh attempt to insert one is rejected
   by the extended `assert_cos_prohibitions()` trigger.

`aa-mcp-gateway/test/sales-ops.test.ts` (gateway layer, 10 tests) covers what the SQL-layer suite
cannot: exact discovery-set equality (17, matching `salesOps.expectedDiscovery`); the
`implementation`/`risk`/`approval` classification for all nine real tools plus the six deferred
ones; gateway deny-before-AA (zero adapter/AA hits) for cross-client calls on every real tool;
absence-and-denial for every forbidden/deferred name, including under a synthetic wildcard grant;
that no other Bot gains access; and a Gate 11 fixture-driven run of the full happy path
(`runSalesOpsGate`, mirroring `runDistributionGate`) through a fake adapter, verifying audit
identity and idempotent replay end-to-end.

`agent-runtime/src/mcp/pipeline-route.test.ts` (HTTP layer, 9 tests) exercises the actual
`pipeline-route.ts`/`sales-agents-route.ts` body-parsing layer against the real migration-76 RPCs
over PGlite (not mocked): auth-required, per-route happy path, and malformed-body rejection
(unknown filter value, extra body key) before the RPC is ever reached.

**Total new/changed tests this phase: 10 (gateway) + 9 (SQL isolation) + 9 (HTTP route) = 28**, all
green, plus the full pre-existing suites (agent-runtime: 434/434; gateway: 96/97 — the one failure,
`test/gateway.test.ts` "approval rejection, expiration and revoked scope block execution", is a
pre-existing `better-sqlite3` binding error unrelated to and unmodified by this phase; it fails
identically on `main` in this same environment, in a file this PR does not touch).

`src/registry/tools.ts` only adds the nine Phase 11 names to `realPipeline`/`realSalesAgents` (i.e.
flips `implementation` to `"real"`) in the same commit that adds the tests above — the Sec Phase 5
requirement 6 / SEC_BAR item 7 bar ("isolation green before unstub") is met by construction, not by
a follow-up.

---

## 5. Rollback plan if Sec rejects post-cutover

Additive-only migration, same shape as Phase 9b/10:

1. **Gateway (fast, no DB change):** remove the nine names from `realPipeline`/`realSalesAgents` in
   `src/registry/tools.ts` (or redeploy the prior gateway image). All nine instantly return
   `not_implemented`/are hidden from discovery again.
2. **RPC (defense in depth, optional):** widen the `bot_forbidden` hard-code in the two writes to
   unconditionally reject, or revoke `EXECUTE … TO service_role` on any subset, without dropping
   the functions or the migration.
3. **Permission rows (optional):** the exact-17 replace can be reverted to the pre-Phase-11 seed
   (`pipeline.*`, `sales_agents.*`, `proof.search`, `proof.get`) by a follow-up migration; nothing
   in this phase requires that to happen for rollback to be safe, since the gateway-level lever (1)
   is sufficient on its own.
4. **No data to unwind:** any `update_lead_stage`/`create_followup` writes already made by the Bot
   before rollback remain valid, audited state (same shape a human Console edit would produce);
   rollback stops *new* Bot writes, it does not retroactively invalidate ones already recorded.
5. **Migration 76 itself is never reverted** — inert once the gateway stops calling it, exactly
   like every prior "additive, not applied to production without Alex" migration in this repo.

---

## Report back to CoS

1. **PR URL / SHA:** filled in after the draft PR is opened (this note ships in the same PR).
2. **Design note path:** `aa-mcp-gateway/docs/phase-11-sales-ops.md` (this file).
   **Onboarding config path:** `aa-mcp-gateway/src/onboarding/sales-ops.ts`.
3. **Migration #:** **76** (`supabase/migrations/20260910000000_76_mcp_sales_ops.sql`), additive.
4. **Exact discovery tool list (final, 17):** `pipeline.list_leads`, `pipeline.get_lead`,
   `pipeline.get_stalled_leads`, `pipeline.get_pipeline_summary`, `pipeline.update_stage`,
   `pipeline.create_followup`, `sales_agents.list`, `sales_agents.get`,
   `sales_agents.get_conversations`, `workflow.get_pending_approvals`, `workflow.get_activity`,
   `workflow.list_tasks`, `workflow.get_task`, `workflow.create_task`, `workflow.assign_task`,
   `workflow.complete_task`, `workflow.create_approval` — matches the brief's numbered proposal
   exactly, no trims or additions.
5. **Test counts:** gateway unit 10 new (97 total, 96 passing — 1 pre-existing unrelated failure,
   see §4); SQL isolation 9 new (57/57 total passing); HTTP route 9 new (all agent-runtime: 434/434
   passing). Fixture assumption: Gate 11's live Harbour run needs one real Harbour `lead_id` (not
   `lead`/`cash`/`sale` stage, so a stage move is meaningful) and one real Harbour
   `client_sales_agents.id`; `scripts/sales-ops-gate.ts` documents the full fixture shape
   (`SalesOpsFixtures`).
6. **Does the `bot_sales_ops` token / Harbour grant already exist?** Not determinable from source —
   no migration in this repo has ever inserted an `mcp_bot_clients` row or issued a token for any
   Bot; that is operational/runtime state this PR does not touch or query. Confirm directly against
   the live database before Gate 11 execution.
7. **Sec questions / gaps:**
   - §Sec bar response item 9: confirm MEDIUM + AA-RPC-only authorization (no gateway reviewer
     gate) is the right posture for `pipeline.update_stage`/`pipeline.create_followup`, given
     neither was ever on the gateway's HIGH/approval array to begin with.
   - `pipeline.record_sale`: confirmed deferred per Alex CLEAR #5; this PR takes no position on
     when/whether to realize it, only that it stays stub+ungranted for now.
   - `proof.search`/`proof.get`: dropped per Alex CLEAR/SEC_BAR #3; recorded in `sales-ops.ts`
     `future` as a revisit-only-with-fresh-CLEAR marker, not silently forgotten.
   - Which pipeline RPCs were stub vs. real before this phase: **all seven** `pipeline.*` names and
     all eight `sales_agents.*` names were **stub** before this phase (the migration 65 seed
     wildcards granted them, but `src/registry/tools.ts` never had a `realPipeline`/
     `realSalesAgents` set, so every call returned `not_implemented` regardless of the grant — see
     `docs/tool-registry.md` pre-Phase-11 diff). This phase is the first time any pipeline or
     sales_agents tool becomes real for any Bot.
8. **Ready for Sec: yes.** Design note, migration, gateway wiring, agent-runtime routes, and all
   three test layers (gateway/SQL-isolation/HTTP-route) are in this PR together, isolation green
   before the unstub, no merge/deploy/token/connector taken.

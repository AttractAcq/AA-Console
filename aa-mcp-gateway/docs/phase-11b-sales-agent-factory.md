# Phase 11b — Sales Agent Factory (generate → create → knowledge/rules → sandbox test)

Status: design locked for implementation; **Sec review required before merge/cutover**.
Base: main at `d6fc90b` (post Phase 11 / Gate 11 PASS / mig **76**). No production apply or Railway
deploy from this change. The [Phase 3–4](phase-3-4-bot-auth-rls.md), [Phase 5](phase-5-production-manager.md),
[Phase 9b](phase-9b-production-bot-decide.md), [Phase 10](phase-10-distribution-manager.md) and
[Phase 11](phase-11-sales-ops.md) binding Sec rules remain binding. This phase adds one further
exception, narrow and explicit: Bot-safe Sales Agent Factory writes (generate a draft config,
persist a per-client agent, edit its knowledge/qualification rules, sandbox-test it), additive on
`bot_sales_ops` only.

## Alex CLEAR (2026-09-10) — implement with brief defaults

1. Harbour-only first grant (client `d4c87828-741b-44eb-bbeb-16eac3471710`).
2. Exact discovery ceiling **22** on `bot_sales_ops` = Phase 11 (17) + factory (5). Additive only —
   Phase 11's pipeline surface is not touched or rebuilt.
3. Migration **77**, additive, next free after 76.
4. Realize `sales_agents.generate_config`, `create`, `update_knowledge`,
   `update_qualification_rules`, `test` (sandbox — no live channel send).
5. Defer `sales_agents.deploy` + live Meta/WhatsApp OAuth/webhook/send to Phase 11c / Eng — keep
   HIGH/CRITICAL reviewer posture if deploy stays in the registry; not realized in 11b.
6. Console Admin client Sales page gets list/create/update hooks against the **same** AA tables/
   RPCs as the Bot path — must not bypass Bot auth bars.
7. Design note first, isolation green before unstub. Gate 11b smoke may start
   `inbound_qualifier`-only for Harbour. Draft PR against main. No merge/deploy/prod mig/token/
   connector.

Hard requirements carried forward: no `workflow.record_decision`; no SQL from Bots; no
`can_access_client` on any new RPC; `require_active_bot` + `require_bot_client_grant` on every new
Bot RPC; finance/security/deploy/bank, `pipeline.record_sale`, content decide/distribution and
campaign writes stay absent from Sales Ops; other live Bots' grants stay untouched; never a cross-
client agent read/write.

---

## Sec bar response (SEC_BAR.md, locked 2026-09-10) — all 9 points

**1. Additive only on `bot_sales_ops` — Phase 11 pipeline surface unchanged; exact allowlist grows
by factory tools only (ceiling still exact names).**
Done exactly the way Phase 11 extended Marketing/Distribution's pattern:
- `src/onboarding/sales-ops.ts`'s `writes` array grows from 6 to 11 (the two Phase 11 pipeline
  writes + the four still-real workflow writes, plus the five new factory names); `reads` is
  untouched (still 11). `grants`/`expectedDiscovery` are `[...reads, ...writes]`, so they become the
  exact 22-name list without a separate literal to keep in sync.
- `src/policy/permissions.ts`'s `allowed()` ceiling check for `bot_sales_ops` — added in Phase 11 —
  is unchanged in shape (`identity.bot === "bot_sales_ops" && !salesOps.grants.some(...)` denies).
  Because it re-reads `salesOps.grants` rather than a hard-coded count, it automatically re-caps at
  22 the moment `sales-ops.ts` changes; the ceiling logic itself needed no edit.
- Migration 77 **inserts** the five new exact names for `bot_sales_ops` and asserts the final count
  is exactly 22, that `sales_agents.generate_config` is present, and that `sales_agents.deploy` /
  `pipeline.record_sale` are absent — it never touches the 17 rows migration 76 already owns.
  `agent-runtime/src/mcp/isolation-rls.test.ts`'s existing Phase 11 permission-row test (which
  asserted "exactly 17") is updated to 22 in the same PR, since that fixture loads migrations 76 and
  77 together; the new Phase 11b block adds its own "exactly 5 new names, 0 outside `bot_sales_ops`"
  assertion. `aa-mcp-gateway/test/sales-ops.test.ts`'s discovery-equality test is updated to 22.

**2. Per-client agent configs only — never a global AA sales bot; client isolation on every RPC
(`require_active_bot` + `require_bot_client_grant`; never `can_access_client`).**
All five new `mcp_internal.*` RPCs (`generate_sales_agent_config`, `create_sales_agent`,
`update_sales_agent_knowledge`, `update_sales_agent_qualification_rules`, `test_sales_agent`) open
with `perform mcp_internal.require_active_bot(p_bot_id); perform
mcp_internal.require_bot_client_grant(p_bot_id, p_client_id);` before touching any table — identical
shape to every Phase 5/9b/10/11 RPC. The three that operate on an *existing* agent
(`update_knowledge`, `update_qualification_rules`, `test`) additionally lock the row (`for update`
on the two writes; a plain lookup for the read-shaped `test`) and check `v_agent.client_id <>
p_client_id → client_mismatch` before doing anything else. No agent id is ever resolved before the
client grant is checked, and no RPC calls `can_access_client`. No new global bot is created — every
config row still belongs to exactly one `client_id`, and the factory tools only ever act on the
calling client's own rows.

**3. Realize: `generate_config`, `create`, `update_knowledge`, `update_qualification_rules`, `test`
(sandbox — no live channel send).**
All five are flipped from stub to real in `src/registry/tools.ts`'s `realSalesAgents` set, in the
same PR that adds the isolation tests below (green-before-unstub, not a promise). `test_sales_agent`
is sandbox by construction, not by policy: this RPC layer is Postgres — it has no HTTP client and
never touches `sales_agent_conversations` (the live-channel table) or any external API. "No live
channel send" is therefore a structural property of where this code runs, the same way "no SQL from
Bots" is a structural property of the gateway being HTTP-only. `test_sales_agent`'s output is a
rule-check against the agent's own `qualification`/`guardrails` shape (turn count, whether
guardrails/qualification are on file, a simple escalation heuristic) — it is deliberately **not** an
LLM-simulated conversation. Building a real conversational sandbox is future work; claiming this
does that would be exactly the kind of dishonesty Alex's brief asks the design note to avoid.

**4. Defer `sales_agents.deploy` + live Meta/WhatsApp OAuth/webhook/send to Phase 11c / Eng — keep
HIGH/CRITICAL reviewer posture if deploy stays in registry; do not realize in 11b.**
`sales_agents.deploy` is untouched: absent from `realSalesAgents` (stays `implementation: "stub"`),
absent from `salesOps.grants`/`expectedDiscovery`, and gets no permission row in migration 77. It
keeps `risk: "CRITICAL"` and `approval: true` from the registry's generic `action === "deploy"`
branch — unchanged code path, no edit needed. `assert_cos_prohibitions()` (migration 77's replaced
version) still hard-forbids any future row that tries to grant `bot_sales_ops` either
`sales_agents.deploy` or `pipeline.record_sale`. Being both ungranted *and* stub, it is unreachable
by two independent mechanisms — same posture Phase 11 used for `record_sale`. Live Meta/WhatsApp
OAuth, webhooks and inbound message workers are not attempted anywhere in this phase; there is no
code in this PR that could be mistaken for a channel integration. **This is Phase 11b's most
significant scope decision: the factory produces a config a person or a future Eng-owned deploy path
would connect to a channel — it does not connect anything itself.**

**5. Harbour-only first grant.**
This PR does not touch `mcp_bot_clients` — no token, no client grant, for `bot_sales_ops` or any
other Bot. When Alex clears the cutover, the first (and, by CLEAR #1, only) client row inserted for
the factory tools should be `('bot_sales_ops', 'd4c87828-741b-44eb-bbeb-16eac3471710')` — same
Harbour id the brief's Alex CLEAR defaults name — which is also already the row Phase 11's own
pipeline tools would use, since this is additive to the same Bot identity, not a new one.

**6. No bank/finance/security/deploy paths; no `pipeline.record_sale`; no content decide/
distribution; no campaign writes; `workflow.record_decision` hard-deny.**
Untouched. Nothing in this phase adds a Postgres client, touches `client_billing`/
`finance_entries`/any payment table, or grants a `content.*`/`campaign.*` name. `allowed()`'s
unconditional `if (tool.name === "workflow.record_decision") return false;` still runs before any
Bot-specific branch. `sales-ops.ts`'s `forbidden` list keeps every one of these names (with the four
now-realized factory writes removed from it, since they are no longer forbidden — see §3); the
`future` list keeps `pipeline.record_sale`, `sales_agents.deploy`, `proof.search`, `proof.get` as
the still-deferred set.

**7. Isolation before unstub: same-client, cross-client, revoked grant, suspended bot, anon/auth
deny, gateway deny-before-AA, exact discovery equality (22).**
`agent-runtime/src/mcp/isolation-rls.test.ts`'s new `describe('Phase 11b Sales Agent Factory
isolation')` block (10 tests) covers, for all five RPCs: source assertions (`require_active_bot`,
`require_bot_client_grant`, `bot_forbidden`, never `can_access_client`); `generate_config` composes
a draft for the granted client only and replays idempotently (same execution key + different role
→ `idempotency_conflict`; different client → `client_forbidden`; bad role → `invalid_role`);
`create` persists, binds `client_id`, replays idempotently, and is client-scoped; `update_knowledge`
and `update_qualification_rules` write to the owned agent, replay idempotently, and reject a
cross-client **resource** (an agent that exists but belongs to the other client — `client_mismatch`,
distinct from an ungranted client, which is `client_forbidden`); `test` runs its sandbox check,
never touches `sales_agent_conversations` (row count asserted unchanged before/after), and is
resource-scoped the same way; `bot_forbidden` for every Bot other than `bot_sales_ops` on all five,
even with an active status and a valid client grant; suspended bot is `bot_not_active` even with a
remaining grant; revoked grant denies replay before lookup; and the permission-row assertions from
§1 (exactly 5 new names, 0 outside `bot_sales_ops`, deploy/record_sale/proof.* still absent, and a
fresh attempt to grant `bot_sales_ops` the deploy stub or grant `bot_production` a factory name is
still rejected by the trigger). `agent-runtime/src/mcp/pipeline-route.test.ts`'s new `describe('Phase
11b sales agent factory routes')` block (5 tests) exercises the actual HTTP route layer
(`sales-agents-route.ts`) against the real migration-77 RPCs over PGlite: happy path per route,
cross-client denial, and malformed-body rejection (missing required field, unknown extra key, bad
role/shape) before the RPC is ever reached. `aa-mcp-gateway/test/sales-ops.test.ts` (gateway layer)
adds exact discovery-set equality (22), the `implementation`/`risk`/`approval` classification for
all fourteen real `pipeline.*`/`sales_agents.*` tools plus the two still-stub ones, the five factory
writes completing through the AA adapter (and `deploy` never reaching it), gateway deny-before-AA
for the five new tools, and a Gate 11b fixture-driven run (`runSalesAgentFactoryGate`) through a fake
adapter verifying replay and that `deploy` never executes. `src/registry/tools.ts` only adds the
five names to `realSalesAgents` in the same PR that adds all of the above tests, already green —
this note documents that bar being met, not a promise to meet it later.

**8. Design note must ask: MEDIUM + AA-RPC-only vs gateway reviewer gate for each new write; whether
any other Bot wildcard requires per-tool hard gates.**
Answered in full in §Classification and Sec questions below.

**9. Admin client Sales page hooks must not bypass Bot auth bars (same RPCs/grants).**
The Admin/client Sales page (`src/pages/sales/SalesOverviewPanel.tsx`) already existed before this
phase (built by the migration-67-era Sales Agent Builder work) and already lists/creates/edits
`client_sales_agents` rows directly, under Postgres RLS (`csa_admin_all`: `for all to authenticated
using (is_admin())`; `csa_client_read`: client users get read-only). That RLS policy set is
**untouched** by this phase. The only change on the Console side is additive: a `role` select field
on the create form and a role label on the card/detail view, because `role` is a new column this
phase adds. Console writes still go through `is_admin()`-gated Postgres RLS on the same
`client_sales_agents` table the Bot RPCs use — not through `can_access_client`, not through a Bot
credential, and not through any of the five new `mcp_internal.*`/`public.mcp_*` functions (which are
`revoke all from public, anon, authenticated` — a human/Console session literally cannot call them).
Two independent, pre-existing authorization paths over one shared table, exactly as Phase 9b/10
documented for their own human paths ("this phase adds a parallel Bot-safe path, it does not remove
or gate the human one") — this phase does not blur that line in either direction.

---

## Classification and Sec questions (SEC_BAR item 8, in full)

### MEDIUM + AA-RPC-only vs gateway reviewer gate, per new write

The gateway's own `approval` array (`["deploy", "record_sale", "record_decision"]`) forces a human-
reviewer queue on top of AA authorization, independent of what AA itself allows. None of the five
new factory tools are in it, and none of them started out there (unlike Phase 9b's
`content.approve_asset`, which was pulled off that array when it went real). Each lands at
`risk: "MEDIUM"` (the registry's default for a non-read, non-`generate_brief`, non-`approval` name),
`approval: false` — AA-RPC-only authorization. Per tool:

- **`generate_config`.** No table write besides the audit ledger; composes from the calling client's
  own `client_business_context`/`client_brand_profiles` rows only. Fully reversible (the caller can
  discard the draft or call it again) and cannot leak another client's intelligence, since the SQL
  join is scoped by `p_client_id` under the same grant check as every other RPC. **Recommendation:
  MEDIUM, AA-RPC-only** — a gateway reviewer gate here would be reviewing a read-shaped compose, not
  a decision.
- **`create`.** Inserts one `client_sales_agents` row with `status = 'draft'`. A draft agent has no
  visitor-facing effect (channel connect/deploy is separately gated, CRITICAL+approval, and not
  realized here) — it is inert until a human takes it live via Console or Eng deploys it. Reversible
  (the row can be retired). **Recommendation: MEDIUM, AA-RPC-only.**
- **`update_knowledge` / `update_qualification_rules`.** Both are field-scoped updates on an agent
  the Bot already owns via the client grant, both reversible (call again with different values), and
  neither can move an agent to `live` or touch a channel. Same posture as Phase 11's
  `pipeline.update_stage`/`create_followup`, which this note's predecessor settled at MEDIUM for
  comparable reasons (reversible, single already-granted client, cannot reach a
  revenue/deploy-adjacent state). **Recommendation: MEDIUM, AA-RPC-only** for both.
- **`test`.** Read-shaped in effect (no table write outside the ledger) and cannot reach a live
  channel by construction (§3). **Recommendation: MEDIUM, AA-RPC-only** — the same reasoning as
  `generate_config`.

Sec question, restated for this phase (same shape as Phase 11's own §9): is MEDIUM + AA-RPC-only
authorization still right for a Bot **drafting**, **persisting**, **editing** and **sandbox-testing**
a not-yet-live per-client agent, or should any of the five be pulled onto the gateway `approval`
array pending a trial period? This note's recommendation is MEDIUM for all five, unchanged, because
every one of them is reversible, scoped to a single already-granted client, and — critically —
`deploy` (the one step that would make a wrong factory output visible to a real visitor) stays
CRITICAL + approval + ungranted regardless of this answer. A wrong `generate_config` draft or a
wrong `update_knowledge` edit costs a re-run, not an incident, as long as `deploy` stays behind its
own gate.

### Does any other Bot's wildcard require a per-tool hard gate?

No. Grepping every migration's permission seed/grant statements (65 through 77) and
`src/policy/permissions.ts`'s `grants` matrix for `sales_agents` or `pipeline` on any Bot other than
`bot_sales_ops` returns nothing — no Bot has ever held either domain as a wildcard or an exact name.
That means the Phase 9b/10 situation this phase's Sec bar item explicitly asks about — *"`bot_X`
already holds `domain.*` for its other real tools, so a hard hand-coded deny in `allowed()` is the
only way to keep a name off it"* — does not exist here, exactly as Phase 11 found for
`pipeline.*`/`sales_agents.*` generally. The exact-allowlist ceiling in `allowed()`
(`bot_sales_ops`-only, §1) already fully constrains `bot_sales_ops` itself, and no other Bot has
anything that would match `sales_agents.generate_config` etc. for a gateway-level
`SALES_AGENT_FACTORY_ONLY_TOOLS`-style set (the `PRODUCTION_ONLY_TOOLS`/`DISTRIBUTION_ONLY_TOOLS`
pattern) to counteract. **So: no new gateway-level hard-per-tool-gate set is needed or added.** What
*is* added, matching Phase 9b/10/11's "hard-coded bot check where appropriate" bar and as defense in
depth independent of the grant matrix:
- A hard-coded `if p_bot_id <> 'bot_sales_ops' then raise 'bot_forbidden'` inside all five new RPCs
  (not just the two Phase 11 had) — protects the RPC layer if it is ever reached by something other
  than the gateway.
- `assert_cos_prohibitions()`'s existing pattern-based check (`permission_pattern like
  'sales_agents.%'` for any bot other than `bot_sales_ops`) already covers these five new names for
  free — it matches by domain prefix, not by an enumerated list, so it needed no edit to extend to
  this phase. What *did* need an edit is the bot_sales_ops-specific forbidden-name list one check
  below it: it dropped `create`/`update_knowledge`/`update_qualification_rules`/`test` (this phase
  legitimizes them) while keeping `deploy`/`record_sale`/`proof.*` forbidden.

---

## 1. Config schema and intel sources

`client_sales_agents` (migration 67) already carries the operating definition: `name`, `purpose`,
`status`, `greeting`, `system_prompt`, `qualification` (jsonb array), `objections` (jsonb array),
`booking_rule`, `escalation_rule`, `guardrails`. This phase adds one column, additively and
nullable (existing human-built agents are untouched):

- **`role`** — `text check (role in ('inbound_qualifier','appointment_setter','nurture',
  'reactivation','closer_assist'))`. Which execution surface this agent is, per the brief's
  five-role enum.

**`generate_config`'s intel sources — stated honestly.** The brief asks for "Market / Avatar / Offer
/ Brand / Campaign intel". What actually exists in this schema, scoped per client, is:

- `client_business_context` (migration 04) — one row per client: `main_offer` (offer),
  `ideal_customer` (avatar), `sales_process`, `brand_voice` (brand), `proof_testimonials`,
  `competitors` (a market signal, thin). This is the primary source.
- `client_brand_profiles.never_do` (migration 53) — an explicit list of things the brand will not
  say; seeds `guardrails` when present.

**Honest gap: no campaign-level join.** There is no table that carries campaign-scoped *messaging*
intelligence in a shape suited to composing a sales agent's opening line or objection list —
`campaigns` (migration 14/72) carries spend/targeting/execution state, not creative or positioning
intel. `generate_config` does not join it. This is a scope gap, not an oversight: the brief's Gate
11b success criteria only requires the tool to compose *something real* from *real* client
intelligence and persist nothing but an auditable draft — it does not require every named intel
category to be wired in this phase. If Sec or Alex wants campaign intel folded in, that is a
follow-up, separately reviewable change to this one RPC, not a blocker to Gate 11b.

**Why server-side, not a Marketing grant.** `generate_config` reads `client_business_context`/
`client_brand_profiles` directly inside the RPC (`security definer`, `search_path = mcp_internal,
public`) — it does not go through `content.*`/`campaign.*` MCP tools, so `bot_sales_ops` needs no
Marketing/Production write or read grant to run it (SEC_BAR item 4, brief §90). The Bot-facing
surface is exactly the five factory names; the intel join is an implementation detail of one RPC's
body, invisible to the permission matrix.

---

## 2. AA RPC mapping

| Tool | RPC | AA table(s) written | Ledger row? |
| --- | --- | --- | --- |
| `sales_agents.generate_config` | `mcp_internal.generate_sales_agent_config` | none (draft only) | yes — `mcp_sales_agent_requests` |
| `sales_agents.create` | `mcp_internal.create_sales_agent` | `client_sales_agents` (insert) | yes |
| `sales_agents.update_knowledge` | `mcp_internal.update_sales_agent_knowledge` | `client_sales_agents` (`objections`/`guardrails`/`greeting`) | yes |
| `sales_agents.update_qualification_rules` | `mcp_internal.update_sales_agent_qualification_rules` | `client_sales_agents` (`qualification`) | yes |
| `sales_agents.test` | `mcp_internal.test_sales_agent` | none (sandbox only) | yes |

**New ledger, not a reuse of `mcp_pipeline_requests`.** `mcp_internal.mcp_sales_agent_requests` is a
separate table — different domain, different resource column (`sales_agent_id`, nullable: two of
the five tools have no agent yet at call time) — but identical shape, RLS posture (`enable` +
`force` + `revoke all from public, anon, authenticated, service_role`), and replay helper
(`take_sales_agent_request`, a line-for-line mirror of `take_pipeline_request`).

**Auth shape.** Identical to every Phase 5/9b/10/11 Bot RPC: `require_active_bot` →
`require_bot_client_grant` → hard-coded `bot_sales_ops` check → `require_mcp_ids` → (for the three
resource-scoped tools) row lookup with `client_id` match before use → idempotency ledger check →
(for writes) the actual mutation → ledger insert.

**Data minimization on `test`.** The transcript the caller supplies is validated for shape and
length only; the RPC never persists it, never forwards it anywhere, and the response is a small
structured summary (turn count, whether qualification/guardrails are on file, a boolean escalation
heuristic), not an echo of the input.

---

## 3. Admin Sales page mapping

`src/pages/sales/SalesOverviewPanel.tsx` (already scaffolded from the migration-67-era Sales Agent
Builder) is the Admin → client → Sales page named in the brief. This phase's delta:

- List/select query gains `role`.
- The "Build Sales Agent" form gains a required `role` select (one of the five enum values).
- The card grid and the detail dialog show the role label.

Everything else — list, create (via direct `insert` + `enqueue_agent_job`, which triggers the
existing human/LLM-authored Sales Agent Builder job, unrelated to and unaffected by this phase's Bot
RPCs), status toggle (`draft`/`live`/`retired`), and the full read-only detail view — is unchanged.
The Console's create path and the Bot's `sales_agents.create` RPC both write the *same*
`client_sales_agents` table but are two independent authorization paths (RLS `is_admin()` vs.
`require_active_bot`+`require_bot_client_grant`) — an agent built by either path is visible to both,
by design, since there is only one store.

---

## 4. Isolation tests

See §Sec bar response item 7 above for the full enumeration. Summary: 10 new SQL-layer tests
(`isolation-rls.test.ts`), 5 new HTTP-route tests (`pipeline-route.test.ts`), 2 new + 2 rewritten
gateway-layer tests (`sales-ops.test.ts`), all green, alongside the full pre-existing suites:

- `aa-mcp-gateway`: **99/99** passing (was 97 total before this phase; the one previously-documented
  pre-existing `better-sqlite3` binding flake in `test/gateway.test.ts` is not present in this
  environment/run).
- `agent-runtime`: **449/449** passing (`vitest run`, full suite).
- Console (`src`, frontend): `SalesOverviewPanel.test.tsx` **17/17** passing (2 assertions extended
  for the new `role` field; no new test file needed for an additive display/form field).

`src/registry/tools.ts` only adds the five names to `realSalesAgents` in the same commit that adds
all of the above tests — isolation green before unstub, by construction.

---

## 5. Rollback plan if Sec rejects post-cutover

Additive-only migration, same shape as Phase 9b/10/11:

1. **Gateway (fast, no DB change):** remove the five names from `realSalesAgents` in
   `src/registry/tools.ts` (or redeploy the prior gateway image). All five instantly return
   `not_implemented`/are hidden from discovery again.
2. **RPC (defense in depth, optional):** widen the `bot_forbidden` hard-code in all five RPCs to
   unconditionally reject, or revoke `EXECUTE … TO service_role` on any subset, without dropping the
   functions or the migration.
3. **Permission rows (optional):** the five-row insert can be reverted to the pre-Phase-11b state
   (17 rows) by a follow-up migration; nothing in this phase requires that to happen for rollback to
   be safe, since the gateway-level lever (1) is sufficient on its own.
4. **No data to unwind:** any `create`/`update_knowledge`/`update_qualification_rules` writes already
   made by the Bot before rollback remain valid, audited state (same shape a human Console edit would
   produce, distinguishable by the absence of a `created_by` profile id and presence of the ledger
   row); rollback stops *new* Bot writes, it does not retroactively invalidate ones already recorded.
5. **Migration 77 itself is never reverted** — inert once the gateway stops calling it.

---

## Report back to CoS

1. **PR URL / SHA:** filled in after the draft PR is opened (this note ships in the same PR).
2. **Design note path:** `aa-mcp-gateway/docs/phase-11b-sales-agent-factory.md` (this file).
   **Onboarding config path:** `aa-mcp-gateway/src/onboarding/sales-ops.ts`.
3. **Migration #:** **77** (`supabase/migrations/20260910100000_77_mcp_sales_agent_factory.sql`),
   additive.
4. **Exact discovery tool list (final, 22):** `pipeline.list_leads`, `pipeline.get_lead`,
   `pipeline.get_stalled_leads`, `pipeline.get_pipeline_summary`, `pipeline.update_stage`,
   `pipeline.create_followup`, `sales_agents.list`, `sales_agents.get`,
   `sales_agents.get_conversations`, `sales_agents.generate_config`, `sales_agents.create`,
   `sales_agents.update_knowledge`, `sales_agents.update_qualification_rules`, `sales_agents.test`,
   `workflow.get_pending_approvals`, `workflow.get_activity`, `workflow.list_tasks`,
   `workflow.get_task`, `workflow.create_task`, `workflow.assign_task`, `workflow.complete_task`,
   `workflow.create_approval` — Phase 11's 17 + this phase's 5, no trims or additions, matching
   Alex CLEAR #2 exactly.
5. **Admin Sales page paths/screens touched:** `src/pages/sales/SalesOverviewPanel.tsx` (+
   `SalesOverviewPanel.test.tsx`) — additive `role` field on list/create/detail only.
6. **Test counts:** 2 new + 2 rewritten gateway unit (12 total in `sales-ops.test.ts`, 99/99 gateway
   suite passing); 10 new SQL isolation (`isolation-rls.test.ts`, 67/67 in that file, 449/449
   agent-runtime suite); 5 new HTTP route (`pipeline-route.test.ts`, 14/14 in that file); Console
   `SalesOverviewPanel.test.tsx` 17/17. Fixture assumption: Gate 11b's live Harbour run needs the
   same Harbour `lead_id`/`client_sales_agents.id` fixtures Gate 11 already documents
   (`SalesOpsFixtures`) — the factory gate (`runSalesAgentFactoryGate`) creates its own agent rather
   than requiring a second pre-existing one.
7. **Is channel connect stub-only?** Yes. `sales_agents.deploy` and all live Meta/WhatsApp/SMS
   OAuth, webhooks and inbound workers are out of scope for 11b, deferred to Phase 11c / Eng
   (Alex CLEAR #5). Nothing in this PR simulates or partially implements a channel connection.
8. **Sec questions / gaps:**
   - §Classification: confirm MEDIUM + AA-RPC-only authorization (no gateway reviewer gate) for all
     five factory writes, given none was ever on the gateway's HIGH/approval array.
   - §Classification: confirmed no other Bot wildcard requires a per-tool hard gate for these five
     names (none holds `sales_agents.*`/`pipeline.*` today, pattern-checked in `assert_cos_
     prohibitions()`).
   - `generate_config`'s intel scope is `client_business_context` + `client_brand_profiles.never_do`
     only — no campaign-level join in this phase (§1, honest gap, not an oversight).
   - `sales_agents.deploy`: confirmed deferred to Phase 11c/Eng per Alex CLEAR #5; this PR takes no
     position on when/whether Eng realizes it, only that it stays stub+ungranted for now.
   - No Eng bot (`bot_engineering`) grant is added or proposed in this PR — `bot_engineering` already
     exists in `permissions.ts`'s grant matrix with `engineering.*` only; extending it to
     `sales_agents.deploy` is an explicit, separate Alex CLEAR the brief does not authorize here.
9. **Ready for Sec: yes.** Design note, migration, gateway wiring, agent-runtime routes, Console UI
   delta, and all four test layers (gateway/SQL-isolation/HTTP-route/Console) are in this PR
   together, isolation green before the unstub, no merge/deploy/token/connector taken.

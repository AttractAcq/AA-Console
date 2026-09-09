# Phase 9b — Production Bot decide path (idea approve + asset approve)

Status: design locked for implementation; **Sec review required before merge/cutover**.
Base: main at `b58f4be`, on top of Phase 5/6 (migrations 63–70). No production apply or Railway
deploy from this change. The [Phase 3–4](phase-3-4-bot-auth-rls.md) and
[Phase 5](phase-5-production-manager.md) binding Sec rules remain binding **except** where this
note explicitly and narrowly lifts one: Bot decide on idea-approve and asset-approve, for
`bot_production` only.

## Alex CLEAR (2026-09-09)

Enable for **`bot_production` only**:

1. Bot-safe idea approve (durable AA path, realizing `content.select_idea`).
2. Real `content.approve_asset` for Production with full audit trail.

Hard requirements: Sec design note + isolation tests **before** any merge/cutover. No
`workflow.record_decision`. No SQL from Bots. Do **not** grant these to Marketing / CoS / CDM /
others. Do not modify live Production/CDM/CoS connectors until post-Sec cutover.

This is a narrow, explicit, Sec-reviewable exception to the Phase 5/6 posture ("Forbidden: Bot
`review_media_asset`, `content.approve_asset` as a decision") — it does not reopen that posture
for any other Bot or tool.

---

## 1. Classification matrix (after this change)

| Class | Action | Scope | Notes |
| --- | --- | --- | --- |
| Autonomous (new) | `content.select_idea` (idea approve) | `bot_production`, granted client, `draft` idea only | Sets `client_ideas.status = 'approved'`. Does not generate a brief. |
| Autonomous (new) | `content.approve_asset` (asset decide: approve or reject) | `bot_production`, granted client, `pending` asset only | Writes `client_media_assets.review_status` + `client_asset_reviews`, attributed to the Bot. |
| Autonomous (unchanged) | `list_ideas`, `get_idea`, `generate_brief`, `get_brief`, `get_production_status`, `request_revision`, `request_approval`, `create_repurpose_plan` | Granted client only | Phase 5/6 contract unchanged. `create_repurpose_plan` already required only `review_status = 'approved'`, so a Bot-approved asset is repurposable without further changes. |
| Human-required (unchanged) | Console `review_media_asset` for every other Bot/client; `approvals_queue` / Approve & Build for anything not covered by rule 2 above | All clients not explicitly Bot-decided | Console remains fully authoritative and can still decide (or re-decide) any asset, including one a Bot already decided (see §3). |
| Human-required (unchanged) | Phase 6 `content.request_approval` → human Console review → `content.create_repurpose_plan` (resume) wait/continuation path | All Bots including `bot_production` | This durable-wait pipeline is untouched. `mcp_internal.resume_approval` still requires `client_asset_reviews.reviewed_by is not null` (human evidence). A Bot self-approval does not satisfy that specific gate — see §3. |
| Forbidden (unchanged) | `workflow.record_decision` | All Bots | Hard-denied in gateway code forever (`allowed()`), independent of any DB grant. |
| Forbidden (unchanged) | Bot SQL access | All Bots | Gateway has no Postgres client; all AA access is `SECURITY DEFINER` RPC over the internal HTTP hop. Unchanged. |
| Forbidden (new, explicit) | `content.select_idea`, `content.approve_asset` for any Bot other than `bot_production` | Marketing, CoS, Client Delivery, Distribution, Sales Ops, Admin, Finance, Engineering, Security | Hard-coded deny in gateway `allowed()` **and** a hard-coded `p_bot_id <> 'bot_production'` check inside both new AA RPCs. Not expressed through the permission-grant matrix (see §4) because `bot_marketing` already holds `content.*` and must keep it for its other real content reads/writes. |
| Out of scope / stub (unchanged) | `content.generate_ideas`, `content.assign_production`, `content.submit_asset`, `content.queue_distribution`, `content.get_performance` | — | Not touched by this phase. |

---

## 2. Idea approve: `content.select_idea`

**Naming choice.** We realize the existing `content.select_idea` contract rather than mint a new
`content.approve_idea` name. `select_idea` is already a catalogued, discoverable tool name
(`tool-registry.md`, `src/registry/tools.ts`) with a reserved MEDIUM-risk write shape; reusing it
avoids a second name for the same concept and keeps every existing reference (docs, permission
matrix, `MCP_DISCOVER_STUBS` output) pointed at one contract. Its behavior is "approve the idea",
not merely "select" — the tool `description` string is updated accordingly. Renaming the wire name
itself is out of scope; nothing currently depends on the stub shape changing.

**AA table:** `client_ideas` (migration 05). No new table.

**RPC:** `mcp_internal.approve_idea(p_bot_id, p_request_id, p_execution_id, p_client_id,
p_idea_id)` → `public.mcp_approve_idea` wrapper. Same posture as every Phase 5 write RPC:
`require_active_bot` then `require_bot_client_grant` (never `can_access_client`), resource
`client_id` must match the granted client (`client_mismatch` otherwise), `REVOKE ALL` from
`public`/`anon`/`authenticated`, `GRANT EXECUTE` to `service_role` only.

**Bot restriction.** In addition to the grant/client checks, the RPC hard-codes
`if p_bot_id <> 'bot_production' then raise 'bot_forbidden'`. This is deliberate and mirrors the
existing `workflow.record_decision` code-level hard-deny: it holds even if a future migration or
CoS row accidentally grants an exact-name `content.select_idea` permission to another Bot, and even
if the gateway's own `allowed()` check were bypassed. The migration also asserts no
`mcp_bot_permissions` row grants `content.select_idea` (or `content.approve_asset`) by exact name to
a Bot other than `bot_production`; that assertion cannot see through `bot_marketing`'s pre-existing
`content.*` wildcard, which is why the two hard-coded checks (gateway + RPC), not the permission
matrix, are the real control (see §4).

**Idempotency.** Same ledger as every Phase 5/6 Bot content write: `mcp_internal.mcp_content_requests`,
keyed `(bot_id, execution_id)`, via the existing `take_content_request` helper. The `tool` check
constraint on that table is extended (additively) to allow `'content.select_idea'` and
`'content.approve_asset'` alongside the three Phase 5 values.

**Who may call.** `bot_production` only, for a client on its `mcp_bot_clients` allowlist, discovered
and callable per the standard `allowed()` grant match (`content.*`) plus the new hard per-tool gate.

**State transition and audit fields.** `draft → approved`. `rejected` idea → `invalid_idea_status`
(a Bot cannot un-reject; that stays a human/Console decision, unchanged). Already `approved` or
`briefed` → idempotent no-op returning current status (mirrors `request_approval`'s
`already_approved` no-op pattern) rather than an error, since the desired end state already holds.
The write inserts one `mcp_content_requests` row with `tool = 'content.select_idea'`, so it appears
in `content.get_production_status.actions` for that idea/brief exactly like every other Phase 5/6
Bot action — no separate audit surface.

**Interaction with `generate_brief`.** Deliberately decoupled, which is the point of this phase
(Console's "approve idea" currently forces a brief; Alex needs to "just approve"). `select_idea`
only flips the status column. `content.generate_brief` (already real, unchanged) already requires
`client_ideas.status = 'approved'` before it will enqueue (`enqueue_mcp_brief`, migration 66) — so
the two compose with **zero changes** to `generate_brief` or its RPC. Bot flow becomes
`content.select_idea(idea_id)` → `content.generate_brief(idea_id)`, each an explicit, separately
audited call.

---

## 3. Asset approve: `content.approve_asset`

**Single ledger, no dual write.** The Bot decision writes to the **same two tables** Console's
`review_media_asset` writes: `client_media_assets.review_status` and `client_asset_reviews`. No new
decision table is introduced. `client_asset_reviews` gains one additive, nullable column,
`reviewed_by_bot text references mcp_internal.mcp_bots(bot_id)`, so every review row carries exactly
one attribution source — a human (`reviewed_by`) or a Bot (`reviewed_by_bot`), never a second ledger
to reconcile. A `check (reviewed_by is null or reviewed_by_bot is null)` constraint prevents a row
from claiming both; it deliberately does **not** require exactly one to be non-null, because
`reviewed_by` already has `on delete set null` against `profiles` — a stricter "exactly one" check
would fail retroactively if a reviewer's profile is later deleted, breaking that existing cascade.
`approvals_queue` (`where review_status = 'pending'`) and the Employee `work_submissions` view need
no changes: a Bot-approved or Bot-rejected asset simply leaves `pending` and drops out of the queue,
exactly as a human decision does today.

**No dual-write race.** The Bot RPC takes `select ... for update` on the `client_media_assets` row
before checking status, closing the same-instant race between two Bot calls. Console's
`review_media_asset` is intentionally left as-is (no lock added, no new precondition) — Console can
still decide, or override, any asset at any time, including one a Bot already decided. That asymmetry
is deliberate: humans can always override a Bot; the reverse is not true because the Bot RPC only
accepts a `pending` asset (`invalid_asset_status` otherwise). A Bot cannot flip an asset a human — or
the Bot itself, on an earlier call — has already decided; a human can always revisit a Bot's decision
through the unchanged Console path.

**Relationship to the Phase 6 approval-wait pipeline.** `content.request_approval` →
Console review → `content.create_repurpose_plan`/`mcp_internal.resume_approval` is untouched.
`resume_approval` still gates on `client_asset_reviews.reviewed_by is not null` (i.e., specifically
*human* review evidence) before it will treat a wait as resolved — a Bot's own
`reviewed_by_bot` row does not satisfy that gate, by construction, since `reviewed_by` stays null on
a Bot decision. This is intentional: the durable human-wait/continuation ledger keeps meaning
"a human decided" exactly as Phase 6 designed it. What changes is that `bot_production` now has a
**second, direct** path that does not go through `request_approval`/Console at all:
`content.approve_asset` decides the asset immediately, and `content.create_repurpose_plan` already
only checks `review_status = 'approved'` (migration 68) — it does not check who approved it — so a
Bot-approved asset is repurposable immediately with no further change. A Bot that already called
`content.approve_asset` should not also call `content.request_approval` for the same asset expecting
a *different* outcome; both are legitimate, independent entry points into the same one-ledger state.

**RPC:** `mcp_internal.approve_asset(p_bot_id, p_request_id, p_execution_id, p_client_id,
p_asset_id, p_decision, p_reason default null)` → `public.mcp_approve_asset` wrapper. Same
`require_active_bot` + `require_bot_client_grant` + resource `client_id` match posture as every
other Phase 5 write. `p_decision` is `'approved' | 'rejected'`; anything else is `invalid_request`.
`p_reason` is optional, ≤4000 chars, stored on `client_asset_reviews.reason` exactly like a human
reason. Asset must currently be `pending` (`invalid_asset_status` otherwise); an unknown asset is
`asset_not_found`; a different client's asset is `client_mismatch`.

**Bot restriction:** identical hard-coded `p_bot_id <> 'bot_production' → bot_forbidden` check as
`approve_idea`. Same rationale.

**Full audit trail:** every decision is captured three ways — the `client_asset_reviews` row
(`reviewed_by_bot`, `decision`, `reason`, `created_at`), the `mcp_content_requests` ledger row
(`tool = 'content.approve_asset'`, full payload, idempotent replay), and the gateway's own request
audit log (`Store.audit`, unchanged Phase 3 mechanism, `request_id`/`execution_id`/`bot`/`client_id`/
`authorization`/`execution_result`). No free-text payload is ever written to a table the Bot did not
already have write access to.

**Gateway risk/approval classification — a decision Sec should confirm.** `content.approve_asset`
was previously in the gateway's own generic HIGH-risk `approval` list (`src/registry/tools.ts`),
which forces every call through the gateway's separate reviewer-approval queue
(`ActionEngine.call` → `approval_required` → a human with `REVIEWER_CREDENTIALS_JSON` must call
`decide()` before the AA RPC ever runs) — on top of, and unrelated to, AA's own authorization. Since
that tool was a stub until now, this generic gate was never actually exercised for it. Making the
tool real while leaving it in that list would mean the Bot still cannot "just decide" — a human
would have to click approve at the gateway for every single asset, which defeats the purpose of this
CLEAR ("Console UI couples 'approve idea' with generate — Alex cannot 'just approve'" is exactly the
friction being removed). We therefore **removed** `approve_asset` from that array, matching its
sibling Bot content writes (`request_revision`, `request_approval`, `create_repurpose_plan`), which
sit at **MEDIUM** risk and rely on AA RPC authorization (active bot + client grant + hard
`bot_production`-only check) rather than a second gateway-level human click. `select_idea` was never
in that list and is unaffected. **Sec question:** is MEDIUM + AA-RPC-only authorization (no gateway
reviewer gate) the right posture for `content.approve_asset`, or should the gateway reviewer gate be
restored (fully defeating Bot autonomy on this tool) pending a longer trial period? Either is a
one-line change in `src/registry/tools.ts` (`approval` array) and does not touch the AA RPC or its
isolation tests.

---

## 4. Auth

Both new RPCs follow the Phase 3–5 pattern exactly:

- `mcp_internal.require_active_bot(p_bot_id)` — active-bot check, `service_role` only.
- `mcp_internal.require_bot_client_grant(p_bot_id, p_client_id)` — `mcp_bot_clients` membership,
  `FOR SHARE`, never `can_access_client`. Both RPCs are declared without `stable`/`immutable`
  (plpgsql default `volatile`), consistent with every other Phase 5/6 **write** RPC — only the Phase
  5 **read** RPCs needed the explicit `volatile` override (PostgREST otherwise runs `stable` RPCs
  read-only, which rejects `FOR SHARE`); writes are volatile by default and this migration does not
  change that pattern.
- Resource `client_id` match: loaded `FOR UPDATE`, checked against `p_client_id` before any write;
  mismatch is `client_mismatch`, raised before the row is used.
- `REVOKE ALL … FROM public, anon, authenticated; GRANT EXECUTE … TO service_role` on both the
  `mcp_internal` RPC and the `public` wrapper.
- **New, additive to this phase:** a hard-coded `p_bot_id <> 'bot_production'` check inside both
  RPCs (`bot_forbidden`), independent of the grant matrix. This is the mechanism that keeps the
  capability off `bot_marketing`/`bot_chief_of_staff`/`bot_client_delivery` even though
  `bot_marketing` already holds a `content.*` wildcard grant it must keep for its other real content
  tools. The gateway mirrors this with a hard-coded check in `allowed()` (§5), so the deny happens
  **before** AA is ever called, matching the existing "gateway deny-before-AA" posture for
  `workflow.record_decision`.
- No SQL from Bots: unchanged — the gateway has no Postgres client of its own; both new tools go
  through the same `AA_INTERNAL_API_URL` + `AA_MCP_SERVICE_SECRET` HTTP hop as every other content
  RPC, terminating in a `SECURITY DEFINER` function.

---

## 5. Marketing / CoS / CDM stay denied — explicit

- `bot_marketing`'s permission-matrix grant is **unchanged**: it keeps `content.*`, because it still
  needs `content.list_ideas`, `content.get_idea`, `content.generate_brief`, `content.get_brief`,
  `content.get_production_status`, `content.request_revision`, `content.request_approval`,
  `content.create_repurpose_plan` — all real, all unaffected by this phase.
- What is new: `src/policy/permissions.ts` `allowed()` gains a hard, non-grant-based deny —
  `content.select_idea` and `content.approve_asset` return `false` for any `identity.bot !==
  "bot_production"`, evaluated **before** the normal grant-pattern match, exactly like the existing
  `workflow.record_decision` line. A future PR that wants to extend either tool to another Bot must
  touch this line explicitly and go through Sec again; it cannot happen by adding a permission row.
- `bot_chief_of_staff` and `bot_client_delivery` never had `content.*` or either exact tool name and
  are unaffected either way; this note calls them out because Alex's CLEAR named them explicitly.
- No change to `mcp_bot_permissions` seed rows. Migration 74 asserts (informationally, see §2) that
  no future exact-name grant row targets these two tools outside `bot_production`; it explicitly
  does not, and cannot, prevent `bot_marketing`'s wildcard from *matching* the tool name — the
  hard-coded gateway + RPC checks are what actually enforces the boundary, and are the load-bearing
  control Sec should review.

---

## 6. Isolation tests plan

Both the SQL-layer (`agent-runtime/src/mcp/isolation-rls.test.ts`, RLS-enabled PGlite) and the
HTTP-layer (`agent-runtime/src/mcp/content-route.test.ts`) suites gain a Phase 9b block covering, for
both `approve_idea` and `approve_asset`:

1. **Same-client success** — `bot_production` approves an idea/asset on its granted client;
   state transitions as documented; ledger row inserted; response echoes `client_id`.
2. **Cross-client id** (`client_id` not on `mcp_bot_clients` for this Bot) — `client_forbidden`,
   checked before any row lookup.
3. **Cross-client resource** (granted `client_id`, but the idea/asset belongs to another client) —
   `client_mismatch`, no write.
4. **Revoked grant** — delete the `mcp_bot_clients` row, replay is `client_forbidden`.
5. **Suspended bot** — `mcp_bots.status = 'suspended'`, `bot_not_active`, even with a live grant row.
6. **`anon` / `authenticated` cannot execute** — both `public.mcp_approve_idea` and
   `public.mcp_approve_asset` (and their `mcp_internal` counterparts) reject with Postgres
   `permission denied`, matching the Phase 5/6 pattern.
7. **`bot_forbidden` for every non-production Bot** — `bot_marketing` (which has `content.*`) is
   denied at the RPC layer even with an active status and a valid client grant, proving the hard
   check does not depend on the permission matrix.
8. **Idempotent replay** — same `(bot_id, execution_id)` returns the cached ledger result
   (`replayed: true`); a different payload under the same key is `idempotency_conflict`.
9. **State-guard correctness** — `select_idea` on a `rejected` idea is `invalid_idea_status`;
   on an already-`approved`/`briefed` idea is a no-op (not an error). `approve_asset` on a
   non-`pending` asset is `invalid_asset_status`; on an unknown asset is `asset_not_found`.
10. **Composition with existing tools** — after `select_idea`, `content.generate_brief` succeeds
    with no other change; after `approve_asset`, `content.create_repurpose_plan` succeeds without
    going through `request_approval`/human review, and `resume_approval` (the Phase 6 human-wait
    path) is unaffected/still requires human evidence for its own resource.
11. **Human override still works** — Console `review_media_asset` can still decide (or reverse) an
    asset the Bot already decided; `client_asset_reviews` shows both rows with correct attribution.
12. **Source assertions** — every new RPC's `pg_get_functiondef` contains `require_active_bot` and
    `require_bot_client_grant`, never `can_access_client`, never `review_media_asset`, and contains
    the `bot_forbidden` literal.
13. **Gateway deny-before-AA** — `production-manager.test.ts` gets a case proving a non-production
    identity (including one with a synthetic wildcard `content.*` permission set, matching the
    existing Phase 6 test pattern) is rejected with zero adapter hits for both new tool names, and
    that `bot_production` + other-client is `"Client scope denied."` before AA, matching every other
    real content tool.

A tool is only added to `realContent` in `src/registry/tools.ts` once all of the above are green —
same bar as Sec Phase 5 requirement 6.

---

## 7. Rollback plan if Sec rejects post-cutover

Additive-only migration, no destructive step required to roll back:

1. **Gateway (fast, no DB change):** move `content.select_idea` and `content.approve_asset` back out
   of `realContent` in `src/registry/tools.ts` (or simply redeploy the prior gateway image/commit).
   Both tools instantly return `not_implemented`/are hidden from discovery again, restoring the exact
   Phase 5/6 posture. This is the fastest lever and does not touch the database at all.
2. **RPC (defense in depth, optional):** the `bot_forbidden` hard-code can be widened to
   unconditionally reject (`raise exception 'bot_forbidden'` regardless of `p_bot_id`), or the
   `GRANT EXECUTE … TO service_role` can be revoked, without dropping the function or the migration.
3. **No data to unwind:** any asset/idea decisions already made by the Bot before rollback remain
   valid, audited decisions (same ledger a human decision would produce) — rollback stops *new* Bot
   decisions, it does not and should not retroactively invalidate ones already recorded, since that
   would itself be an unaudited, unattributed state change. If a specific decision needs reversal,
   Console `review_media_asset` already does that today for any asset, Bot-decided or not (§3).
   For an idea, there is no "un-approve" RPC today for either human or Bot paths; that gap is
   pre-existing and out of scope here.
4. **Migration 74 itself is never reverted** — the added column, check-constraint widening, and new
   functions are inert (unused) once the gateway stops calling them, exactly like every other
   "additive, not applied to production without Alex" migration in this repo.

---

## Sec questions (also flagged inline above)

1. §3: is MEDIUM risk + AA-RPC-only authorization (no gateway reviewer gate) acceptable for
   `content.approve_asset`, or should the gateway's own HIGH-risk reviewer-approval gate be kept
   (which would require a human to click approve at the gateway for every Bot decision, in addition
   to AA authorization — effectively still blocking Bot autonomy on this tool until a later phase)?
2. §3: confirm the asymmetry (human Console can always override any asset, including Bot-decided
   ones; Bot can only decide a currently-`pending` asset, never override) is the intended shape, not
   a gap.
3. §5: confirm hard-coding `bot_production` inside the two new RPCs (rather than only in the
   gateway) is the right belt-and-suspenders layer, and that it doesn't need to also be expressed as
   a `mcp_bot_permissions` CoS-guard trigger (like `assert_cos_prohibitions`) for defense in depth
   against a future direct-RPC caller that isn't the gateway.

Ping Sec on the PR before merge, as required by Sec Phase 5 requirement 1 and repeated by this
phase's CLEAR. No merge, Railway deploy, or production migration apply without Alex via CoS after
Sec APPROVE.

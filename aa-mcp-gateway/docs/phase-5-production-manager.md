# Phase 5: Production Manager v1

**Status:** Implementation PR. **Do not apply migration 68 to production without Alex approval. Do not deploy to Railway from this PR.**

**Audience:** Security and Engineering. **Ping Sec on this PR (and every later content RPC/policy PR) before merge.**

**Depends on:** Phase 3–4 Bot auth / RLS ([phase-3-4-bot-auth-rls.md](./phase-3-4-bot-auth-rls.md), [phase-4-rls-isolation.md](./phase-4-rls-isolation.md)). Locked Sec decisions in those notes stay locked. Do not weaken Phase 3–4 auth/RLS.

---

## Sec Phase 5 requirements (binding)

These six rules are **binding** for this PR and for every later content RPC, policy, or adapter PR. Do not soften, treat as optional, or re-open Phase 3–4 to bypass them.

1. **Ping Sec on each new content RPC/policy PR before merge.** This PR is that ping for migration 68. A follow-on that adds or changes a Bot content RPC, RLS policy, or `mcp_bot_permissions` row must ping Sec again before merge.
2. **New content RPCs MUST use `require_bot_client_grant` + active bot helpers.** Every Phase 5 Bot RPC calls `mcp_internal.require_active_bot` and `mcp_internal.require_bot_client_grant` (the grant helper also calls `require_service_role` + `require_active_bot` and `FOR SHARE`s `mcp_bot_clients`). Do not invent a third client-scope path.
3. **Never use `can_access_client` on Bot paths.** That function is human Console membership (`auth.uid()` / assignments). Mixing it in would grant a Bot every client any assigned employee can see. Human RPCs (`enqueue_agent_job`, `review_media_asset`, `repurpose_asset`, …) stay on `can_access_client`.
4. **Resource `client_id` must match the granted client (no cross-client).** Grant check runs **before** lookup (`client_forbidden` if the `client_id` is not on `mcp_bot_clients`). Loaded idea/brief/asset rows must have `resource.client_id = p_client_id` or `client_mismatch`. List endpoints filter `where client_id = p_client_id` only.
5. **Gateway permission checks remain.** `BOT_AUTH_MODE=db` uses AA permissions (`mcp_bot_permissions` via resolve). The Action Engine still requires `input.client_id ∈ identity.clients` before AA. `workflow.record_decision` stays **hard-denied in gateway code forever**, even if a DB row or `workflow.*` grant exists.
6. **Isolation tests required before treating a tool as non-stub.** Do not add a name to the gateway `realContent` set, and do not ship a real AA adapter, until the matching RPC has same-client / other-client-id / other-client-resource / revoked-grant / suspended-bot / `anon`+`authenticated` execute-denied cases green on an RLS-enabled database (see §7 and `agent-runtime/src/mcp/isolation-rls.test.ts`).

---

Phase 6 formalizes durable waits and linked continuation: [approval engine](phase-6-approval-engine.md). Human decision boundaries above remain binding.

## 1. Goal

Give Production Manager (`bot_production`) **implemented** MCP tools so it can take one **already-approved** idea through to **ready for distribution** without opening AA Console. Platform Gates 1–4 are closed. Auth on production is `BOT_AUTH_MODE=db`.

Gate 5 success path:

```
approved idea
  → content.list_ideas / content.get_idea
  → content.generate_brief          (already live; unchanged)
  → content.get_brief
  → content.get_production_status
  → content.request_revision        (only if the brief/asset needs rework)
  → content.request_approval        (submit for human Console review — Bot does not decide)
  → content.create_repurpose_plan   (approved asset only)
  → distribution handoff status     (output only; Distribution Manager is out of scope)
```

`workflow.get_pending_approvals` and `workflow.get_activity` stay the gateway control-plane tools they already are. Use them to inspect gateway receipts and any informational `workflow.create_approval` tickets. They are **not** the AA Console `approvals_queue`.

---

## 2. Non-goals / hard constraints

- Do not weaken Phase 3–4 auth/RLS. `BOT_AUTH_MODE=db`, `mcp_internal` / `mcp_bot_*`, `mcp_bot_clients`, no cross-client leaks. Binding rules: **Sec Phase 5 requirements** above.
- `workflow.record_decision` remains hard-denied in gateway code forever.
- No external connectors. No new provider integrations.
- Do not expand other Bots’ live tokens or mint tokens for other Bots.
- Reviewers stay on `REVIEWER_CREDENTIALS_JSON`.
- Do not treat stubs as real. `content.generate_ideas`, `content.select_idea`, `content.assign_production`, `content.submit_asset`, `content.approve_asset`, `content.queue_distribution`, `content.get_performance` stay stubs.
- `content.approve_asset` stays HIGH + mandatory human approval + stub. Bots never call `review_media_asset`.
- Do not apply this migration to production without Alex. This document is not an apply runbook.
- Do not deploy the gateway or agent-runtime to Railway from this change.

---

## 3. Tool contracts

All calls still require `client_id` (UUID on the Bot’s `mcp_bot_clients` allowlist). Writes still require `idempotency_key` (gateway receipt) **and** AA durable `(bot_id, execution_id)` for the three new writes. Gateway never holds `service_role`. AA never sees Bot Bearer plaintext.

| Tool | Impl | HTTP | AA RPC | Result `status` |
| --- | --- | --- | --- | --- |
| `content.list_ideas` | real | `POST /internal/mcp/content/list-ideas` | `mcp_list_ideas` | `completed` |
| `content.get_idea` | real | `POST /internal/mcp/content/get-idea` | `mcp_get_idea` | `completed` |
| `content.generate_brief` | real (unchanged) | `POST /internal/mcp/content/generate-brief` | `enqueue_mcp_brief` | `accepted` |
| `content.get_brief` | real | `POST /internal/mcp/content/get-brief` | `mcp_get_brief` | `completed` |
| `content.request_revision` | real | `POST /internal/mcp/content/request-revision` | `mcp_request_revision` | `completed` |
| `content.get_production_status` | real | `POST /internal/mcp/content/get-production-status` | `mcp_get_production_status` | `completed` |
| `content.create_repurpose_plan` | real | `POST /internal/mcp/content/create-repurpose-plan` | `mcp_create_repurpose_plan` | `accepted` |
| `content.request_approval` | real | `POST /internal/mcp/content/request-approval` | `mcp_request_approval` | `completed` |

Headers (same as brief): service Bearer, `x-aa-bot-id`, `x-request-id`, `idempotency-key`, `content-type: application/json`.

### 3.1 `content.list_ideas`

**Input:** `client_id` (required), `limit` (1–100, default 25), `status?` (`draft` \| `approved` \| `rejected` \| `briefed`).

**Output `data`:** `{ client_id, ideas: [...], count }`. Each idea: `id`, `client_id`, `title`, `source`, `status`, `media_type`, `content_territory`, `strategic_reason` (clipped), `created_at`, `updated_at`, `job_id`, `proof_id`. List omits `body`.

**AA:** `client_ideas` for that `client_id` only, newest first.

### 3.2 `content.get_idea`

**Input:** `client_id`, `idea_id` (required).

**Output `data`:** idea fields including clipped `body` / `source_question` plus `body_truncated`. `client_mismatch` if the idea belongs to another client.

### 3.3 `content.generate_brief`

Unchanged. Approved idea only. Queues `brief` via `enqueue_mcp_brief`. Gateway `accepted` + `{ job_id, client_id }`. HTTP 202 first execution, 200 AA replay.

### 3.4 `content.get_brief`

**Input:** `client_id` and **at least one of** `brief_id` or `idea_id`. `idea_id` loads the original brief (`repurpose_format is null`).

**Output `data`:** structured Brief Studio fields (hook, premise, argument, proof, script, visual_direction, shot_requirements, b_roll, call_to_action, channel_intent, production_method, brief_ref, status, media_type, source_idea_id, job_id, derived_from_asset_id, repurpose_format) plus clipped `body`. `brief_not_found` if none.

### 3.5 `content.request_revision`

**Input:** `client_id`, `idempotency_key`, `summary` (required reason, 1–4000), and at least one of `idea_id` / `brief_id` / `asset_id`.

**AA effect (not a human reject):**

- Resolve the original brief and/or pending asset. Cross-client resource → `client_mismatch`.
- Brief in `draft` \| `approved` \| `in_production` \| `rejected` → set brief `status = draft` (rework). `complete` → `invalid_brief_status`.
- Asset `pending` \| `rejected` → keep/set `pending`. **Approved assets are not silently un-approved** (`invalid_asset_status`). Human `review_media_asset` remains the only approval decision.
- Durable row in `mcp_internal.mcp_content_requests`. Replay returns the same result.

Does **not** insert a `client_asset_reviews` decision (that table is human review).

### 3.6 `content.get_production_status`

**Input:** `client_id` and at least one of `idea_id` / `brief_id` / `asset_id`.

**Output `data`:** idea + brief + latest brief `agent_jobs` row + assets + optional `creative_generations` / `brief_dispatches` / `job_assignments` (when those tables exist) + latest Phase 5 content-request actions + a **handoff** object:

| `handoff.ready_for_distribution` | When |
| --- | --- |
| `true` | Original brief has at least one **approved** `client_media_assets` row and no open revision on that brief |
| `false` | Anything else |

`handoff.blocked_on` is one of: `idea_not_briefed`, `brief_missing`, `brief_needs_revision`, `awaiting_production`, `awaiting_asset_approval`, `asset_rejected`, `null`.

`handoff.next` names the next Production Manager tool, or states that `content.queue_distribution` is a Distribution Manager stub.

### 3.7 `content.create_repurpose_plan`

**Input:** `client_id`, `idempotency_key`, `asset_id` (required), `formats` (1–6 of `reel`, `short`, `carousel`, `quote_graphic`, `text_post`, `email`, `ad_variation`, `story_clips`).

**AA effect:** Bot-scoped clone of human `repurpose_asset`. Asset must be **approved** and owned by `client_id`. Queues `repurpose` via `enqueue_agent_job_internal` with `created_by` null and attribution params (`source=aa-mcp-gateway`, bot/request/execution ids). Does **not** use `can_access_client`. Unknown formats → `invalid_formats`. Gateway `accepted` + `{ job_id, client_id, asset_id, formats }`. HTTP 202 / 200 replay.

A repurpose still writes **derivative briefs**, not finished files.

### 3.8 `content.request_approval`

**Input:** `client_id`, `idempotency_key`, at least one of `idea_id` / `brief_id` / `asset_id`, optional `summary`.

**AA effect — request, never decide:**

- If a matching **asset** is `pending`: record submission toward Console `approvals_queue` (already `pending`; no status change).
- Asset `approved`: return current state (`already_approved`).
- Asset `rejected`: `invalid_asset_status` (revise first).
- Brief `draft` with no asset yet: set brief `status = approved` so it is ready for human Approve & Build. This is **not** `content.approve_asset` and **not** `review_media_asset`.
- Brief already `approved` / `in_production` / `complete`: record no-op current state.
- Brief `rejected`: `invalid_brief_status`.

Does not call the gateway reviewer API. Does not execute `workflow.record_decision`. Optional companion: the Bot may still call `workflow.create_approval` for an informational gateway ticket; that path is unchanged.

---

## 4. AA data sources

| Tool | Tables / workers | Human RPC reused as pattern (not called by the Bot) |
| --- | --- | --- |
| list/get idea | `client_ideas` | Console Generation tab |
| generate_brief | `enqueue_mcp_brief` → `agent_jobs` (`brief`) → `client_briefs` | `approve_idea_and_generate_brief` |
| get_brief | `client_briefs` (migration 55 fields; 56 repurpose columns) | Brief Studio |
| production status | ideas, briefs, `agent_jobs`, `client_media_assets`, `client_asset_reviews`, `job_assignments`; optional `creative_generations`, `brief_dispatches` | Approve & Build |
| request_revision | brief status + `mcp_content_requests` | none (new Bot-only) |
| request_approval | brief status and/or pending assets + ledger | Console Approvals (`review_media_asset` stays human) |
| create_repurpose_plan | `client_media_assets`, `agent_jobs` (`repurpose`) | `repurpose_asset` |

Gateway still has **no Postgres**. All domain access is `SECURITY DEFINER` RPCs over the existing private hop (`AA_INTERNAL_API_URL` + `AA_MCP_SERVICE_SECRET`).

---

## 5. Auth / client-scope rules

Implements **Sec Phase 5 requirements 2–5** with the same posture as `enqueue_mcp_brief` (Phase 4 helpers):

1. HTTP authenticates the **service** secret (timing-safe). Uniform fail on missing/duplicate `Authorization`.
2. `x-aa-bot-id` must match `^bot_[a-z0-9_]{1,60}$`. New content routes do **not** hard-code `bot_production` (brief enqueue still does, unchanged). Active-bot is enforced in SQL (`mcp_internal.require_active_bot`) on every Phase 5 RPC **and** inside `require_bot_client_grant`.
3. Every RPC: `mcp_internal.require_active_bot(p_bot_id)` then `mcp_internal.require_bot_client_grant(p_bot_id, p_client_id)` (`FOR SHARE` on `mcp_bot_clients`). Public wrappers also `require_service_role()`. **Never** `can_access_client` (requirement 3). Phase 5 read RPCs (`list_ideas` / `get_idea` / `get_brief` / `get_production_status` and their `public.mcp_*` wrappers) must be **VOLATILE** because the grant helper uses `FOR SHARE` (PostgREST runs STABLE RPCs in a read-only transaction).
4. Resource load `FOR SHARE` / `FOR UPDATE`; `resource.client_id = p_client_id` or `client_mismatch` (requirement 4). Grant check runs **before** lookup so ungranted `client_id` is `client_forbidden` even if the resource exists elsewhere.
5. `REVOKE ALL` from `public` / `anon` / `authenticated`; `GRANT EXECUTE` to `service_role` only.
6. Gateway Action Engine still requires `input.client_id ∈ identity.clients` **before** AA (requirement 5). DB grants (`content.*` for `bot_production`) are authoritative in `db` mode. Code hard-deny for `workflow.record_decision` unchanged.
7. Permission seed: **no new `mcp_bot_permissions` rows.** `bot_production` already has `content.*`, which matches every Phase 5 tool (single-segment wildcard). Migration 68 **asserts** that grant still exists and re-runs CoS prohibitions. Other Bots that already had `content.get_brief` / `content.get_production_status` (`bot_distribution`, `bot_client_delivery`, `bot_marketing`) can call those reads **if they already have a token and client grant**. This PR does not mint or expand tokens.
8. Reviewers remain env-only. No Bot credential can hit `/admin/approvals`.

### Error codes (AA HTTP)

Existing brief codes unchanged. Added:

| Code | HTTP | When |
| --- | --- | --- |
| `brief_not_found` | 404 | No original brief for the idea / unknown `brief_id` |
| `asset_not_found` | 404 | Unknown `asset_id` |
| `invalid_brief_status` | 409 | Revision/approval not allowed in that brief state |
| `invalid_asset_status` | 409 | e.g. revise an approved asset, repurpose a non-approved asset, approve a rejected asset |
| `invalid_formats` | 400 | Repurpose format list empty, too long, or unknown |
| `repurpose_agent_unavailable` | 503 | `repurpose` agent paused/archived/missing upstream |

Unknown DB messages still collapse to `internal_error`. No secrets in bodies or logs.

---

## 6. Sec notes for migration 68

File: `supabase/migrations/20260908230000_68_mcp_production_manager.sql` (read RPCs created VOLATILE; migration 69 `ALTER`s the same eight if an older 68 left them STABLE).

**DO NOT APPLY TO PRODUCTION without Alex approval.** Additive only:

- Table `mcp_internal.mcp_content_requests` — Bot write ledger (revision / approval-request / repurpose). RLS enabled **and forced**. No `authenticated` policies. No table DML grants to `anon` / `authenticated` / `public`. No live token hashes.
- Internal RPCs in `mcp_internal` + thin `public` wrappers (`mcp_list_ideas`, `mcp_get_idea`, `mcp_get_brief`, `mcp_get_production_status`, `mcp_request_revision`, `mcp_request_approval`, `mcp_create_repurpose_plan`) with the `enqueue_mcp_brief` revoke/grant/`auth.role()` posture.
- `mcp_internal.bot_touched_rls_status` catalog includes the new ledger table.
- Assert `bot_production` still has `content.*`. No permission-row inserts. No CoS grant for finance/security/deploy.
- Does **not** replace `enqueue_mcp_brief`. Does **not** drop or rewrite human RPCs (`review_media_asset`, `repurpose_asset`, `approve_idea_and_generate_brief`, `build_brief_with_ai`, `dispatch_brief_to_members`).
- Long text fields are clipped (8k) in Bot read RPCs so a brief body cannot become an unbounded dump.

**Requirement 6 / isolation (must be green before a tool is `real`):** same-client success; other-client id `client_forbidden`; other-client resource `client_mismatch`; revoked grant denied on replay; suspended bot `bot_not_active`; `anon`/`authenticated` cannot execute; every new RPC source contains `require_bot_client_grant` and `require_active_bot` and must not mention `can_access_client`; gateway client-scope deny before AA; `workflow.record_decision` still denied.

| Tool marked `real` | Isolation coverage |
| --- | --- |
| `content.generate_brief` | Phase 4 `isolation-rls.test.ts` (`enqueue_mcp_brief`) |
| `content.list_ideas` / `get_idea` / `get_brief` / `get_production_status` / `request_revision` / `request_approval` / `create_repurpose_plan` | Phase 5 block in `isolation-rls.test.ts` plus HTTP cases in `content-route.test.ts`; gateway deny-before-AA in `production-manager.test.ts` and `phase-4-isolation.test.ts` |

---

## 7. Gate 5 acceptance checklist

**Ping Sec before merge** (requirement 1). Run after merge on a **non-production** DB that already has migrations 63–66 (and 67 if that environment has sales agents). Apply 68 only with the normal non-prod migration process.

1. `BOT_AUTH_MODE=db` still refuses nonempty `BOT_CREDENTIALS_JSON`. Reviewer env unchanged. `workflow.record_decision` still hard-denied in gateway code.
2. Production Manager `tools/list` includes the eight real content tools below plus the three real workflow tools; still hides stubs (`content.approve_asset`, `content.queue_distribution`, …) and `workflow.record_decision`.
3. Pick a real **approved** idea on a client in `mcp_bot_clients` for `bot_production`.
4. `content.list_ideas` / `content.get_idea` return only that client. A second client UUID is `Client scope denied` at the gateway; AA `client_forbidden` if the gateway were bypassed.
5. `content.generate_brief` still 202/200 `{ job_id, client_id }` and does not re-approve the idea.
6. After the brief worker completes: `content.get_brief` returns structured fields for that idea.
7. `content.get_production_status` shows job/brief/asset state and `handoff.ready_for_distribution === false` until a human-approved asset exists.
8. `content.request_revision` with a reason sets the draft-brief rework path; replay with the same idempotency key is durable; a different payload under that key is `idempotency_conflict`.
9. `content.request_approval` does not mark a media asset `approved` and does not write `client_asset_reviews`.
10. Human approves the asset in Console (`review_media_asset`). Status then shows `ready_for_distribution: true` (handoff). `content.create_repurpose_plan` queues `repurpose` for that approved asset.
11. `workflow.get_activity` shows the Bot’s receipts for that `client_id` only. `workflow.get_pending_approvals` still only lists **gateway** pending reviews.
12. `bot_finance` still cannot call any `content.*` write. CoS trigger still rejects `bot_production` + finance/security/deploy.

**Not in this checklist:** Railway deploy, production migration apply, minting tokens for other Bots, enabling `content.queue_distribution`.

---

## 8. Smoke after merge (non-prod, Alex-gated prod apply)

Gateway and runtime tests in CI are the merge bar. Manual smoke (non-prod only):

1. Apply migration 68 to the **test** Supabase project (not prod).
2. Runtime already has `AA_MCP_SERVICE_SECRET`; no new secret.
3. Confirm `mcp_bot_clients` still lists only the intended client for `bot_production`.
4. From a machine with the Production Manager Bot token, `tools/list` then walk the Gate 5 path in §7 against one approved idea.
5. SQL checks: `mcp_internal.mcp_content_requests`, `mcp_brief_requests`, `agent_jobs` (`brief` / `repurpose`), no rows on the ungranted client.

Production apply of 68 requires **Alex approval**, same as 65/66.

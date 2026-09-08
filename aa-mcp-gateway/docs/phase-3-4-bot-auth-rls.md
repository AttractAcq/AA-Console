# Phase 3–4: Bot auth registry and domain RLS

**Status:** design for Sec review. No schema, gateway, or AA code lands in this PR.

**Audience:** Security. Engineering implements after this note is accepted.

**Host / secrets:** production MCP remains `mcp.attractacq.com`. This design does not rotate production secrets, change DNS, or rename `bot_security_devops`.

---

## 1. Problem / goals

Today Bot identity is **ephemeral configuration**, not an auditable registry.

| Concern | Today | Goal |
| --- | --- | --- |
| Credentials | `BOT_CREDENTIALS_JSON` env: `{ token, bot, clients[] }`. SHA-256 timing-safe Bearer compare in `aa-mcp-gateway/src/auth/identity.ts`. Restart required to rotate/revoke. | Durable token records (hash only), immediate revoke/rotate without depending on a process restart as the only control. |
| Permissions | Code matrix in `aa-mcp-gateway/src/policy/permissions.ts` (see [bot-permissions.md](./bot-permissions.md)). Default deny. `workflow.record_decision` hard-denied to every Bot. | Persistent, reviewable grants per `bot_id`, still default deny, still human-only for `workflow.record_decision`. |
| Client scope | Gateway env allowlist **and** AA `mcp_bot_clients` (migration 63) on enqueue. Two sources can drift. | One canonical client allowlist in AA; gateway identity load and AA enqueue both read it. |
| Bot registry | Identities are a TypeScript enum in `src/shared/types.ts`. No status (active / suspended / revoked). | Canonical `mcp_bots` row per identity, including `bot_security_devops`. |
| Domain data | Human Console RLS (`can_access_client`) plus service_role RPCs. Gateway has **no** Postgres access. Only `enqueue_mcp_brief` is a Bot-facing AA entry point. | Every Bot-touched table stays RLS-on; Bot effects enter only through `service_role` `SECURITY DEFINER` RPCs; cross-client isolation is tested, not assumed. |

**Non-goals of the implemented system (unchanged):** Bots never receive raw Supabase, SQL, shell, filesystem, or unrestricted integration tools. The gateway never holds the AA `service_role` key. Reviewer credentials stay out of the Bot registry.

---

## 2. Current baseline (do not regress)

- **Ten Bot IDs** (keep `bot_security_devops` unless Alex renames): `bot_chief_of_staff`, `bot_client_delivery`, `bot_marketing`, `bot_production`, `bot_distribution`, `bot_sales_ops`, `bot_admin`, `bot_finance`, `bot_engineering`, `bot_security_devops`.
- **Human reviewers:** `REVIEWER_CREDENTIALS_JSON` — separate tokens, `/admin/approvals` only. No Bot credential can hit those routes.
- **Service-to-service:** shared `AA_MCP_SERVICE_SECRET` between gateway and AA-Console (`agent-runtime` `POST /internal/mcp/content/generate-brief`). Distinct from Bot and reviewer tokens.
- **Discovery (Phase 2):** default `tools/list` and `call` hide stubs unless `MCP_DISCOVER_STUBS=true`. Auth is unchanged by that flag.
- **AA client scope:** `mcp_bot_clients(bot_id, client_id)` — deny-by-default, RLS enabled, `REVOKE` from `public`/`anon`/`authenticated`, `GRANT` to `service_role` only. `enqueue_mcp_brief` re-checks the grant (`FOR SHARE`) on every call, including replay. No rows are seeded by default.
- **Gateway client scope:** Action Engine also requires `input.client_id` ∈ credential `clients[]`. There is no wildcard client grant.

---

## 3. Bot auth schema (proposed)

All new tables live in AA Supabase `public` **only if** they follow the migration-63 posture. Prefer the same lock-down even if a later private schema is chosen (open question §8).

**Shared posture for every table in this section**

| Role | Access |
| --- | --- |
| `anon`, `authenticated`, `public` | `REVOKE ALL`. No RLS policies. Default deny. |
| `service_role` | Narrow table grants as below. In Supabase, `service_role` bypasses RLS; **grants + RPC `auth.role()` checks** are the real control, matching `enqueue_mcp_brief`. |
| Gateway process | **No table access.** Resolve / issue / rotate / revoke only via AA HTTP + `SECURITY DEFINER` RPCs, authenticated with `AA_MCP_SERVICE_SECRET`. |
| Human Console | No direct table grants. Any future admin UI uses `is_admin()` RPCs, not `authenticated` SELECT on token hashes. |

Enable RLS on every table. Do not create `authenticated` policies “for convenience.”

### 3.1 `mcp_bots` — canonical registry

| Column | Type | Notes |
| --- | --- | --- |
| `bot_id` | `text` **PK** | `CHECK (bot_id ~ '^bot_[a-z0-9_]{1,60}$')`. Seed the ten IDs above. |
| `display_name` | `text NOT NULL` | Operator-facing (e.g. “Production Manager”). |
| `status` | `text NOT NULL` | `active` \| `suspended` \| `revoked`. Default `active`. |
| `created_at` | `timestamptz NOT NULL` | `now()` |
| `updated_at` | `timestamptz NOT NULL` | trigger `set_updated_at` |

**Who writes:** trusted DB admin or a future admin RPC (`is_admin()`). Gateway is read-only via resolve.

**Semantics**

- `active` — tokens may authenticate if otherwise valid.
- `suspended` — all authentications fail; token rows kept; reversible.
- `revoked` — terminal. All tokens get `revoked_at`; do not re-activate without Sec + Alex.

After seed, add `mcp_bot_clients.bot_id → mcp_bots(bot_id)` (today `bot_id` is unconstrained text).

### 3.2 `mcp_bot_tokens` — hash mapping (never plaintext)

| Column | Type | Notes |
| --- | --- | --- |
| `token_id` | `uuid` **PK** | `gen_random_uuid()` |
| `bot_id` | `text NOT NULL` | FK → `mcp_bots(bot_id)` |
| `token_hash` | `bytea NOT NULL` | SHA-256 digest of the Bearer secret. **UNIQUE.** Never store or log plaintext. |
| `created_at` | `timestamptz NOT NULL` | |
| `expires_at` | `timestamptz` | nullable. `NULL` = no expiry. |
| `revoked_at` | `timestamptz` | nullable. Non-null = dead, even if `expires_at` is in the future. |
| `rotated_from` | `uuid` | nullable FK → `mcp_bot_tokens(token_id)` |
| `label` | `text` | operator label, e.g. `railway-prod-2026-09`. No secrets. |

**Indexes:** unique `token_hash`; `(bot_id, revoked_at)` for listing.

**Who writes:** issue / rotate / revoke RPCs only (`service_role`). **No DELETE** — retain hashes for forensics (a presented secret can still be proven to have been ours).

**Hashing:** continue SHA-256 of the raw token (same as `identity.ts`). Tokens are already ≥32-character high-entropy secrets, not passwords; a slow KDF is unnecessary and would make lookup unusable. Lookup is unique-index equality on the digest, then `timingSafeEqual` on the stored vs computed digest.

Allow **more than one unrevoked token per bot** so a grace window is possible. If Sec chooses hard-cut only, Eng can add a partial unique index `UNIQUE (bot_id) WHERE revoked_at IS NULL`.

### 3.3 `mcp_bot_permissions` — persistent grants

| Column | Type | Notes |
| --- | --- | --- |
| `bot_id` | `text NOT NULL` | FK → `mcp_bots` |
| `permission_pattern` | `text NOT NULL` | Exact tool name (`content.generate_brief`) or domain wildcard (`content.*`) |
| `granted_at` | `timestamptz NOT NULL` | |
| `granted_by` | `text NOT NULL` | Operator id, or `seed:code-matrix` for the initial load |

**PK:** `(bot_id, permission_pattern)`.

**Who writes:** admin RPC / DB admin. Gateway reads via resolve.

**Evaluation (gateway, after load):** default deny. A tool is allowed iff every `tool.permissions[]` entry matches some grant (`exact` or `prefix.*`), **and** the tool is not `workflow.record_decision`. Keep that hard deny in gateway code even if a row or `workflow.*` exists. Seed from today’s matrix in [bot-permissions.md](./bot-permissions.md).

### 3.4 `mcp_bot_clients` — keep / extend

Existing table (migration 63). **Do not change the enqueue contract:** presence of `(bot_id, client_id)` is the allow; delete row = revoke client. `enqueue_mcp_brief` already re-checks.

Phase 3 additions only:

- FK to `mcp_bots(bot_id)`.
- Optional `granted_at` / `granted_by` for audit (nullable, backfill `created_at`).
- No wildcard `client_id`. No “all clients” row.

Gateway identity **must** load this list from AA after cutover, not from env.

### 3.5 `mcp_bot_token_audit` — recommended

Append-only issue / rotate / revoke / expire / suspend / restore events.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `uuid` PK | |
| `bot_id` | `text NOT NULL` | |
| `token_id` | `uuid` | nullable only for bot-level events (`suspend_bot`) |
| `event` | `text NOT NULL` | `issue` \| `rotate` \| `revoke` \| `expire` \| `suspend_bot` \| `restore_bot` |
| `actor` | `text NOT NULL` | |
| `reason` | `text` | |
| `created_at` | `timestamptz NOT NULL` | |
| `metadata` | `jsonb` | labels, `rotated_from`; **never** plaintext or full hashes |

**Grants:** `service_role` INSERT + SELECT. No UPDATE/DELETE.

---

## 4. Token mapping

### 4.1 Request path

```
Authorization: Bearer <secret>
        │
        ▼
SHA-256(secret) → bytea
        │
        ▼
AA resolve RPC (service_role SECURITY DEFINER)
  mcp_bot_tokens WHERE token_hash = $1
    AND revoked_at IS NULL
    AND (expires_at IS NULL OR expires_at > now())
  JOIN mcp_bots USING (bot_id)
    AND status = 'active'
        │
        ▼
Load mcp_bot_clients + mcp_bot_permissions for that bot_id
        │
        ▼
Identity { bot, clients[], permissions[] }  (no secret, no hash)
```

Failure modes (`not found`, `revoked`, `expired`, `suspended`, `revoked bot`) all return the same gateway `401 unauthorized`. Do not distinguish them to the caller.

AA HTTP shape (illustrative): `POST /internal/mcp/auth/resolve` with `Authorization: Bearer $AA_MCP_SERVICE_SECRET` and body `{ "token_hash": "<hex or base64>" }`. Gateway already hashes; **the plaintext Bearer never leaves the gateway.**

### 4.2 Gateway cache

| Rule | Value |
| --- | --- |
| Store | In-process memory only. **Not** SQLite. SQLite stays approvals / receipts / audit. |
| Key | Token hash (or `token_id` after first resolve). |
| Value | `{ bot_id, clients, permissions, token_id, status, loaded_at }` |
| Positive TTL | **30s** suggested revocation bound. |
| Negative TTL | **≤5s** (anti-stampede). |
| Invalidation | TTL is the v1 bound. No production webhook required for this design. |
| Logging | Request audit logs `bot_id` + `token_id` after success. Never log Bearer, never log hash. |

Re-execution after human approval already rechecks current identity in the Action Engine; after cutover that identity must be a fresh or TTL-valid resolve, not a stale env snapshot.

### 4.3 `BOT_CREDENTIALS_JSON` migration

Three stages. No production secret rotation in **this** design PR; Eng/ops execute the stages after Sec accepts.

1. **Bootstrap**
   - Insert ten `mcp_bots` rows (`active`), including `bot_security_devops`.
   - Seed `mcp_bot_permissions` from the code matrix (`granted_by = 'seed:code-matrix'`).
   - Hash each env token offline (operator machine); insert `mcp_bot_tokens`. Insert matching `mcp_bot_clients` from env `clients[]`.
   - Do not print tokens in CI logs, migration files, or git.

2. **Dual-read period**
   - Gateway: hash Bearer → AA resolve; **on miss**, fall back to current env timing-safe compare.
   - If **both** hit and `bot_id` / client sets disagree → **deny** and alert. Do not pick a winner.
   - Permissions: still evaluate the **code** matrix (see §8). DB grants are loaded and compared in logs/metrics, not yet authoritative.
   - Env remains required for startup so a resolve outage does not lock every Bot out.

3. **Cutover**
   - Resolve is the only auth path. Env tokens ignored (or startup refuses a nonempty env to prevent split-brain).
   - Permissions switch per Sec (§8).
   - Break-glass: Sec decides whether a sealed env fallback remains.

`REVIEWER_CREDENTIALS_JSON` is **not** migrated into these tables.

---

## 5. Revocation & rotation

| Action | Effect | Bound |
| --- | --- | --- |
| **Revoke token** | `revoked_at = now()`. Resolve misses. Gateway cache expires within positive TTL (≤30s). | Immediate at AA; ≤30s at gateway. |
| **Suspend bot** | `mcp_bots.status = 'suspended'`. Resolve fails even if tokens are unrevoked. | Same bound. |
| **Revoke bot** | status `revoked` + revoke all tokens. Terminal. | Same bound. |
| **Revoke client** | `DELETE FROM mcp_bot_clients`. Gateway cache may still list the UUID until TTL; **AA enqueue already re-checks** and returns `client_forbidden`. | Immediate on AA writes; ≤30s on gateway-only checks. |
| **Rotate** | Insert new hash (`rotated_from = old.token_id`). Operator receives plaintext **once**. Old token: hard-cut (`revoked_at`) **or** grace (`expires_at = now() + interval`, `revoked_at` still null). | Sec picks hard-cut vs grace (§8). |

**Recommended default:** hard-cut. Dual-token grace is optional (e.g. 15 minutes) only if Grok Bot config cannot be updated atomically.

Rotate does not change `mcp_bot_clients` or permissions. Client scope stays independently revocable.

---

## 6. Table / domain map

Isolation rule for every domain: **`client_id` is required on the MCP tool input** (already in the registry). AA RPCs must reject when a resource id belongs to another client (`client_mismatch` today). No Bot is granted cross-client read or write. `delivery.list_clients` returns only `mcp_bot_clients` for that `bot_id`, never the full `clients` table.

Gateway still does not query these tables. This map is the **AA surface that future adapters/RPCs must constrain**. Stubs stay hidden unless `MCP_DISCOVER_STUBS=true`; enabling an adapter is blocked on the matching RPC + RLS tests.

| MCP domain | Primary AA tables | Primary RPCs / views (today) | Isolation |
| --- | --- | --- | --- |
| **delivery** | `clients`, `client_assignments`, `job_assignments`, `client_onboarding_steps`, `agent_jobs` | `can_access_client` (humans); Bot path must **not** use human membership. Scope = `mcp_bot_clients` | List/get only granted clients. Jobs/assignments filtered by `client_id`. |
| **campaign** | `campaigns` | campaign lifecycle API **missing** (scoped API still to be built) | `campaigns.client_id` = request `client_id`. |
| **content** | `client_ideas`, `client_briefs`, `client_media_assets`, `client_asset_reviews`, `creative_generations`, `creative_renders`, `brief_dispatches`, `mcp_brief_requests` | `enqueue_mcp_brief` (real); `approve_idea_and_generate_brief` (human); `dispatch_brief_to_members`; `review_media_asset`; `repurpose_asset` | Idea/brief/asset `client_id` must match. Enqueue already checks idea ownership + `mcp_bot_clients`. |
| **conversion** | `client_pages`, `client_brand_profiles` | landing-page worker; no Bot RPC yet | `client_pages.client_id` = request. No deploy-to-prod API. |
| **sales_agents** | **none today** | none | Do not enable adapters until a `client_id`-keyed table + RLS + RPC exist. |
| **pipeline** | `client_leads`, `lead_events`, `client_contact_details` | `advance_lead`, `stalled_leads` | Lead and events must match `client_id`. `advance_lead` today uses `can_access_client` (human). Bot RPC must check `mcp_bot_clients` instead of `auth.uid()` membership. |
| **proof** | `client_proof_assets` | `usable_proof` | Proof rows and attachments by `client_id`. Usage-rights rules stay AA-owned. |
| **attribution** | `metrics_daily`, `scheduled_posts`, `content_attribution` (view, `security_invoker`) | `top_content_by_revenue`, `acquisition_funnel`, `metrics_period_summary` | All take `p_client_id`. Bot wrappers must require `mcp_bot_clients` **in addition to** (not instead of) the `p_client_id` filter already in the SQL. |
| **economics** | `client_billing`, `finance_entries` (`client_id` nullable), `campaigns` (spend) | no validated Bot economics API | Client-scoped figures only. **`finance_periods` is agency-wide** — do not expose via Bot tools without an explicit Sec exception. |
| **workflow** | Gateway SQLite (approvals/activity) **and** AA `job_assignments` / `agent_jobs` (future task API) | gateway `WorkflowService` is real for create/list/activity of **gateway** approvals | Gateway records already bind `client_id` + bot. AA task APIs, if added, follow `mcp_bot_clients`. `workflow.record_decision` remains human-only. |
| **engineering** | **none** | none | Keep `client_id` on the tool contract. No infra-wide unscoped dump. Adapters stay stub until a scoped AA API exists. |
| **security** | **none** | none | Same as engineering. Findings must be client-scoped or explicitly agency-global with Sec sign-off (not implied by `bot_security_devops`). |

Child rows without `client_id` (e.g. `agent_job_events`, `client_asset_reviews`) isolate **through the parent**. Views that Bot RPCs use must be `security_invoker` or live behind a `SECURITY DEFINER` function that applies `mcp_bot_clients` internally.

---

## 7. Phase 4 RLS

### 7.1 Principles

1. **RLS on** for every Bot-touched table (auth registry + domain tables in §6). Existing Console tables already enable RLS; new sales-agent / engineering / security tables must enable it **before** the first adapter.
2. **No gateway Postgres.** Gateway → AA HTTPS + `AA_MCP_SERVICE_SECRET` only.
3. **Entry points are `SECURITY DEFINER` RPCs** that:
   - `RAISE` unless `auth.role() = 'service_role'` for Bot paths (copy `enqueue_mcp_brief`);
   - take explicit `p_bot_id` **and** `p_client_id`;
   - `PERFORM 1 FROM mcp_bot_clients WHERE bot_id = p_bot_id AND client_id = p_client_id FOR SHARE`;
   - load the resource `FOR UPDATE`/`FOR SHARE` and require `resource.client_id = p_client_id`;
   - `REVOKE ALL` from `public`, `anon`, `authenticated`; `GRANT EXECUTE` to `service_role` only.
4. **Do not reuse human `can_access_client(auth.uid())` as Bot authorization.** That function is membership for Console users. Bots are not profiles. Mixing them would grant a Bot every client any assigned employee can see.
5. **Human RPCs stay on `can_access_client`.** Dual entry: human RPC and Bot RPC may share an `_internal` implementation (already the `enqueue_agent_job_internal` pattern) with authorization at each wrapper.
6. **`service_role` table grants stay minimal.** Prefer execute-on-RPC over SELECT/INSERT on domain tables for the Bot path. `mcp_bot_clients` already grants SELECT/INSERT/DELETE to `service_role` for provisioning; domain data should not become a general Bot table API.
7. **Invoker views.** Any view used in a Bot RPC chain is `WITH (security_invoker = on)` or is not granted to `anon`/`authenticated`.

### 7.2 Cross-client isolation test plan

Complement `scripts/rls-isolation-test.mjs` (human client logins). Bot tests use **service_role RPC** fixtures, not Console passwords.

**Fixtures:** two clients `A` and `B`; bot `bot_production` granted **only** `A` in `mcp_bot_clients`; one extra bot `suspended` / token-revoked as needed. Resource rows (idea, lead, campaign, …) exist on both clients.

| Case | Setup | Expect |
| --- | --- | --- |
| Positive same-client | Active bot, valid token, `client_id = A`, resource owned by A | RPC succeeds (or `not_implemented` only if adapter stub; **authorization must pass**) |
| Negative other-client id | `client_id = B` | Gateway `Client scope denied` and/or AA `client_forbidden`. No row leaked. |
| Negative other-client resource | `client_id = A` but `idea_id`/`lead_id` belongs to B | `client_mismatch` / equivalent. No write on B. |
| Revoked client | Delete `(bot, A)` then replay same enqueue | `client_forbidden` even on idempotent replay (already true for briefs). |
| Suspended bot | `mcp_bots.status = suspended` | Gateway 401. AA resolve miss. No RPC with that `p_bot_id` should be callable from a new HTTP session. |
| Revoked token | `revoked_at` set | 401 after cache TTL. |
| Ungranted bot | Identity not in `mcp_bot_clients` for A | `client_forbidden`. Migration 63 seeds nothing. |
| Permission deny | Bot without `content.*` calls `content.generate_brief` | Gateway reject **before** AA. |
| `workflow.record_decision` | Any bot, even with `workflow.*` | Always denied. |
| service_role ≠ Bot | Call Bot RPC as `authenticated` / `anon` | Execute denied / `unauthorized`. |
| Direct table read | `authenticated` SELECT on `mcp_bot_tokens` / `mcp_bot_clients` | Empty / permission denied. |

Run against a database with RLS actually enabled (staging or local `supabase`, not a migration-only diff). Record: table list with `relrowsecurity`, policy count, and RPC results. Do not claim isolation from code review alone.

---

## 8. Open questions for Sec

1. **Where tokens live long-term**
   - **A. AA Supabase canonical** (recommended): hashes in `mcp_bot_tokens`; gateway memory cache only. Matches `mcp_bot_clients` and “gateway has no Supabase.”
   - **B. Gateway SQLite canonical:** hashes next to approvals. Revoke is a gateway restart/file write; AA enqueue cannot see token status, only client grants.
   - **C. Both:** dual writes. Strongest availability, highest split-brain risk.
   - Please pick A/B/C. This note assumes **A** unless Sec objects.

2. **Are permissions code-seeded only at first?**
   - Seed DB from `permissions.ts`, keep code as the **authoritative matcher** through dual-read, then switch.
   - Or: DB authoritative immediately after seed, code retained only for `workflow.record_decision` and as a CI snapshot test (`docs/bot-permissions.md` generator).
   - Recommendation: code authoritative through dual-read; DB authoritative at cutover; hard deny stays in code forever.

3. **Reviewer credentials**
   - Recommendation: **remain `REVIEWER_CREDENTIALS_JSON`**, never `mcp_bots`. Confirm.

4. **Revocation bound:** is 30s gateway TTL acceptable, or must resolve run on every MCP request (no positive cache)?

5. **Rotate:** hard-cut vs grace period (duration)?

6. **`SECURITY DEFINER` location:** keep Bot RPCs in `public` like `enqueue_mcp_brief`, or move to an unexposed schema (`mcp_internal`) with no Data API? Skill guidance prefers private schema; existing AA Bot RPC is public + revoke/grant.

7. **Break-glass env after cutover:** refuse nonempty `BOT_CREDENTIALS_JSON`, or keep sealed fallback?

8. **Agency-global tools** (`engineering.*`, `security.*`, `finance_periods`): stay client-scoped stubs, or a documented global scope that still forbids cross-client **data** access?

---

## 9. Out of scope

- Production Bot token rotation or `AA_MCP_SERVICE_SECRET` rotation **in this PR**.
- DNS / host changes. Stay on `mcp.attractacq.com`.
- Renaming `bot_security_devops`.
- OAuth / DCR / per-Bot JWT issuance.
- Granting the gateway `service_role` or any domain table DML.
- Enabling stub adapters.
- Putting reviewer or service secrets in Bot config, Vite, or git.
- Horizontal scaling of gateway SQLite (still single replica).

---

## 10. Suggested Eng sequence (after Sec sign-off)

1. Migration: `mcp_bots`, `mcp_bot_tokens`, `mcp_bot_permissions`, `mcp_bot_token_audit`; FK on `mcp_bot_clients`; seed ten bots + permission rows (**no** live token hashes in git).
2. AA RPCs + internal HTTP: resolve, issue, rotate, revoke, suspend. Same auth pattern as generate-brief.
3. Gateway dual-read + cache. Tests for mismatch deny, stub flag unchanged, reviewer path unchanged.
4. Cutover runbook (ops): hash-insert live tokens, confirm dual-read agreement, drop env.
5. Phase 4: Bot RPC wrappers per domain as adapters are enabled; isolation tests in §7.2 green before each adapter leaves stub.

Phase 3 is identity. Phase 4 is data isolation. Neither is a substitute for the other: a valid Bot token with a revoked client grant must still fail at AA.

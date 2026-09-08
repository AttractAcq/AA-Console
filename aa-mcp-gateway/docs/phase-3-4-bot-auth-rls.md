# Phase 3–4: Bot auth registry and domain RLS

**Status:** Sec decisions locked 2026-09-08. Design is binding for implementation. Do not apply registry migrations to production without Alex approval. Do not rotate production secrets or change DNS.

**Audience:** Security and Engineering.

**Host / secrets:** production MCP remains `mcp.attractacq.com`. This design does not rotate production secrets, change DNS, or rename `bot_security_devops`.

---

## Sec decisions (locked 2026-09-08)

These are locked. Do not soften, reinterpret as optional, or re-open in implementation PRs.

1. **Tokens:** AA Supabase is canonical (`mcp_bot_tokens`). Gateway memory cache only. Dual-store and gateway-SQLite-as-canonical are **rejected**.
2. **Permissions:** code is authoritative through dual-read; **DB is authoritative at cutover**; `workflow.record_decision` hard-deny stays in gateway code **forever** (even if a DB row or `workflow.*` grant exists).
3. **Reviewers** remain `REVIEWER_CREDENTIALS_JSON`. They are **never** stored in `mcp_bots` (or any Bot auth table).
4. **Cache TTL:** 30s positive cache is OK for v1. The revoke/suspend runbook **must** allow an optional gateway bounce for immediate effect (do not treat TTL as the only control).
5. **Rotate:** **hard-cut default.** Grace is only allowed with an explicit Sec exception **and** a documented duration. No implied grace window in v1 RPCs.
6. **RPC location:** prefer `mcp_internal` (or equivalent unexposed schema) for resolve / issue / rotate / revoke. If an entry point must stay in `public` (PostgREST), it has the **same posture as `enqueue_mcp_brief`**: `REVOKE ALL` from `anon` / `authenticated` / `public`; `GRANT EXECUTE` to `service_role` only; `auth.role()` check inside the function.
7. **Break-glass after cutover:** **refuse nonempty `BOT_CREDENTIALS_JSON`** (fail closed). A sealed env fallback is allowed **only** with a written Sec+Alex exception.
8. **Agency-global tools:** stay **client-scoped stubs by default**. `bot_security_devops` does **not** imply global scope. Any agency-global tool needs an **explicit Sec exception** and must still **forbid cross-client data access**.

### Must-haves (also locked)

- **Permission matcher:** exact tool name **or** single-segment domain wildcard only (`content.*` → `content.<one segment>`). No substring matching. No multi-dot abuse (`content.*` must not match `content.foo.bar`). No `*` except as the whole final segment of a two-part pattern.
- **Seed + tests enforce CoS domain prohibitions:**
  - `bot_production` — no finance, no security, no deploy.
  - `bot_finance` — no content writes.
  - `bot_security_devops` — no client financials / `finance_periods` unless an explicit Sec grant.
- **Dual-read mismatch → deny + alert.** Do not pick a winner. Structured alert/audit only; no secrets.
- **Uniform 401** on all auth failures. Do not distinguish not-found / revoked / expired / suspended / mismatch to the Bot caller.
- **Never log Bearer or hash.**
- **Plaintext Bearer never leaves the gateway.** Only the hash is sent to AA over the private hop. Railway private hop may be HTTP to `aa-console.railway.internal` — that host-exact allowlist already exists; the hash still **never** logs. HTTPS is required for every other AA origin.
- **Isolation tests must be green on a database with RLS actually enabled** before each adapter leaves stub. **Alex approval is required before applying RLS / registry migrations to production.**

---

## 1. Problem / goals

Today Bot identity is **ephemeral configuration**, not an auditable registry.

| Concern | Today | Goal |
| --- | --- | --- |
| Credentials | `BOT_CREDENTIALS_JSON` env: `{ token, bot, clients[] }`. SHA-256 timing-safe Bearer compare in `aa-mcp-gateway/src/auth/identity.ts`. Restart required to rotate/revoke. | Durable token records (hash only) in AA `mcp_bot_tokens`. Gateway memory cache only. Immediate revoke/rotate at AA; ≤30s at gateway unless operators bounce the process. |
| Permissions | Code matrix in `aa-mcp-gateway/src/policy/permissions.ts` (see [bot-permissions.md](./bot-permissions.md)). Default deny. `workflow.record_decision` hard-denied to every Bot. | Persistent, reviewable grants per `bot_id`. Code authoritative through dual-read; DB authoritative at cutover. Hard deny for `workflow.record_decision` stays in code forever. |
| Client scope | Gateway env allowlist **and** AA `mcp_bot_clients` (migration 63) on enqueue. Two sources can drift. | One canonical client allowlist in AA; gateway identity load and AA enqueue both read it after cutover. Dual-read denies on client-set mismatch. |
| Bot registry | Identities are a TypeScript enum in `src/shared/types.ts`. No status (active / suspended / revoked). | Canonical `mcp_bots` row per identity, including `bot_security_devops`. |
| Domain data | Human Console RLS (`can_access_client`) plus service_role RPCs. Gateway has **no** Postgres access. Only `enqueue_mcp_brief` is a Bot-facing AA entry point. | Every Bot-touched table stays RLS-on; Bot effects enter only through `service_role` `SECURITY DEFINER` RPCs; cross-client isolation is tested on an RLS-enabled database, not assumed. |

**Non-goals of the implemented system (unchanged):** Bots never receive raw Supabase, SQL, shell, filesystem, or unrestricted integration tools. The gateway never holds the AA `service_role` key. Reviewer credentials stay out of the Bot registry. Stub adapters stay stubs until isolation tests pass and Alex approves enabling them.

---

## 2. Current baseline (do not regress)

- **Ten Bot IDs** (keep `bot_security_devops` unless Alex renames): `bot_chief_of_staff`, `bot_client_delivery`, `bot_marketing`, `bot_production`, `bot_distribution`, `bot_sales_ops`, `bot_admin`, `bot_finance`, `bot_engineering`, `bot_security_devops`.
- **Human reviewers:** `REVIEWER_CREDENTIALS_JSON` — separate tokens, `/admin/approvals` only. No Bot credential can hit those routes. **Locked:** reviewers never migrate into `mcp_bots`.
- **Service-to-service:** shared `AA_MCP_SERVICE_SECRET` between gateway and AA-Console (`agent-runtime` `POST /internal/mcp/content/generate-brief` and auth resolve/issue/rotate/revoke). Distinct from Bot and reviewer tokens.
- **Discovery (Phase 2):** default `tools/list` and `call` hide stubs unless `MCP_DISCOVER_STUBS=true`. Auth is unchanged by that flag.
- **AA client scope:** `mcp_bot_clients(bot_id, client_id)` — deny-by-default, RLS enabled, `REVOKE` from `public`/`anon`/`authenticated`, `GRANT` to `service_role` only. `enqueue_mcp_brief` re-checks the grant (`FOR SHARE`) on every call, including replay. No rows are seeded by default.
- **Gateway client scope:** Action Engine also requires `input.client_id` ∈ credential `clients[]`. There is no wildcard client grant.

---

## 3. Bot auth schema

Registry tables live in schema `mcp_internal` (unexposed; not on the Data API schema list). `mcp_bot_clients` stays in `public` (already shipped in migration 63) with an FK to `mcp_internal.mcp_bots(bot_id)`.

Resolve / issue / rotate / revoke functions live in `mcp_internal`. Thin `public` wrappers are allowed **only** so PostgREST can reach them, and those wrappers **must** match `enqueue_mcp_brief`: `REVOKE ALL` from `anon`/`authenticated`/`public`; `GRANT EXECUTE` to `service_role` only; `auth.role()` check.

**Shared posture for every registry table**

| Role | Access |
| --- | --- |
| `anon`, `authenticated`, `public` | `REVOKE ALL`. No RLS policies. Default deny. |
| `service_role` | Prefer execute-on-RPC. In Supabase, `service_role` bypasses RLS; **grants + RPC `auth.role()` checks** are the real control, matching `enqueue_mcp_brief`. |
| Gateway process | **No table access.** Resolve / issue / rotate / revoke only via AA HTTP + `SECURITY DEFINER` RPCs, authenticated with `AA_MCP_SERVICE_SECRET`. |
| Human Console | No direct table grants. Any future admin UI uses `is_admin()` RPCs, not `authenticated` SELECT on token hashes. |

Enable RLS on every table (defense in depth, including `mcp_internal`). Do not create `authenticated` policies “for convenience.”

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

After seed, add `mcp_bot_clients.bot_id → mcp_internal.mcp_bots(bot_id)` (today `bot_id` is unconstrained text).

### 3.2 `mcp_bot_tokens` — hash mapping (never plaintext)

| Column | Type | Notes |
| --- | --- | --- |
| `token_id` | `uuid` **PK** | `gen_random_uuid()` |
| `bot_id` | `text NOT NULL` | FK → `mcp_bots(bot_id)` |
| `token_hash` | `bytea NOT NULL` | SHA-256 digest of the Bearer secret. **UNIQUE.** 32 bytes. Never store or log plaintext or the hash. |
| `created_at` | `timestamptz NOT NULL` | |
| `expires_at` | `timestamptz` | nullable. `NULL` = no expiry. |
| `revoked_at` | `timestamptz` | nullable. Non-null = dead, even if `expires_at` is in the future. |
| `rotated_from` | `uuid` | nullable FK → `mcp_bot_tokens(token_id)` |
| `label` | `text` | operator label, e.g. `railway-prod-2026-09`. No secrets. |

**Indexes:** unique `token_hash`; `(bot_id, revoked_at)` for listing.

**Who writes:** issue / rotate / revoke RPCs only (`service_role`). **No DELETE** — retain hashes for forensics (a presented secret can still be proven to have been ours).

**Hashing:** continue SHA-256 of the raw token (same as `identity.ts`). Tokens are already ≥32-character high-entropy secrets, not passwords; a slow KDF is unnecessary and would make lookup unusable. Lookup is unique-index equality on the digest, then `timingSafeEqual` on the stored vs computed digest.

**Locked:** rotate is hard-cut. Do not add a partial unique index that assumes a grace window. Multiple unrevoked rows per bot remain possible only if Sec later grants an explicit grace exception.

### 3.3 `mcp_bot_permissions` — persistent grants

| Column | Type | Notes |
| --- | --- | --- |
| `bot_id` | `text NOT NULL` | FK → `mcp_bots` |
| `permission_pattern` | `text NOT NULL` | Exact tool name (`content.generate_brief`) **or** single-segment domain wildcard (`content.*`) only. CHECK rejects any other shape. |
| `granted_at` | `timestamptz NOT NULL` | |
| `granted_by` | `text NOT NULL` | Operator id, or `seed:code-matrix` for the initial load |

**PK:** `(bot_id, permission_pattern)`.

**Who writes:** admin RPC / DB admin. Gateway reads via resolve.

**Matcher (code and SQL helper):** a grant matches a required permission iff:

- `grant === permission` (exact tool name), or
- `grant` is `<domain>.*` and `permission` is `<domain>.<one segment>` with **no additional dots**.

`content.*` matches `content.generate_brief`. It does **not** match `content.foo.bar`, `content.`, `contentX.generate_brief`, or `content.generate_brief.extra`. Substring / prefix-without-dot matching is forbidden.

**Evaluation:** default deny. A tool is allowed iff every `tool.permissions[]` entry matches some grant **and** the tool is not `workflow.record_decision`. Keep that hard deny in gateway code forever. Through dual-read, evaluate the **code** matrix; still load DB grants and **deny + alert** if they disagree with code. At cutover, DB grants become authoritative (hard deny still in code).

Seed from today’s matrix in [bot-permissions.md](./bot-permissions.md). Seed + tests **must** fail if CoS prohibitions are violated:

| Bot | Forbidden unless explicit Sec grant |
| --- | --- |
| `bot_production` | finance / `economics.*` / `finance_periods`; `security.*`; any `*.deploy` / deploy capability |
| `bot_finance` | content writes (`content.*` write tools and `content.*` wildcard) |
| `bot_security_devops` | client financials (`economics.*`, `attribution.get_revenue_attribution`, `finance_periods`) |

`bot_security_devops` is **not** a global-scope identity.

### 3.4 `mcp_bot_clients` — keep / extend

Existing table (migration 63). **Do not change the enqueue contract:** presence of `(bot_id, client_id)` is the allow; delete row = revoke client. `enqueue_mcp_brief` already re-checks.

Phase 3 additions only:

- FK to `mcp_internal.mcp_bots(bot_id)`.
- Optional `granted_at` / `granted_by` for audit (nullable, backfill `created_at`).
- No wildcard `client_id`. No “all clients” row.

Gateway identity **must** load this list from AA after cutover, not from env.

### 3.5 `mcp_bot_token_audit` — required

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
| `metadata` | `jsonb` | labels, `rotated_from`; **never** plaintext or hashes |

**Grants:** `service_role` INSERT + SELECT via RPC. No UPDATE/DELETE.

---

## 4. Token mapping

### 4.1 Request path

```
Authorization: Bearer <secret>
        │
        ▼
SHA-256(secret) → bytea     (gateway only; plaintext never leaves this process)
        │
        ▼
AA POST /internal/mcp/auth/resolve
  Authorization: Bearer $AA_MCP_SERVICE_SECRET
  body { token_hash: "<hex>" }     (hash only; never log it)
        │
        ▼
mcp_internal.resolve_bot_token (SECURITY DEFINER)
  mcp_bot_tokens WHERE token_hash = $1
  JOIN mcp_bots USING (bot_id)
  load mcp_bot_clients + mcp_bot_permissions
        │
        ▼
Identity { bot, clients[], permissions[] }  (no secret, no hash)
```

Failure modes (`not found`, `revoked`, `expired`, `suspended`, `revoked bot`, dual-read mismatch) all return the same gateway **401 unauthorized**. Do not distinguish them to the caller.

Hop notes:

- Gateway hashes first. **Plaintext Bearer never leaves the gateway.**
- Hash travels AA-ward over the existing private HTTPS hop, except the already-allowed host-exact HTTP hop to `aa-console.railway.internal`.
- Never log Bearer. Never log hash (gateway, AA HTTP, SQL notices, audit `metadata`, or CI).

### 4.2 Gateway cache

| Rule | Value |
| --- | --- |
| Store | In-process memory only. **Not** SQLite. SQLite stays approvals / receipts / audit. Dual-store / SQLite canonical: **rejected**. |
| Key | Token hash (process-private). Never written to logs or SQLite. |
| Value | `{ bot_id, clients, permissions, token_id, status, loaded_at }` |
| Positive TTL | **30s** (locked OK for v1). |
| Negative TTL | **≤5s** (anti-stampede). |
| Invalidation | TTL is the v1 bound. **Revoke/suspend runbook must allow an optional gateway bounce for immediate effect.** |
| Logging | Request audit logs `bot_id` + `token_id` after success. Never log Bearer, never log hash. |

Re-execution after human approval already rechecks current identity in the Action Engine; after cutover that identity must be a fresh or TTL-valid resolve, not a stale env snapshot.

### 4.3 `BOT_CREDENTIALS_JSON` migration

Gateway flag: `BOT_AUTH_MODE=env|dual|db`. **Default `dual`** for the Phase 3 implementation PR.

Three stages. No production secret rotation in the design or implementation PR; Eng/ops execute bootstrap/cutover after Alex approval to apply migrations.

1. **Bootstrap**
   - Insert ten `mcp_bots` rows (`active`), including `bot_security_devops`.
   - Seed `mcp_bot_permissions` from the code matrix (`granted_by = 'seed:code-matrix'`), then assert CoS prohibitions.
   - Hash each env token offline (operator machine); insert `mcp_bot_tokens`. Insert matching `mcp_bot_clients` from env `clients[]`.
   - Do not print tokens in CI logs, migration files, or git.

2. **Dual-read period (`BOT_AUTH_MODE=dual`)**
   - Gateway: hash Bearer → AA resolve.
   - **Miss** (hash not in DB) → fall back to current env timing-safe compare. Env remains required for startup so a resolve outage does not lock every Bot out.
   - **Hit but not `active`** (suspended / revoked / expired / revoked token) → **deny**. Do not fall back to env.
   - **Both hit** (AA active + env match): compare `bot_id`, client sets, and permission-pattern sets. Any disagreement → **deny + structured alert/audit**. Do not pick a winner. No secrets in the alert.
   - Permissions: still **evaluate the code matrix**. DB grants are loaded for the mismatch check, not yet used to authorize.
   - Reviewer path unchanged (`REVIEWER_CREDENTIALS_JSON` only).

3. **Cutover (`BOT_AUTH_MODE=db`)**
   - Resolve is the only auth path.
   - **Refuse nonempty `BOT_CREDENTIALS_JSON` (fail closed).** Startup must error if the env is nonempty.
   - Permissions: **DB authoritative.**
   - `workflow.record_decision` hard-deny remains in code.
   - Sealed env fallback: **forbidden** unless a written Sec+Alex exception exists.

`REVIEWER_CREDENTIALS_JSON` is **not** migrated into these tables.

---

## 5. Revocation & rotation

| Action | Effect | Bound |
| --- | --- | --- |
| **Revoke token** | `revoked_at = now()`. Resolve misses (or returns inactive). Gateway cache expires within positive TTL (30s) **or sooner if operators bounce the gateway**. | Immediate at AA; ≤30s at gateway unless bounced. |
| **Suspend bot** | `mcp_bots.status = 'suspended'`. Resolve fails even if tokens are unrevoked. Dual-read must **not** fall back to env on this hit. | Same bound. |
| **Revoke bot** | status `revoked` + revoke all tokens. Terminal. | Same bound. |
| **Revoke client** | `DELETE FROM mcp_bot_clients`. Gateway cache may still list the UUID until TTL; **AA enqueue already re-checks** and returns `client_forbidden`. | Immediate on AA writes; ≤30s on gateway-only checks (or bounce). |
| **Rotate** | Insert new hash (`rotated_from = old.token_id`). Operator receives plaintext **once**. Old token: **hard-cut** (`revoked_at = now()`). | Immediate at AA. |

**Locked default:** hard-cut. Dual-token grace does **not** ship. Grace requires an explicit Sec exception **and** a documented duration before any RPC grows a grace parameter.

Rotate does not change `mcp_bot_clients` or permissions. Client scope stays independently revocable.

---

## 6. Table / domain map

Isolation rule for every domain: **`client_id` is required on the MCP tool input** (already in the registry). AA RPCs must reject when a resource id belongs to another client (`client_mismatch` today). No Bot is granted cross-client read or write. `delivery.list_clients` returns only `mcp_bot_clients` for that `bot_id`, never the full `clients` table.

Gateway still does not query these tables. This map is the **AA surface that future adapters/RPCs must constrain**. Stubs stay hidden unless `MCP_DISCOVER_STUBS=true`; enabling an adapter is blocked on the matching RPC + RLS tests **green on a database with RLS actually enabled**, plus Alex approval before production migrations.

**Locked:** `engineering.*`, `security.*`, and `finance_periods` stay **client-scoped stubs by default**. No implied global scope from `bot_security_devops`. An agency-global tool requires an explicit Sec exception and must still forbid cross-client data access.

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
| **engineering** | **none** | none | Keep `client_id` on the tool contract. Client-scoped stub by default. No infra-wide unscoped dump. Adapters stay stub until a scoped AA API exists **and** isolation tests pass. |
| **security** | **none** | none | Same as engineering. Findings must be client-scoped. Global scope is **not** implied by `bot_security_devops`. |

Child rows without `client_id` (e.g. `agent_job_events`, `client_asset_reviews`) isolate **through the parent**. Views that Bot RPCs use must be `security_invoker` or live behind a `SECURITY DEFINER` function that applies `mcp_bot_clients` internally.

---

## 7. Phase 4 RLS

### 7.1 Principles

1. **RLS on** for every Bot-touched table (auth registry + domain tables in §6). Existing Console tables already enable RLS; new sales-agent / engineering / security tables must enable it **before** the first adapter.
2. **No gateway Postgres.** Gateway → AA HTTPS (or host-exact HTTP to `aa-console.railway.internal`) + `AA_MCP_SERVICE_SECRET` only.
3. **Entry points are `SECURITY DEFINER` RPCs** in `mcp_internal` (public wrappers only if required for PostgREST) that:
   - `RAISE` unless `auth.role() = 'service_role'` for Bot paths (copy `enqueue_mcp_brief`);
   - take explicit `p_bot_id` **and** `p_client_id` for domain writes;
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
| Suspended bot | `mcp_bots.status = suspended` | Gateway **401**. Dual-read does not fall back to env. No RPC with that `p_bot_id` should be callable from a new HTTP session. |
| Revoked token | `revoked_at` set | 401 after cache TTL, or immediately after gateway bounce. |
| Ungranted bot | Identity not in `mcp_bot_clients` for A | `client_forbidden`. Migration 63 seeds nothing. |
| Permission deny | Bot without `content.*` calls `content.generate_brief` | Gateway reject **before** AA. |
| `workflow.record_decision` | Any bot, even with `workflow.*` | Always denied in code. |
| Matcher abuse | Grant `content.*`, tool `content.foo.bar` | Deny. |
| CoS prohibitions | `bot_production` + finance/security/deploy; `bot_finance` + content write; `bot_security_devops` + client financials / `finance_periods` | Seed and tests reject. |
| service_role ≠ Bot | Call Bot RPC as `authenticated` / `anon` | Execute denied / `unauthorized`. |
| Direct table read | `authenticated` SELECT on `mcp_bot_tokens` / `mcp_bot_clients` | Empty / permission denied. |

**Locked:** run against a database with RLS actually enabled (staging or local `supabase`, not a migration-only diff) **before each adapter leaves stub**. Record: table list with `relrowsecurity`, policy count, and RPC results. Do not claim isolation from code review alone. **Alex approval is required before applying these RLS / registry migrations to production.**

Phase 4 test coverage (isolation PR, unmerged; **do not apply to prod without Alex**): [phase-4-rls-isolation.md](./phase-4-rls-isolation.md).

---

## 8. Sec questions — locked 2026-09-08

Former open questions. Answers are binding; see the section **Sec decisions (locked 2026-09-08)** at the top. Do not re-litigate in implementation.

1. **Where tokens live long-term** — **A. AA Supabase canonical.** Hashes in `mcp_bot_tokens`; gateway memory cache only. Dual-store and gateway-SQLite-as-canonical are rejected.
2. **Permission authority** — code authoritative through dual-read; **DB authoritative at cutover**; `workflow.record_decision` hard-deny stays in code forever.
3. **Reviewer credentials** — remain `REVIEWER_CREDENTIALS_JSON`, never `mcp_bots`.
4. **Revocation bound** — 30s positive cache OK for v1. Runbook must allow optional gateway bounce for immediate effect.
5. **Rotate** — **hard-cut default.** Grace only with explicit Sec exception + documented duration.
6. **`SECURITY DEFINER` location** — prefer `mcp_internal`. If a `public` wrapper is required, same posture as `enqueue_mcp_brief`.
7. **Break-glass env after cutover** — **refuse nonempty `BOT_CREDENTIALS_JSON` (fail closed).** Sealed env fallback only with Sec+Alex written exception.
8. **Agency-global tools** — stay client-scoped stubs by default. No implied global scope from `bot_security_devops`. Explicit Sec exception required; still forbid cross-client data access.

---

## 9. Out of scope

- Applying registry / RLS migrations to **production** without Alex approval.
- Production Bot token rotation or `AA_MCP_SERVICE_SECRET` rotation **in design or implementation PRs**.
- DNS / host changes. Stay on `mcp.attractacq.com`.
- Renaming `bot_security_devops`.
- OAuth / DCR / per-Bot JWT issuance.
- Granting the gateway `service_role` or any domain table DML.
- Enabling stub adapters, or treating stubs as real.
- Putting reviewer or service secrets in Bot config, Vite, or git.
- Horizontal scaling of gateway SQLite (still single replica).
- Dual-store token canonicalization or gateway SQLite as the token source of truth.

---

## 10. Eng sequence

1. Migration (after 63/64): schema `mcp_internal`; tables `mcp_bots`, `mcp_bot_tokens`, `mcp_bot_permissions`, `mcp_bot_token_audit`; FK on `mcp_bot_clients`; seed ten bots + permission rows from `permissions.ts`; CoS prohibition asserts; permission-matcher helper (exact or single-segment `domain.*` only). **No** live token hashes in git. **Do not apply to production without Alex approval.**
2. AA RPCs in `mcp_internal` + `public` wrappers with `enqueue_mcp_brief` posture; internal HTTP: resolve, issue, rotate (hard-cut), revoke, suspend. Hash in; never plaintext out of the gateway; never log Bearer or hash.
3. Gateway `BOT_AUTH_MODE=env|dual|db` (default **dual**). Dual-read + 30s positive cache. Mismatch deny + alert. Uniform 401. Reviewer path unchanged. `workflow.record_decision` hard-deny in code. `db` mode refuses nonempty `BOT_CREDENTIALS_JSON`. Document gateway bounce for immediate revoke.
4. Tests: dual-read match; dual-read mismatch deny; stub/discovery unchanged; production bot still only real tools; permission wildcard single-segment; revoked/suspended bot denied; CoS prohibitions; never log Bearer/hash.
5. Cutover runbook (ops, later): hash-insert live tokens, confirm dual-read agreement, set `BOT_AUTH_MODE=db`, empty env. Bounce gateway if immediate revoke is required during the 30s TTL.
6. Phase 4: Bot RPC wrappers per domain as adapters are enabled; isolation tests in §7.2 **green on an RLS-enabled database** before each adapter leaves stub; Alex approval before production RLS migrations.

Phase 3 is identity. Phase 4 is data isolation. Neither is a substitute for the other: a valid Bot token with a revoked client grant must still fail at AA.

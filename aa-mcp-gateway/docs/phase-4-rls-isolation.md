# Phase 4: domain RLS and cross-client isolation tests

**Status:** Implementation PR. Isolation tests are green on PGlite with `relrowsecurity` asserted. **Do not apply migration 66 (or 65) to production without Alex approval.** No prod apply steps, secret rotation, DNS, or live token migration are in this PR.

**Design:** [phase-3-4-bot-auth-rls.md](./phase-3-4-bot-auth-rls.md) §7 (RLS principles) and §7.2 (cross-client isolation test plan). Sec decisions in that note stay locked.

## What Phase 4 adds

1. **Migration 66** (`supabase/migrations/20260908200000_66_mcp_domain_rls_bot_isolation.sql`)
   - Idempotent `ENABLE ROW LEVEL SECURITY` on Bot-touched tables from design §6.
   - Drop leftover `dev_open_read` (`using (true)`) policies if any remain (migration 18 already did this in full environments).
   - `FORCE ROW LEVEL SECURITY` on Bot registry / ledger tables (`mcp_internal.*`, `mcp_bot_clients`, `mcp_brief_requests`) so table-owner bypass cannot open those tables. Domain Console tables are **not** forced.
   - `mcp_internal.require_bot_client_grant` — Bot client scope via `mcp_bot_clients` **only**. Never `can_access_client`.
   - `enqueue_mcp_brief` uses that helper and denies suspended/revoked bots (`bot_not_active`).
   - CoS prohibition trigger on `mcp_bot_permissions`.
   - `rls_auto_enable` also covers new `mcp_internal` tables.
2. **PGlite isolation tests** (`agent-runtime/src/mcp/isolation-rls.test.ts`) — §7.2 cases against a database with RLS actually on.
3. **Gateway matcher / CoS / client-scope tests** (`aa-mcp-gateway/test/phase-4-isolation.test.ts`).

Gateway still has **no Postgres access**. Stub adapters stay stubs.

## Test coverage vs design §7.2

| §7.2 case | Where | Notes |
| --- | --- | --- |
| Positive same-client | `isolation-rls.test.ts` | `enqueue_mcp_brief` succeeds for `bot_production` granted client A |
| Negative other-client id | isolation + gateway | AA `client_forbidden`; gateway `Client scope denied` |
| Negative other-client resource | isolation | `client_mismatch`; no write on B |
| Revoked client grant | isolation | Replay after `DELETE mcp_bot_clients` → `client_forbidden` |
| Suspended bot | isolation | RPC `bot_not_active`; resolve still `suspended` |
| Ungranted bot | isolation | `client_forbidden`; seed still inserts no grants |
| Permission deny before AA | gateway | `bot_finance` cannot call `content.generate_brief` |
| `workflow.record_decision` | gateway | Hard-denied in code |
| Matcher abuse | isolation + gateway | exact OR single-segment `domain.*` only |
| CoS prohibitions | isolation trigger + gateway matrix | production / finance / `bot_security_devops` |
| service_role ≠ Bot | isolation | `anon` / `authenticated` cannot execute Bot RPCs |
| Direct table read | isolation | `authenticated` denied on registry; RLS filters domain rows |
| `relrowsecurity` recorded | isolation | every **present** Bot-touched table must have RLS on |

Adapters that are still stubs must not leave stub until the matching RPC has the same isolation cases green on an RLS-enabled database.

## Production

Alex approval is required before applying registry / RLS migrations (65 and 66) to **production**. This document is not an apply runbook.

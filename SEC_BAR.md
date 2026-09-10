# Phase 11b Sec bar (LOCKED by Sec 2026-09-10) — Sales Agent Factory

1. bot_sales_ops only; exact allowlist 17→22 (+5 named in design note); update salesOps.grants + code ceiling — stale DB grants must not widen discovery/call.
2. deploy / live Meta publish stay OUT (11c) — sales_agents.deploy remains stub + CRITICAL/approval; do not realize or grant in 11b.
3. record_sale stays deferred/stub + HIGH (unchanged from Phase 11).
4. Every new Bot RPC: require_active_bot + require_bot_client_grant; never can_access_client; resource client_id match (per-client Sales Agents — no cross-client agent/config leak).
5. Harbour-only mcp_bot_clients (no grant expansion this phase).
6. workflow.record_decision hard-deny; no Bot SQL; no bank/transfer; factory must not mint credentials/tokens or touch other bots’ connectors.
7. Isolation before unstub: same-client, cross-client id/resource, revoked grant, suspended bot, anon/auth denied, gateway deny-before-AA, exact discovery=22.
8. Hard gates: keep RPC bot_forbidden on new writes if appropriate; extend assert_cos_prohibitions so non-sales_ops cannot gain sales_agents.% / factory patterns; document whether gateway SALES_OPS_ONLY set is still unnecessary.
9. Design note must name the exact +5 tools and call MEDIUM vs gateway reviewer gate for any newly-real former-HIGH/approval tools (esp. create/update sales agent config).
10. Architecture lock: Sales Ops = control/factory layer only — not prospect chat; generated agents are per-client execution objects, not a new global Bot identity/token.

No merge / mig 77 / Railway / token rotate until Sec APPROVE + Alex cutover CLEAR. No other-bot rotate.

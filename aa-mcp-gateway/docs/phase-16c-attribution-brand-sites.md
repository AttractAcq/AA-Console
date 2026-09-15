# Phase 16c — Attribution reads, brand profile, scoped Sites MCP

Implemented for review on `cursor/phase-16c-attribution-brand-sites-85cc`, based on latest `origin/main` after Phase 15 Security. **Gate 16c = NOT YET CLOSED.** No production migration, deployment, token issuance, GitHub App exposure or connector change has been performed.

## Objective

Realize Console reporting that the gateway already advertised as stubs, add a read-only brand profile for page/sales agents, and expose client-scoped site provision/publish to Marketing and Sales Ops — **not Engineering**.

Empty data returns zeros, null ratios, `items: []`, or `{ found: false, profile: null }`. It never invents numbers or brand tokens.

## Explicit non-scope

Money writes (`pipeline.record_sale`, payments, bank/Stripe/Xero), `workflow.record_decision`, `sales_agents.deploy`, bot writes of `approved_at`, Railway/secrets/infra, Engineering GitHub writes / unrestricted deploy, proof clearance, `attribution.generate_report` (stays stub), brand writes (human/Console only), live Meta/TikTok ingest, and any tool that returns GitHub App private keys.

## Existing primitives

- Console `acquisition_funnel` / spend ledger (migration 79) and `top_content_by_revenue` / `content_attribution` (migration 62).
- `client_brand_profiles` (migration 53). Read-only for Bots.
- Runtime `POST /admin/sites/provision` and `POST /admin/sites/publish` (`provisionSite` / `publishPage`). Publish already runs `injectWidget` when a sales-agent deployment is attached.
- GitHub App id + private key on `RuntimeConfig`. Keys stay in the agent-runtime process.

## Proposed MCP surface

| Tool | Action | Backend route | RPC / orchestration | Idempotency | Approval | Purpose |
|---|---|---|---|---|---|---|
| `attribution.get_conversion_funnel` | Read | `/internal/mcp/attribution/get-conversion-funnel` | `mcp_attribution_conversion_funnel` | None | None | Console acquisition funnel + spend ledger |
| `attribution.get_content_performance` | Read | `/internal/mcp/attribution/get-content-performance` | `mcp_attribution_content_performance` | None | None | Top content by revenue; empty `items` when none |
| `brand.get_profile` | Read | `/internal/mcp/brand/get-profile` | `mcp_brand_get_profile` | None | None | Colours, fonts, mood, never_do |
| `sites.provision` | Write | `/internal/mcp/sites/provision` | `mcp_sites_authorize` then `provisionSite` | Gateway receipt (replay re-auths) | **required** (HIGH) | Create/adopt the client GitHub Pages repo |
| `sites.publish_page` | Write | `/internal/mcp/sites/publish-page` | `mcp_sites_authorize` then `publishPage` (injectWidget) | Gateway receipt (replay re-auths) | **required** (HIGH) | Commit page HTML to GitHub Pages |

`attribution.get_revenue_attribution` remains Finance/CoS (Phase 13). `attribution.generate_report` remains stub.

`days` is 1–3650 (default 30). Content `limit` is 1–100 (default 10). Brand missing row: `found=false`, `profile=null`. Sites SQL only authorizes; GitHub stays on the runtime.

## Exact bot allowlist

- **Marketing:** 45 exact rows (22 reads / 23 writes) after #48 then this PR. Adds funnel, content-performance, brand, `sites.provision`, `sites.publish_page` on top of #48's 40. Do not replace with Gate 9's 23 or a 28-count.
- **Sales Ops:** 28 exact rows after #47 then this PR. Adds brand + both sites tools on top of #47's 25 (including attach/enable/build). Never overwrite those three.
- **Production:** additive `brand.get_profile` only (no sites).
- **Distribution:** retains `attribution.get_content_performance` (now real). `content.get_performance` stays the granted stub.
- **CoS:** existing `attribution.*` wildcard discovers the newly real funnel/content-performance tools. Brand and sites are hard-denied.
- **Engineering / Security / Finance / Admin:** no sites, no brand.

No `sites.*` / `brand.*` wildcards. `permissions.ts` hard-denies sites outside `bot_marketing` / `bot_sales_ops` and brand outside Marketing / Sales Ops / Production, including overbroad credentials.

## Residual risk — GitHub Pages write

`sites.provision` and `sites.publish_page` write to GitHub (create/adopt a repo; commit public HTML). Private keys never enter SQL, Bot responses, or logs. Require:

1. Active Bot + client grant (`require_active_bot` + `require_bot_client_grant`).
2. Exact permission row and Bot role (Marketing or Sales Ops).
3. Gateway HIGH approval for `sites.provision` and `sites.publish_page` before the runtime calls GitHub.
4. Runtime GitHub App config. Missing config is `github_unconfigured` **after** authorize, so ungranted Bots do not learn whether the App is configured.

Replay of sites writes skips gateway receipt short-circuit (same posture as Admin/Engineering/Security) so a revoked grant is `client_forbidden` on the next attempt rather than a cached success.

**Not live-smoked:** `sites.provision` is not executed against GitHub by Gate 9/11 smoke (would create a GitHub repo). Both sites writes are smoked only as `approval_required`.

## Database changes

Migration `supabase/migrations/20260916150000_91_mcp_attribution_brand_sites.sql`:

- `mcp_internal.attribution_conversion_funnel` / `public.mcp_attribution_conversion_funnel`
- `mcp_internal.attribution_content_performance` / `public.mcp_attribution_content_performance`
- `mcp_internal.brand_get_profile` / `public.mcp_brand_get_profile`
- `mcp_internal.sites_authorize` / `public.mcp_sites_authorize` (authorize only)
- `assert_cos_prohibitions()` keeps every prior check and forbids `sites.*` / `brand.*` wildcards, sites grants outside Marketing/Sales Ops, and brand grants outside Marketing/Sales Ops/Production
- Additive permission inserts; marketing count=45 (depends on #48 first, or includes #48's Marketing names in this mig); sales_ops count=28 (keeps #47 attach/enable/build)

Public wrappers require service role. Internal functions are not executable by PUBLIC/anon/authenticated/service_role. Every Bot RPC calls `require_active_bot` and `require_bot_client_grant`. No `can_access_client`. Fixed `search_path` and UTC. **DO NOT APPLY TO PRODUCTION without Alex.**

## Backend changes

Gateway: registry domains `brand` / `sites`, onboarding ceilings, permissions hard-denies, AA adapter routes + response validation, sites replay re-auth, docs, tests, smoke gates.

Runtime: `attribution-route.ts`, `brand-route.ts`, `sites-mcp-route.ts` wrapping `provisionSite` / `publishPage`. Keys stay on `RuntimeConfig`.

## Tests

Gateway: registry 103 (post-A+B+C: main 90 + #48's 7 conversion/campaign names + #47's 3 sales names + this PR's 3 brand/sites); Marketing 22/23 grants (**45**), `expectedDiscovery` equals grants (conversion/campaign stay **real** after last-writer merge); Sales Ops **28**; Distribution 7/6/1; empty-ok adapter validation; sites approval gate; sites replay re-auth; Engineering deny with stale `sites.*`.

Runtime/SQL: empty funnel zeros/null ratios; empty content `items: []`; missing brand `found=false`; stored brand tokens; sites authorize; foreign page / other-bot / suspended / revoked; wildcard insert denial; anon/authenticated RPC denial; `require_active_bot` + `require_bot_client_grant`, never `can_access_client`. Isolation stubs `metrics_daily` (migration 32 not in the partial fixture) and loads marketing migration 73 so the 45-row ceiling is real.

HTTP: sites Engineering deny before SQL; `github_unconfigured` after authorize; provision/publish mocks; no private key in responses. Attribution/brand empty-ok HTTP.

Validation commands:

```sh
# aa-mcp-gateway
npm ci
npm run check
npm test
npm run build
npm run docs
# agent-runtime
npm ci
npm test
npm test -- src/mcp/isolation-rls.test.ts
npm run typecheck
npm run build
# repository
git diff --check
```

## Smoke

Existing Harbour suites cover the new **reads**:

```sh
npm run smoke:marketing -- fixtures.json <private-header-file>
npm run smoke:sales-ops -- fixtures.json <private-header-file>
npm run smoke:distribution -- fixtures.json <private-header-file>
```

`sites.publish_page` and `sites.provision` are asserted `approval_required` (no GitHub). Engineering/Finance/Security gates deny brand/sites.

The endpoint must explicitly end in /mcp; HTTPS is required except localhost/127.0.0.1. The known Production MCP hostname is rejected. No connector configuration is changed.

## Audit

Existing gateway audit: bot, client, tool, request_id, execution_id, page_id resource, authorization and execution outcome. GitHub App material is never logged. SQL authority comes from the trusted runtime header, never caller JSON.

## Deployment order

Design note → implementation → migration file/local validation → tests → draft PR → security review → human CLEAR → merge → staging migration → prod migration → Railway gateway/runtime → Gate 16c smoke → operator secret cleanup → ACTIVE.

All merge, deployment, live migration and credential/connector actions remain with Alex via Chief of Staff after approval. This implementation task stops at draft PR.

## Gate 16c PASS criteria

1. Funnel/content-performance real; empty data is zeros/null/`[]`, never invented numbers. `generate_report` stub. Revenue attribution stays Finance/CoS.
2. Brand read-only for Marketing, Sales Ops, Production. No brand writes.
3. Sites owned by Marketing/Sales Ops only. Engineering hard-denied. GitHub keys stay on runtime. Provision and publish require gateway approval.
4. Reviewed migration 91, security review and human CLEAR.
5. All baseline/new tests pass; Marketing 45 / Sales Ops 28 / registry 103.
6. Cross-client, forbidden-domain, record_decision, sales_agents.deploy, Engineering GitHub, money-write and proof-clearance denials remain.
7. Staging migration and existing-bot regression evidence accepted; operator authorizes ACTIVE only after Gate smoke.

## Rollback

Authorized operator disables the new Marketing/Sales Ops grants (or the Bot credentials) and rolls back gateway/runtime to the reviewed prior release if needed. Do not rotate other bots. Additive RPCs/grants can be reversed with a forward migration; do not drop applied migrations. Do not restore credentials solely because code rolled back.

## Sec questions

1. **`sites.provision` and `sites.publish_page` are HIGH + gateway approval.** **REQUIRED / implemented.** Irreversible GitHub write.
2. **Owners are Marketing and Sales Ops, never Engineering.** **CONFIRM.** Phase 14 forbids Eng GitHub writes / unrestricted deploy.
3. **Empty data is honest.** **CONFIRM.** No placeholder ROAS, CPL, colours or fonts.
4. **GitHub App keys stay on the agent-runtime.** **CONFIRM.** MCP wrappers call the same `provisionSite` / `publishPage` after `mcp_sites_authorize`. Residual risk is a granted Bot plus an approved publish writing public HTML.
5. **No money, record_decision, sales_agents.deploy, approved_at bot writes, Railway/secrets, Eng GitHub, proof clearance.** **CONFIRM.**

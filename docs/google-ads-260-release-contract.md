# Google Ads migration 260: safe prerequisite

This branch starts at main `7f08c4b30f77ed662c669b372424898d35c4cc3d` and adapts only the SQL from `1c2d861`'s migration 260. It prepares storage and exact-version approval binding for a later Google Ads handler. It does **not** make an automated Google campaign build available. The Phase 6 release boundary in `AGENTS.md` still applies: Alex, via Chief of Staff, controls merging, production migration application, and deployment.

## What happens after applying 260

- `campaign_action_executors.google_ad_build.supported` remains `false`. `campaign_action_due` cannot claim this action, and `google_ads_build_due` names the absent runtime handler.
- The existing Google Ads Studio **Build** tab presents no request button and says automated build is unavailable. Migration 260 adds no UI or runtime handler.
- `deriveSheet` always puts `keyword_research` in `missing`. The new request RPC names that missing item and refuses to create an approval for every normally derived sheet. A sheet with an empty `missing` list is possible only through a separate service-role recording path; no research-completion workflow is provided here. Do not clear that marker without actual research evidence and an updated, immutable sheet.
- Even a complete sheet, ad copy, and a recorded Google Ads customer id are refused by `request_campaign_google_build_v6` while the executor registry remains unsupported. That RPC is deliberately dormant. The PGlite tests temporarily set the registry to supported only inside an isolated database to exercise the future approval contract.
- A `connected` integration row and a shaped customer id are metadata, not evidence that OAuth, a Google Ads developer token, permissions, or an account probe work.

## Exact approval contract prepared here

The approval scope carries a canonical JSONB specification containing the sheet id, version, plan hash, derived plan and missing list; copy id, headlines, descriptions, final URL, path 1 and path 2; plus the selected integration id and ten-digit Google Ads customer id. Its SHA-256 hash is the artifact version. JSONB preserves array boundaries and null values, so copy containing delimiter characters cannot collide with a different array. The destination is `google_ads:customers/<id>`, and the same id is inside the hashed specification.

`start_google_build_v6` requires a current, approved, leased execution, the client action switch, the latest sheet, the same copy and connected account, and the same scope, destination and hash. It snapshots the approved specification in `google_ads_builds`; that snapshot cannot be edited. A future handler must use this snapshot for all external writes and recheck account access immediately before them. No handler or API call exists in this branch.

A build retains a required reference to its exact sheet. Deleting that sheet alone is rejected; deleting the parent campaign removes both records together. The deferred foreign key preserves the audit link without breaking campaign cleanup.

`record_google_build_finished_v6` requires recorded campaign, ad group and ad resource names before marking the build successful. It does not set `client_campaigns.ad_campaign_id`: that column is a foreign key to an internal legacy `campaigns` UUID, not a Google Ads resource or spend binding. Google Ads attribution needs its own verified binding and measured spend before the product can call the campaign live.

## Remaining work before Google Ads can be enabled

1. Build and audit real keyword research, including provenance, search terms, exclusions and location checks; record a new immutable sheet with the researched plan. The current derivation remains an honest seed sheet.
2. Add a copy creation and review path and surface the exact specification through the unified Approval Inbox.
3. Bind a real Google Ads account, OAuth credential and developer token; prove the customer id and permissions in a read-only account probe.
4. Implement a runtime `google_ad_build` action handler that uses the approved snapshot, creates every external object paused, records each resource name as it is returned, and handles partial failures without duplicate creation.
5. Test stale approval, changed copy, account move, package supersession, client switch-off, retry and idempotency on the full route. Prove a paused build in a real account. Only then change the executor registry to supported in a separate reviewed migration and release.
6. Add a verified external resource to attribution mapping, activation as its own exact-version approval, spend limits and measured-outcome checks.

## Local verification

Run `npm test -- src/google-ads-build-prerequisite.pg.test.ts src/google-ads-sheet.pg.test.ts src/campaign-launch-gate.pg.test.ts` and `npm run typecheck` from `agent-runtime/`. The PGlite tests execute migrations 206, 230, 243 and 260 in order; they never call Google or alter production.

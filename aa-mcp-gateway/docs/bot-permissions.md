# Bot permissions

Default deny. Both discovery and calls use the same permission matrix. Default MCP `tools/list` and `ActionEngine.call` additionally hide stub (unimplemented) contracts unless `MCP_DISCOVER_STUBS=true`. Granted lists below are the full permission matrix, including stubs that stay in the registry. Every request is additionally restricted to the credential’s client UUID allowlist; there is no wildcard client grant. Human reviewer credentials are separate. Intelligence modules are not employee Bots.

## bot_chief_of_staff

Configured grants: `delivery.*`, `campaign.*`, `workflow.*`, `attribution.*`, `content.create_upload_url`.

Effective tools (32):

- `delivery.list_clients`
- `delivery.get_client`
- `delivery.get_status`
- `delivery.get_plan`
- `delivery.get_blockers`
- `delivery.get_next_action`
- `delivery.create_task`
- `delivery.get_client_health`
- `campaign.list`
- `campaign.get`
- `campaign.create`
- `campaign.update`
- `campaign.get_status`
- `campaign.request_approval`
- `campaign.plan`
- `campaign.provision`
- `campaign.launch`
- `campaign.get_readiness`
- `content.create_upload_url`
- `attribution.get_campaign_performance`
- `attribution.get_content_performance`
- `attribution.get_revenue_attribution`
- `attribution.get_conversion_funnel`
- `attribution.generate_report`
- `workflow.create_task`
- `workflow.assign_task`
- `workflow.get_task`
- `workflow.list_tasks`
- `workflow.complete_task`
- `workflow.create_approval`
- `workflow.get_pending_approvals`
- `workflow.get_activity`

## bot_client_delivery

Configured grants: `delivery.*`, `workflow.*`, `campaign.get`, `campaign.get_status`, `content.get_production_status`.

Effective tools (19):

- `delivery.list_clients`
- `delivery.get_client`
- `delivery.get_status`
- `delivery.get_plan`
- `delivery.get_blockers`
- `delivery.get_next_action`
- `delivery.create_task`
- `delivery.get_client_health`
- `campaign.get`
- `campaign.get_status`
- `content.get_production_status`
- `workflow.create_task`
- `workflow.assign_task`
- `workflow.get_task`
- `workflow.list_tasks`
- `workflow.complete_task`
- `workflow.create_approval`
- `workflow.get_pending_approvals`
- `workflow.get_activity`

## bot_marketing

Configured grants: `campaign.list`, `campaign.get`, `campaign.get_status`, `content.list_ideas`, `content.get_idea`, `content.get_brief`, `content.get_production_status`, `attribution.get_campaign_performance`, `delivery.get_client`, `delivery.get_status`, `delivery.get_client_health`, `workflow.get_pending_approvals`, `workflow.get_activity`, `workflow.list_tasks`, `workflow.get_task`, `campaign.get_readiness`, `conversion.list_pages`, `conversion.get_page`, `conversion.get_performance`, `attribution.get_conversion_funnel`, `attribution.get_content_performance`, `brand.get_profile`, `content.generate_brief`, `content.request_revision`, `content.request_approval`, `content.create_repurpose_plan`, `workflow.create_task`, `workflow.assign_task`, `workflow.complete_task`, `workflow.create_approval`, `conversion.create_page`, `conversion.generate_structure`, `conversion.generate_copy`, `conversion.request_approval`, `conversion.audit_page`, `conversion.revise_page`, `conversion.revert_page`, `campaign.create`, `campaign.update`, `campaign.request_approval`, `campaign.plan`, `campaign.provision`, `campaign.launch`, `sites.provision`, `sites.publish_page`.

Effective tools (45):

- `delivery.get_client`
- `delivery.get_status`
- `delivery.get_client_health`
- `campaign.list`
- `campaign.get`
- `campaign.create`
- `campaign.update`
- `campaign.get_status`
- `campaign.request_approval`
- `campaign.plan`
- `campaign.provision`
- `campaign.launch`
- `campaign.get_readiness`
- `content.list_ideas`
- `content.get_idea`
- `content.generate_brief`
- `content.get_brief`
- `content.get_production_status`
- `content.request_revision`
- `content.request_approval`
- `content.create_repurpose_plan`
- `conversion.list_pages`
- `conversion.get_page`
- `conversion.create_page`
- `conversion.generate_structure`
- `conversion.generate_copy`
- `conversion.request_approval`
- `conversion.get_performance`
- `conversion.audit_page`
- `conversion.revise_page`
- `conversion.revert_page`
- `attribution.get_campaign_performance`
- `attribution.get_content_performance`
- `attribution.get_conversion_funnel`
- `workflow.create_task`
- `workflow.assign_task`
- `workflow.get_task`
- `workflow.list_tasks`
- `workflow.complete_task`
- `workflow.create_approval`
- `workflow.get_pending_approvals`
- `workflow.get_activity`
- `brand.get_profile`
- `sites.provision`
- `sites.publish_page`

## bot_production

Configured grants: `content.*`, `proof.search`, `proof.get`, `proof.get_for_avatar`, `proof.get_for_claim`, `proof.create`, `proof.attach_asset`, `brand.get_profile`, `workflow.create_task`, `workflow.assign_task`, `workflow.get_task`, `workflow.list_tasks`, `workflow.complete_task`, `workflow.create_approval`, `workflow.get_pending_approvals`, `workflow.get_activity`.

Effective tools (30):

- `content.list_ideas`
- `content.generate_ideas`
- `content.get_idea`
- `content.select_idea`
- `content.generate_brief`
- `content.get_brief`
- `content.assign_production`
- `content.get_production_status`
- `content.create_upload_url`
- `content.submit_asset`
- `content.request_revision`
- `content.request_approval`
- `content.approve_asset`
- `content.create_repurpose_plan`
- `content.get_performance`
- `proof.search`
- `proof.get`
- `proof.create`
- `proof.attach_asset`
- `proof.get_for_avatar`
- `proof.get_for_claim`
- `workflow.create_task`
- `workflow.assign_task`
- `workflow.get_task`
- `workflow.list_tasks`
- `workflow.complete_task`
- `workflow.create_approval`
- `workflow.get_pending_approvals`
- `workflow.get_activity`
- `brand.get_profile`

## bot_distribution

Configured grants: `content.get_brief`, `content.get_production_status`, `attribution.get_content_performance`, `workflow.get_task`, `workflow.list_tasks`, `workflow.get_pending_approvals`, `workflow.get_activity`, `content.queue_distribution`, `content.record_publication`, `workflow.create_task`, `workflow.assign_task`, `workflow.complete_task`, `workflow.create_approval`, `content.get_performance`.

Effective tools (14):

- `content.get_brief`
- `content.get_production_status`
- `content.queue_distribution`
- `content.record_publication`
- `content.get_performance`
- `attribution.get_content_performance`
- `workflow.create_task`
- `workflow.assign_task`
- `workflow.get_task`
- `workflow.list_tasks`
- `workflow.complete_task`
- `workflow.create_approval`
- `workflow.get_pending_approvals`
- `workflow.get_activity`

## bot_sales_ops

Configured grants: `pipeline.list_leads`, `pipeline.get_lead`, `pipeline.get_stalled_leads`, `pipeline.get_pipeline_summary`, `sales_agents.list`, `sales_agents.get`, `sales_agents.get_conversations`, `brand.get_profile`, `workflow.get_pending_approvals`, `workflow.get_activity`, `workflow.list_tasks`, `workflow.get_task`, `pipeline.update_stage`, `pipeline.create_followup`, `sales_agents.generate_config`, `sales_agents.create`, `sales_agents.update_knowledge`, `sales_agents.update_qualification_rules`, `sales_agents.test`, `sales_agents.attach_to_page`, `sales_agents.set_deployment_enabled`, `sales_agents.build`, `workflow.create_task`, `workflow.assign_task`, `workflow.complete_task`, `workflow.create_approval`, `sites.provision`, `sites.publish_page`.

Effective tools (28):

- `sales_agents.generate_config`
- `sales_agents.list`
- `sales_agents.get`
- `sales_agents.create`
- `sales_agents.update_knowledge`
- `sales_agents.update_qualification_rules`
- `sales_agents.test`
- `sales_agents.attach_to_page`
- `sales_agents.set_deployment_enabled`
- `sales_agents.build`
- `sales_agents.get_conversations`
- `pipeline.list_leads`
- `pipeline.get_lead`
- `pipeline.get_stalled_leads`
- `pipeline.update_stage`
- `pipeline.create_followup`
- `pipeline.get_pipeline_summary`
- `workflow.create_task`
- `workflow.assign_task`
- `workflow.get_task`
- `workflow.list_tasks`
- `workflow.complete_task`
- `workflow.create_approval`
- `workflow.get_pending_approvals`
- `workflow.get_activity`
- `brand.get_profile`
- `sites.provision`
- `sites.publish_page`

## bot_admin

Configured grants: `delivery.list_clients`, `delivery.get_client`, `delivery.get_status`, `workflow.get_task`, `workflow.list_tasks`, `workflow.get_pending_approvals`, `workflow.get_activity`, `admin.list_events`, `admin.get_event`, `workflow.create_task`, `workflow.assign_task`, `workflow.complete_task`, `workflow.create_approval`, `admin.create_event`, `admin.update_event`.

Effective tools (15):

- `admin.list_events`
- `admin.get_event`
- `admin.create_event`
- `admin.update_event`
- `delivery.list_clients`
- `delivery.get_client`
- `delivery.get_status`
- `workflow.create_task`
- `workflow.assign_task`
- `workflow.get_task`
- `workflow.list_tasks`
- `workflow.complete_task`
- `workflow.create_approval`
- `workflow.get_pending_approvals`
- `workflow.get_activity`

## bot_finance

Configured grants: `economics.get_client_economics`, `economics.get_campaign_economics`, `economics.get_costs`, `economics.get_revenue`, `economics.get_roi`, `attribution.get_revenue_attribution`, `workflow.get_task`, `workflow.list_tasks`, `workflow.get_pending_approvals`, `workflow.get_activity`, `workflow.create_task`, `workflow.assign_task`, `workflow.complete_task`, `workflow.create_approval`.

Effective tools (14):

- `attribution.get_revenue_attribution`
- `economics.get_client_economics`
- `economics.get_campaign_economics`
- `economics.get_costs`
- `economics.get_revenue`
- `economics.get_roi`
- `workflow.create_task`
- `workflow.assign_task`
- `workflow.get_task`
- `workflow.list_tasks`
- `workflow.complete_task`
- `workflow.create_approval`
- `workflow.get_pending_approvals`
- `workflow.get_activity`

## bot_engineering

Configured grants: `engineering.get_issue`, `engineering.get_release_status`, `engineering.get_deployment_status`, `workflow.get_task`, `workflow.list_tasks`, `workflow.get_pending_approvals`, `workflow.get_activity`, `engineering.create_issue`, `workflow.create_task`, `workflow.assign_task`, `workflow.complete_task`, `workflow.create_approval`.

Effective tools (12):

- `workflow.create_task`
- `workflow.assign_task`
- `workflow.get_task`
- `workflow.list_tasks`
- `workflow.complete_task`
- `workflow.create_approval`
- `workflow.get_pending_approvals`
- `workflow.get_activity`
- `engineering.create_issue`
- `engineering.get_issue`
- `engineering.get_release_status`
- `engineering.get_deployment_status`

## bot_security_devops

Configured grants: `security.get_system_status`, `security.get_open_findings`, `security.get_incident_status`, `engineering.get_release_status`, `engineering.get_deployment_status`, `workflow.get_task`, `workflow.list_tasks`, `workflow.get_pending_approvals`, `workflow.get_activity`, `security.create_finding`, `workflow.create_task`, `workflow.assign_task`, `workflow.complete_task`, `workflow.create_approval`.

Effective tools (14):

- `workflow.create_task`
- `workflow.assign_task`
- `workflow.get_task`
- `workflow.list_tasks`
- `workflow.complete_task`
- `workflow.create_approval`
- `workflow.get_pending_approvals`
- `workflow.get_activity`
- `engineering.get_release_status`
- `engineering.get_deployment_status`
- `security.get_system_status`
- `security.get_open_findings`
- `security.create_finding`
- `security.get_incident_status`

All Bots are denied `workflow.record_decision`, including wildcard workflow grants. No finance payment or production deployment capability is exposed. `sales_agents.deploy` is a CRITICAL stub behind mandatory approval. Production Manager (`bot_production`) default discovery is the real granted tools: `content.list_ideas`, `content.get_idea`, `content.generate_brief`, `content.get_brief`, `content.request_revision`, `content.get_production_status`, `content.create_repurpose_plan`, `content.request_approval`, `content.select_idea`, `content.approve_asset`, `content.assign_production`, `content.create_upload_url`, `content.submit_asset`, all six `proof.*` tools, `workflow.create_approval`, `workflow.get_pending_approvals`, `workflow.get_activity`, and the five durable workflow task tools.

`content.select_idea` (idea approve), `content.approve_asset` (asset decide), `content.assign_production`, `content.create_upload_url` and `content.submit_asset` are real **only** for `bot_production` ([Phase 9b](phase-9b-production-bot-decide.md), [Phase 16b](phase-16b-sales-proof-production.md), [content.create_upload_url](content-create-upload-url.md)). `bot_chief_of_staff` may call `content.create_upload_url` as a read-check (eligible / brief status only; no URL, no storage path). `bot_marketing` keeps its `content.*` grant — needed for its other real content tools — but is hard-denied on these names in `src/policy/permissions.ts` `allowed()` and again inside the AA RPCs themselves, exactly like `workflow.record_decision`. `bot_client_delivery` never held `content.*` or these exact names.

`content.queue_distribution` (schedule) and `content.record_publication` (Gate 10 publish record) are real **only** for `bot_distribution` ([Phase 10](phase-10-distribution-manager.md)), same hard-coded pattern. `bot_production` keeps its `content.*` grant — needed for its other real content tools — but is hard-denied on these two names. `content.get_performance` and `attribution.get_content_performance` remain stubs (no live performance read yet): granted to `bot_distribution` per the original migration 65 seed, but indistinguishable from an ungranted tool unless `MCP_DISCOVER_STUBS=true`.


Phase 12: `bot_admin` has an exact 15-tool ceiling (nine reads/six writes), including four AA-native `admin.*` event tools. Other Bots cannot invoke Admin tools even with stale wildcard grants. Admin has no Finance, Security, Engineering, pipeline, sales_agents or content tools, and `workflow.record_decision` remains universally denied. Events do not send invitations or notifications. See [Phase 12](phase-12-admin-calendar.md) for database objects, guarded RPCs, replay authorization and `smoke:admin`. Gate 12 is NOT YET CLOSED.


Phase 13: `bot_finance` has an exact 14-tool ceiling (ten reads/four writes): five named `economics.*` Client Economics OS reads, `attribution.get_revenue_attribution`, and the eight-tool workflow suite. The seeded `economics.*` wildcard is replaced with exact rows. Other Bots cannot invoke `economics.*` even with stale wildcards. Money writes (`pipeline.record_sale`, payments, bank/Stripe/Xero) are not granted and stay stub. See [Phase 13](phase-13-finance-controller.md) for guarded RPCs and `smoke:finance`. Gate 13 is NOT YET CLOSED.


Phase 14: `bot_engineering` has an exact 12-tool ceiling (seven reads/five writes). The seeded `engineering.*` wildcard is replaced with four named engineering tools plus the eight workflow names. Issue create/get are bot_engineering only. Release and deployment status reads project client-scoped `client_pages` / `agent_jobs` (no HTML, params, costs or secrets) and remain callable by `bot_security_devops` via its existing exact grants. No Railway write, secret rotation or unrestricted deploy tools. See [Phase 14](phase-14-engineering-ops.md). Gate 14 is NOT YET CLOSED.


Phase 15: `bot_security_devops` has an exact 14-tool ceiling (nine reads/five writes). The seeded `security.*` wildcard is replaced with four named security tools, two engineering status reads, and the eight workflow names. Security tools are bot_security_devops only. System status is client-scoped counts (no HTML, params, costs, tokens or env). Findings/incidents are AA-native tracking records. No destroy, secret rotation, Railway write, unrestricted deploy or global/unscoped client tools. See [Phase 15](phase-15-security-devops.md). Gate 15 is NOT YET CLOSED.


Phase 16 (PR #48 / mig 89): `bot_marketing` post-#48 ceiling is **40** exact tools (19 reads/21 writes) via **additive** grants — Gate 9's 23 rows stay; this phase insert-only-owns 17 conversion + campaign execution names. This is **not** the final 45 (`brand.*` / `sites.*` / remaining attribution are out). After #48 then #46 then #47 the target is Marketing **45** / Sales Ops **28**; those PRs must APPEND, not replace. Registry length **97** is catalog size after #48 only. Ten `conversion.*` Page Builder tools are real against `client_pages` / polish jobs (no page publish). `campaign.launch` marks Execution OS `client_campaigns.status=live` only — no ad spend, Meta, or paid channels — so it stays MEDIUM without approval. CoS keeps `campaign.*` and is denied conversion. Production does not get conversion. See [Phase 16](phase-16-conversion-campaign.md). Gate 16 is NOT YET CLOSED.


Phase 16b: `bot_sales_ops` has an exact 25-tool ceiling after this PR (Phase 11b's 22 plus `sales_agents.attach_to_page`, `sales_agents.set_deployment_enabled`, `sales_agents.build`). Phase 16c (PR #46) additively grants `brand.get_profile`, `sites.provision`, `sites.publish_page` → final 28; it must append, not overwrite from the 22-tool baseline. `sales_agents.create` stays draft-only; `build` enqueues the Console `sales_agent` job. Attach inserts `client_sales_agent_deployments` with `enabled:false` and origin from the published URL. Enable is a kill-switch (one enabled deployment per page). `sales_agents.deploy` stays CRITICAL stub + ungranted. `approved_at` remains human-only. All six `proof.*` tools are real for `bot_production`; bots cannot set `usage_rights` clearance. `content.assign_production` and `content.submit_asset` are real for `bot_production` only; `content.approve_asset` stays Production-only. Catalog after #48 (97) + this PR's 3 sales_agents names: **100**. See [Phase 16b](phase-16b-sales-proof-production.md). Gate 16b is NOT YET CLOSED.


Phase 16c: Attribution funnel and content-performance reads are real (empty data returns zeros/null ratios or `items: []`, never invented numbers). `attribution.generate_report` stays stub. `attribution.get_revenue_attribution` remains Finance/CoS. `brand.get_profile` is read-only for Marketing, Sales Ops and Production. `sites.provision` / `sites.publish_page` call the same runtime orchestration as Console admin routes; GitHub App keys stay on the agent-runtime. Owners are `bot_marketing` and `bot_sales_ops` — not Engineering. Both sites writes require gateway approval (HIGH, irreversible GitHub write). Conversion and campaign execution tools stay **real** after this last-writer PR (merge order #48→#47→#46). Marketing ceiling is **45**; Sales Ops is **28**. Catalog after A+B+C: **103**. See [Phase 16c](phase-16c-attribution-brand-sites.md). Gate 16c is NOT YET CLOSED.


`content.create_upload_url` (migration 126): `bot_production` receives a 30-minute `client-media` reservation and a signed PUT URL minted by the Console runtime service role. Flow is `content.create_upload_url` → HTTP PUT bytes → existing `content.submit_asset` (`client_id`, `idempotency_key`, `storage_path`, `media_type`, optional `brief_id`). `bot_chief_of_staff` gets an eligibility read-check and never a URL. Marketing and every other bot are denied. No service-role key is added to a bot environment. Catalog **104**. See [content.create_upload_url](content-create-upload-url.md).

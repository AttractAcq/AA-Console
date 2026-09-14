# Bot permissions

Default deny. Both discovery and calls use the same permission matrix. Default MCP `tools/list` and `ActionEngine.call` additionally hide stub (unimplemented) contracts unless `MCP_DISCOVER_STUBS=true`. Granted lists below are the full permission matrix, including stubs that stay in the registry. Every request is additionally restricted to the credential’s client UUID allowlist; there is no wildcard client grant. Human reviewer credentials are separate. Intelligence modules are not employee Bots.

## bot_chief_of_staff

Configured grants: `delivery.*`, `campaign.*`, `workflow.*`, `attribution.*`.

Effective tools (27):

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

Configured grants: `campaign.list`, `campaign.get`, `campaign.get_status`, `content.list_ideas`, `content.get_idea`, `content.get_brief`, `content.get_production_status`, `attribution.get_campaign_performance`, `delivery.get_client`, `delivery.get_status`, `delivery.get_client_health`, `workflow.get_pending_approvals`, `workflow.get_activity`, `workflow.list_tasks`, `workflow.get_task`, `content.generate_brief`, `content.request_revision`, `content.request_approval`, `content.create_repurpose_plan`, `workflow.create_task`, `workflow.assign_task`, `workflow.complete_task`, `workflow.create_approval`.

Effective tools (23):

- `delivery.get_client`
- `delivery.get_status`
- `delivery.get_client_health`
- `campaign.list`
- `campaign.get`
- `campaign.get_status`
- `content.list_ideas`
- `content.get_idea`
- `content.generate_brief`
- `content.get_brief`
- `content.get_production_status`
- `content.request_revision`
- `content.request_approval`
- `content.create_repurpose_plan`
- `attribution.get_campaign_performance`
- `workflow.create_task`
- `workflow.assign_task`
- `workflow.get_task`
- `workflow.list_tasks`
- `workflow.complete_task`
- `workflow.create_approval`
- `workflow.get_pending_approvals`
- `workflow.get_activity`

## bot_production

Configured grants: `content.*`, `proof.search`, `proof.get`, `proof.get_for_avatar`, `proof.get_for_claim`, `workflow.create_task`, `workflow.assign_task`, `workflow.get_task`, `workflow.list_tasks`, `workflow.complete_task`, `workflow.create_approval`, `workflow.get_pending_approvals`, `workflow.get_activity`.

Effective tools (26):

- `content.list_ideas`
- `content.generate_ideas`
- `content.get_idea`
- `content.select_idea`
- `content.generate_brief`
- `content.get_brief`
- `content.assign_production`
- `content.get_production_status`
- `content.submit_asset`
- `content.request_revision`
- `content.request_approval`
- `content.approve_asset`
- `content.create_repurpose_plan`
- `content.get_performance`
- `proof.search`
- `proof.get`
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

## bot_distribution

Configured grants: `content.get_brief`, `content.get_production_status`, `workflow.get_task`, `workflow.list_tasks`, `workflow.get_pending_approvals`, `workflow.get_activity`, `content.queue_distribution`, `content.record_publication`, `workflow.create_task`, `workflow.assign_task`, `workflow.complete_task`, `workflow.create_approval`, `content.get_performance`, `attribution.get_content_performance`.

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

Configured grants: `pipeline.list_leads`, `pipeline.get_lead`, `pipeline.get_stalled_leads`, `pipeline.get_pipeline_summary`, `sales_agents.list`, `sales_agents.get`, `sales_agents.get_conversations`, `workflow.get_pending_approvals`, `workflow.get_activity`, `workflow.list_tasks`, `workflow.get_task`, `pipeline.update_stage`, `pipeline.create_followup`, `workflow.create_task`, `workflow.assign_task`, `workflow.complete_task`, `workflow.create_approval`.

Effective tools (17):

- `sales_agents.list`
- `sales_agents.get`
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

Configured grants: `economics.*`, `attribution.get_revenue_attribution`, `workflow.create_task`, `workflow.assign_task`, `workflow.get_task`, `workflow.list_tasks`, `workflow.complete_task`, `workflow.create_approval`, `workflow.get_pending_approvals`, `workflow.get_activity`.

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

Configured grants: `engineering.*`, `workflow.create_task`, `workflow.assign_task`, `workflow.get_task`, `workflow.list_tasks`, `workflow.complete_task`, `workflow.create_approval`, `workflow.get_pending_approvals`, `workflow.get_activity`.

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

Configured grants: `security.*`, `engineering.get_release_status`, `engineering.get_deployment_status`, `workflow.create_task`, `workflow.assign_task`, `workflow.get_task`, `workflow.list_tasks`, `workflow.complete_task`, `workflow.create_approval`, `workflow.get_pending_approvals`, `workflow.get_activity`.

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

All Bots are denied `workflow.record_decision`, including wildcard workflow grants. No finance payment or production deployment capability is exposed. `sales_agents.deploy` is a CRITICAL stub behind mandatory approval. Production Manager (`bot_production`) default discovery is the real granted tools: `content.list_ideas`, `content.get_idea`, `content.generate_brief`, `content.get_brief`, `content.request_revision`, `content.get_production_status`, `content.create_repurpose_plan`, `content.request_approval`, `workflow.create_approval`, `workflow.get_pending_approvals`, `workflow.get_activity`, and the five durable workflow task tools.

`content.select_idea` (idea approve) and `content.approve_asset` (asset decide) are real **only** for `bot_production` ([Phase 9b](phase-9b-production-bot-decide.md)). `bot_marketing` keeps its `content.*` grant — needed for its other real content tools — but is hard-denied on these two names in `src/policy/permissions.ts` `allowed()` and again inside the AA RPCs themselves, exactly like `workflow.record_decision`. `bot_chief_of_staff` and `bot_client_delivery` never held `content.*` or either exact name.

`content.queue_distribution` (schedule) and `content.record_publication` (Gate 10 publish record) are real **only** for `bot_distribution` ([Phase 10](phase-10-distribution-manager.md)), same hard-coded pattern. `bot_production` keeps its `content.*` grant — needed for its other real content tools — but is hard-denied on these two names. `content.get_performance` and `attribution.get_content_performance` remain stubs (no live performance read yet): granted to `bot_distribution` per the original migration 65 seed, but indistinguishable from an ungranted tool unless `MCP_DISCOVER_STUBS=true`.


Phase 12: `bot_admin` has an exact 15-tool ceiling (nine reads/six writes), including four AA-native `admin.*` event tools. Other Bots cannot invoke Admin tools even with stale wildcard grants. Admin has no Finance, Security, Engineering, pipeline, sales_agents or content tools, and `workflow.record_decision` remains universally denied. Events do not send invitations or notifications. See [Phase 12](phase-12-admin-calendar.md) for database objects, guarded RPCs, replay authorization and `smoke:admin`. Gate 12 is NOT YET CLOSED.

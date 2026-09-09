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

Configured grants: `campaign.*`, `content.*`, `conversion.*`, `proof.*`, `attribution.*`, `workflow.create_task`, `workflow.assign_task`, `workflow.get_task`, `workflow.list_tasks`, `workflow.complete_task`, `workflow.create_approval`, `workflow.get_pending_approvals`, `workflow.get_activity`.

Effective tools (47):

- `campaign.list`
- `campaign.get`
- `campaign.create`
- `campaign.update`
- `campaign.get_status`
- `campaign.request_approval`
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
- `content.queue_distribution`
- `content.get_performance`
- `conversion.list_pages`
- `conversion.get_page`
- `conversion.create_page`
- `conversion.generate_structure`
- `conversion.generate_copy`
- `conversion.request_approval`
- `conversion.get_performance`
- `proof.search`
- `proof.get`
- `proof.create`
- `proof.attach_asset`
- `proof.get_for_avatar`
- `proof.get_for_claim`
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

## bot_production

Configured grants: `content.*`, `proof.search`, `proof.get`, `proof.get_for_avatar`, `proof.get_for_claim`, `workflow.create_task`, `workflow.assign_task`, `workflow.get_task`, `workflow.list_tasks`, `workflow.complete_task`, `workflow.create_approval`, `workflow.get_pending_approvals`, `workflow.get_activity`.

Effective tools (27):

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
- `content.queue_distribution`
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

Configured grants: `content.get_brief`, `content.get_production_status`, `content.queue_distribution`, `content.get_performance`, `attribution.get_content_performance`, `workflow.create_task`, `workflow.assign_task`, `workflow.get_task`, `workflow.list_tasks`, `workflow.complete_task`, `workflow.create_approval`, `workflow.get_pending_approvals`, `workflow.get_activity`.

Effective tools (13):

- `content.get_brief`
- `content.get_production_status`
- `content.queue_distribution`
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

Configured grants: `pipeline.*`, `sales_agents.*`, `proof.search`, `proof.get`, `workflow.create_task`, `workflow.assign_task`, `workflow.get_task`, `workflow.list_tasks`, `workflow.complete_task`, `workflow.create_approval`, `workflow.get_pending_approvals`, `workflow.get_activity`.

Effective tools (25):

- `sales_agents.list`
- `sales_agents.get`
- `sales_agents.create`
- `sales_agents.update_knowledge`
- `sales_agents.update_qualification_rules`
- `sales_agents.test`
- `sales_agents.deploy`
- `sales_agents.get_conversations`
- `pipeline.list_leads`
- `pipeline.get_lead`
- `pipeline.get_stalled_leads`
- `pipeline.update_stage`
- `pipeline.create_followup`
- `pipeline.get_pipeline_summary`
- `pipeline.record_sale`
- `proof.search`
- `proof.get`
- `workflow.create_task`
- `workflow.assign_task`
- `workflow.get_task`
- `workflow.list_tasks`
- `workflow.complete_task`
- `workflow.create_approval`
- `workflow.get_pending_approvals`
- `workflow.get_activity`

## bot_admin

Configured grants: `delivery.list_clients`, `delivery.get_client`, `workflow.create_task`, `workflow.assign_task`, `workflow.get_task`, `workflow.list_tasks`, `workflow.complete_task`, `workflow.create_approval`, `workflow.get_pending_approvals`, `workflow.get_activity`.

Effective tools (10):

- `delivery.list_clients`
- `delivery.get_client`
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

# Tool registry

85 initial business contracts. Status is adapter availability, not evidence of live deployment. Brief generation is implemented and requires AA_INTERNAL_API_URL and AA_MCP_SERVICE_SECRET. Stub schemas reserve bounded business fields and must be versioned/refined before their adapters are enabled. All calls require an authorized client UUID; all writes require an idempotency key. HIGH/CRITICAL policy always requires human approval.

| Tool | Status | Action | Risk | Approval | Reversible | Dependency |
| --- | --- | --- | --- | --- | --- | --- |
| delivery.list_clients | real | read | LOW | no | true | Scoped AA delivery business API |
| delivery.get_client | real | read | LOW | no | true | Scoped AA delivery business API |
| delivery.get_status | real | read | LOW | no | true | Scoped AA delivery business API |
| delivery.get_plan | real | read | LOW | no | true | Scoped AA delivery business API |
| delivery.get_blockers | real | read | LOW | no | true | Scoped AA delivery business API |
| delivery.get_next_action | real | read | LOW | no | true | Scoped AA delivery business API |
| delivery.create_task | real | write | MEDIUM | no | true | Scoped AA delivery business API |
| delivery.get_client_health | real | read | LOW | no | true | Scoped AA delivery business API |
| campaign.list | real | read | LOW | no | true | Scoped AA orchestration business API |
| campaign.get | real | read | LOW | no | true | Scoped AA orchestration business API |
| campaign.create | stub | write | MEDIUM | no | true | Scoped AA campaign business API |
| campaign.update | stub | write | MEDIUM | no | true | Scoped AA campaign business API |
| campaign.get_status | real | read | LOW | no | true | Scoped AA orchestration business API |
| campaign.request_approval | stub | write | MEDIUM | no | true | Scoped AA campaign business API |
| content.list_ideas | real | read | LOW | no | true | Scoped AA content business API |
| content.generate_ideas | stub | write | MEDIUM | no | true | Scoped AA content business API |
| content.get_idea | real | read | LOW | no | true | Scoped AA content business API |
| content.select_idea | real (bot_production only) | write | MEDIUM | no | true | Scoped AA content business API |
| content.generate_brief | real | write | LOW | no | true | Scoped AA content business API |
| content.get_brief | real | read | LOW | no | true | Scoped AA content business API |
| content.assign_production | stub | write | MEDIUM | no | true | Scoped AA content business API |
| content.get_production_status | real | read | LOW | no | true | Scoped AA content business API |
| content.submit_asset | stub | write | MEDIUM | no | true | Scoped AA content business API |
| content.request_revision | real | write | MEDIUM | no | true | Scoped AA content business API |
| content.request_approval | real | write | MEDIUM | no | true | Scoped AA content business API |
| content.approve_asset | real (bot_production only) | write | MEDIUM | no | false | Scoped AA content business API |
| content.create_repurpose_plan | real | write | MEDIUM | no | true | Scoped AA content business API |
| content.queue_distribution | real (bot_distribution only) | write | MEDIUM | no | false | Scoped AA content business API |
| content.record_publication | real (bot_distribution only) | write | MEDIUM | no | false | Scoped AA content business API |
| content.get_performance | stub | read | LOW | no | true | Scoped AA content business API |
| conversion.list_pages | stub | read | LOW | no | true | Scoped AA conversion business API |
| conversion.get_page | stub | read | LOW | no | true | Scoped AA conversion business API |
| conversion.create_page | stub | write | MEDIUM | no | true | Scoped AA conversion business API |
| conversion.generate_structure | stub | write | MEDIUM | no | true | Scoped AA conversion business API |
| conversion.generate_copy | stub | write | MEDIUM | no | true | Scoped AA conversion business API |
| conversion.request_approval | stub | write | MEDIUM | no | true | Scoped AA conversion business API |
| conversion.get_performance | stub | read | LOW | no | true | Scoped AA conversion business API |
| sales_agents.list | stub | read | LOW | no | true | Scoped AA sales_agents business API |
| sales_agents.get | stub | read | LOW | no | true | Scoped AA sales_agents business API |
| sales_agents.create | stub | write | MEDIUM | no | true | Scoped AA sales_agents business API |
| sales_agents.update_knowledge | stub | write | MEDIUM | no | true | Scoped AA sales_agents business API |
| sales_agents.update_qualification_rules | stub | write | MEDIUM | no | true | Scoped AA sales_agents business API |
| sales_agents.test | stub | write | MEDIUM | no | true | Scoped AA sales_agents business API |
| sales_agents.deploy | stub | write | CRITICAL | required | false | Scoped AA sales_agents business API |
| sales_agents.get_conversations | stub | read | LOW | no | true | Scoped AA sales_agents business API |
| pipeline.list_leads | stub | read | LOW | no | true | Scoped AA pipeline business API |
| pipeline.get_lead | stub | read | LOW | no | true | Scoped AA pipeline business API |
| pipeline.get_stalled_leads | stub | read | LOW | no | true | Scoped AA pipeline business API |
| pipeline.update_stage | stub | write | MEDIUM | no | true | Scoped AA pipeline business API |
| pipeline.create_followup | stub | write | MEDIUM | no | true | Scoped AA pipeline business API |
| pipeline.get_pipeline_summary | stub | read | LOW | no | true | Scoped AA pipeline business API |
| pipeline.record_sale | stub | write | HIGH | required | false | Scoped AA pipeline business API |
| proof.search | stub | read | LOW | no | true | Scoped AA proof business API |
| proof.get | stub | read | LOW | no | true | Scoped AA proof business API |
| proof.create | stub | write | MEDIUM | no | true | Scoped AA proof business API |
| proof.attach_asset | stub | write | MEDIUM | no | true | Scoped AA proof business API |
| proof.get_for_avatar | stub | read | LOW | no | true | Scoped AA proof business API |
| proof.get_for_claim | stub | read | LOW | no | true | Scoped AA proof business API |
| attribution.get_campaign_performance | real | read | LOW | no | true | Scoped AA orchestration business API |
| attribution.get_content_performance | stub | read | LOW | no | true | Scoped AA attribution business API |
| attribution.get_revenue_attribution | stub | read | LOW | no | true | Scoped AA attribution business API |
| attribution.get_conversion_funnel | stub | read | LOW | no | true | Scoped AA attribution business API |
| attribution.generate_report | stub | write | MEDIUM | no | true | Scoped AA attribution business API |
| economics.get_client_economics | stub | read | LOW | no | true | Scoped AA economics business API |
| economics.get_campaign_economics | stub | read | LOW | no | true | Scoped AA economics business API |
| economics.get_costs | stub | read | LOW | no | true | Scoped AA economics business API |
| economics.get_revenue | stub | read | LOW | no | true | Scoped AA economics business API |
| economics.get_roi | stub | read | LOW | no | true | Scoped AA economics business API |
| workflow.create_task | real | write | MEDIUM | no | true | Scoped AA orchestration business API |
| workflow.assign_task | real | write | MEDIUM | no | true | Scoped AA orchestration business API |
| workflow.get_task | real | read | LOW | no | true | Scoped AA orchestration business API |
| workflow.list_tasks | real | read | LOW | no | true | Scoped AA orchestration business API |
| workflow.complete_task | real | write | MEDIUM | no | true | Scoped AA orchestration business API |
| workflow.create_approval | real | write | MEDIUM | creates approval | true | Gateway control store |
| workflow.get_pending_approvals | real | read | LOW | no | true | Gateway control store |
| workflow.record_decision | stub | write | HIGH | required | true | Scoped AA workflow business API |
| workflow.get_activity | real | read | LOW | no | true | Gateway control store |
| engineering.create_issue | stub | write | MEDIUM | no | true | Scoped AA engineering business API |
| engineering.get_issue | stub | read | LOW | no | true | Scoped AA engineering business API |
| engineering.get_release_status | stub | read | LOW | no | true | Scoped AA engineering business API |
| engineering.get_deployment_status | stub | read | LOW | no | true | Scoped AA engineering business API |
| security.get_system_status | stub | read | LOW | no | true | Scoped AA security business API |
| security.get_open_findings | stub | read | LOW | no | true | Scoped AA security business API |
| security.create_finding | stub | write | MEDIUM | no | true | Scoped AA security business API |
| security.get_incident_status | stub | read | LOW | no | true | Scoped AA security business API |

`workflow.record_decision` is reserved, denied to every Bot; human decisions use the reviewer API. Exact machine-readable input/output schemas and required permissions are in `src/registry/tools.ts`. Default MCP discovery and `call` expose only permitted tools with `implementation: real` (or `partial`). Stub contracts remain catalogued here and appear in `tools/list` only when `MCP_DISCOVER_STUBS=true`.

`content.select_idea` and `content.approve_asset` are real for `bot_production` only ([Phase 9b](phase-9b-production-bot-decide.md)), hard-coded in `src/policy/permissions.ts` `allowed()` and in the AA RPCs themselves — not through the permission-grant matrix, since `bot_marketing` keeps a `content.*` wildcard for its other real content tools. `content.queue_distribution` and `content.record_publication` are real for `bot_distribution` only ([Phase 10](phase-10-distribution-manager.md)), same hard-coded pattern, since `bot_production` keeps a `content.*` wildcard for its other real content tools. Every other Bot gets `not_implemented`/"Tool unavailable or unauthorized." for all four.

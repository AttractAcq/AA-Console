# Tool registry

104 initial business contracts. Status is adapter availability, not evidence of live deployment. Brief generation is implemented and requires AA_INTERNAL_API_URL and AA_MCP_SERVICE_SECRET. Stub schemas reserve bounded business fields and must be versioned/refined before their adapters are enabled. All calls require an authorized client UUID; all writes require an idempotency key. HIGH/CRITICAL policy always requires human approval.

| Tool | Status | Action | Risk | Approval | Reversible | Dependency |
| --- | --- | --- | --- | --- | --- | --- |
| admin.list_events | real (bot_admin only) | read | LOW | no | true | Scoped AA administrative events API |
| admin.get_event | real (bot_admin only) | read | LOW | no | true | Scoped AA administrative events API |
| admin.create_event | real (bot_admin only) | write | MEDIUM | no | true | Scoped AA administrative events API |
| admin.update_event | real (bot_admin only) | write | MEDIUM | no | true | Scoped AA administrative events API |
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
| campaign.create | real | write | MEDIUM | no | true | Scoped AA campaign execution API |
| campaign.update | real | write | MEDIUM | no | true | Scoped AA campaign execution API |
| campaign.get_status | real | read | LOW | no | true | Scoped AA orchestration business API |
| campaign.request_approval | real | write | MEDIUM | no | true | Scoped AA campaign execution API |
| campaign.plan | real | write | MEDIUM | no | true | Scoped AA campaign execution API |
| campaign.provision | real | write | MEDIUM | no | true | Scoped AA campaign execution API |
| campaign.launch | real | write | MEDIUM | no | true | Scoped AA campaign execution API |
| campaign.get_readiness | real | read | LOW | no | true | Scoped AA campaign execution API |
| content.list_ideas | real | read | LOW | no | true | Scoped AA content business API |
| content.generate_ideas | stub | write | MEDIUM | no | true | Scoped AA content business API |
| content.get_idea | real | read | LOW | no | true | Scoped AA content business API |
| content.select_idea | real (bot_production only) | write | MEDIUM | no | true | Scoped AA content business API |
| content.generate_brief | real | write | LOW | no | true | Scoped AA content business API |
| content.get_brief | real | read | LOW | no | true | Scoped AA content business API |
| content.assign_production | real (bot_production only) | write | MEDIUM | no | true | Scoped AA content business API |
| content.get_production_status | real | read | LOW | no | true | Scoped AA content business API |
| content.create_upload_url | real (bot_production mint; CoS read-check only) | write | MEDIUM | no | true | Scoped AA content business API |
| content.submit_asset | real (bot_production only) | write | MEDIUM | no | true | Scoped AA content business API |
| content.request_revision | real | write | MEDIUM | no | true | Scoped AA content business API |
| content.request_approval | real | write | MEDIUM | no | true | Scoped AA content business API |
| content.approve_asset | real (bot_production only) | write | MEDIUM | no | false | Scoped AA content business API |
| content.create_repurpose_plan | real | write | MEDIUM | no | true | Scoped AA content business API |
| content.queue_distribution | real (bot_distribution only) | write | MEDIUM | no | false | Scoped AA content business API |
| content.record_publication | real (bot_distribution only) | write | MEDIUM | no | false | Scoped AA content business API |
| content.get_performance | stub | read | LOW | no | true | Scoped AA content business API |
| conversion.list_pages | real | read | LOW | no | true | Scoped AA conversion business API |
| conversion.get_page | real | read | LOW | no | true | Scoped AA conversion business API |
| conversion.create_page | real | write | MEDIUM | no | true | Scoped AA conversion business API |
| conversion.generate_structure | real | write | MEDIUM | no | true | Scoped AA conversion business API |
| conversion.generate_copy | real | write | MEDIUM | no | true | Scoped AA conversion business API |
| conversion.request_approval | real | write | MEDIUM | no | true | Scoped AA conversion business API |
| conversion.get_performance | real | read | LOW | no | true | Scoped AA conversion business API |
| conversion.audit_page | real | write | MEDIUM | no | true | Scoped AA conversion business API |
| conversion.revise_page | real | write | MEDIUM | no | true | Scoped AA conversion business API |
| conversion.revert_page | real | write | MEDIUM | no | true | Scoped AA conversion business API |
| sales_agents.generate_config | real | write | MEDIUM | no | true | Scoped AA sales_agents business API |
| sales_agents.list | real | read | LOW | no | true | Scoped AA sales_agents business API |
| sales_agents.get | real | read | LOW | no | true | Scoped AA sales_agents business API |
| sales_agents.create | real | write | MEDIUM | no | true | Scoped AA sales_agents business API |
| sales_agents.update_knowledge | real | write | MEDIUM | no | true | Scoped AA sales_agents business API |
| sales_agents.update_qualification_rules | real | write | MEDIUM | no | true | Scoped AA sales_agents business API |
| sales_agents.test | real | write | MEDIUM | no | true | Scoped AA sales_agents business API |
| sales_agents.deploy | stub | write | CRITICAL | required | false | Scoped AA sales_agents business API |
| sales_agents.attach_to_page | real | write | MEDIUM | no | true | Scoped AA sales_agents business API |
| sales_agents.set_deployment_enabled | real | write | MEDIUM | no | true | Scoped AA sales_agents business API |
| sales_agents.build | real | write | MEDIUM | no | true | Scoped AA sales_agents business API |
| sales_agents.get_conversations | real | read | LOW | no | true | Scoped AA sales_agents business API |
| pipeline.list_leads | real | read | LOW | no | true | Scoped AA pipeline business API |
| pipeline.get_lead | real | read | LOW | no | true | Scoped AA pipeline business API |
| pipeline.get_stalled_leads | real | read | LOW | no | true | Scoped AA pipeline business API |
| pipeline.update_stage | real | write | MEDIUM | no | true | Scoped AA pipeline business API |
| pipeline.create_followup | real | write | MEDIUM | no | true | Scoped AA pipeline business API |
| pipeline.get_pipeline_summary | real | read | LOW | no | true | Scoped AA pipeline business API |
| pipeline.record_sale | stub | write | HIGH | required | false | Scoped AA pipeline business API |
| proof.search | real | read | LOW | no | true | Scoped AA proof business API |
| proof.get | real | read | LOW | no | true | Scoped AA proof business API |
| proof.create | real | write | MEDIUM | no | true | Scoped AA proof business API |
| proof.attach_asset | real | write | MEDIUM | no | true | Scoped AA proof business API |
| proof.get_for_avatar | real | read | LOW | no | true | Scoped AA proof business API |
| proof.get_for_claim | real | read | LOW | no | true | Scoped AA proof business API |
| attribution.get_campaign_performance | real | read | LOW | no | true | Scoped AA orchestration business API |
| attribution.get_content_performance | real | read | LOW | no | true | Scoped AA attribution business API |
| attribution.get_revenue_attribution | real | read | LOW | no | true | Scoped AA attribution business API |
| attribution.get_conversion_funnel | real | read | LOW | no | true | Scoped AA attribution business API |
| attribution.generate_report | stub | write | MEDIUM | no | true | Scoped AA attribution business API |
| economics.get_client_economics | real (bot_finance only) | read | LOW | no | true | Scoped AA economics business API |
| economics.get_campaign_economics | real (bot_finance only) | read | LOW | no | true | Scoped AA economics business API |
| economics.get_costs | real (bot_finance only) | read | LOW | no | true | Scoped AA economics business API |
| economics.get_revenue | real (bot_finance only) | read | LOW | no | true | Scoped AA economics business API |
| economics.get_roi | real (bot_finance only) | read | LOW | no | true | Scoped AA economics business API |
| workflow.create_task | real | write | MEDIUM | no | true | Scoped AA orchestration business API |
| workflow.assign_task | real | write | MEDIUM | no | true | Scoped AA orchestration business API |
| workflow.get_task | real | read | LOW | no | true | Scoped AA orchestration business API |
| workflow.list_tasks | real | read | LOW | no | true | Scoped AA orchestration business API |
| workflow.complete_task | real | write | MEDIUM | no | true | Scoped AA orchestration business API |
| workflow.create_approval | real | write | MEDIUM | creates approval | true | Gateway control store |
| workflow.get_pending_approvals | real | read | LOW | no | true | Gateway control store |
| workflow.record_decision | stub | write | HIGH | required | true | Scoped AA workflow business API |
| workflow.get_activity | real | read | LOW | no | true | Gateway control store |
| engineering.create_issue | real (bot_engineering only) | write | MEDIUM | no | true | Scoped AA engineering business API |
| engineering.get_issue | real (bot_engineering only) | read | LOW | no | true | Scoped AA engineering business API |
| engineering.get_release_status | real (bot_engineering; status also bot_security_devops) | read | LOW | no | true | Scoped AA engineering business API |
| engineering.get_deployment_status | real (bot_engineering; status also bot_security_devops) | read | LOW | no | true | Scoped AA engineering business API |
| security.get_system_status | real (bot_security_devops only) | read | LOW | no | true | Scoped AA security business API |
| security.get_open_findings | real (bot_security_devops only) | read | LOW | no | true | Scoped AA security business API |
| security.create_finding | real (bot_security_devops only) | write | MEDIUM | no | true | Scoped AA security business API |
| security.get_incident_status | real (bot_security_devops only) | read | LOW | no | true | Scoped AA security business API |
| brand.get_profile | real | read | LOW | no | true | Scoped AA brand business API |
| sites.provision | real | write | HIGH | required | false | Scoped AA sites business API |
| sites.publish_page | real | write | HIGH | required | false | Scoped AA sites business API |

`workflow.record_decision` is reserved, denied to every Bot; human decisions use the reviewer API. Exact machine-readable input/output schemas and required permissions are in `src/registry/tools.ts`. Default MCP discovery and `call` expose only permitted tools with `implementation: real` (or `partial`). Stub contracts remain catalogued here and appear in `tools/list` only when `MCP_DISCOVER_STUBS=true`.

`content.select_idea`, `content.approve_asset`, `content.assign_production`, `content.create_upload_url` and `content.submit_asset` are real for `bot_production` only ([Phase 9b](phase-9b-production-bot-decide.md), [Phase 16b](phase-16b-sales-proof-production.md), [content.create_upload_url](content-create-upload-url.md)), hard-coded in `src/policy/permissions.ts` `allowed()` and in the AA RPCs themselves — not through the permission-grant matrix, since `bot_marketing` keeps a `content.*` wildcard for its other real content tools. `content.create_upload_url` is the exception for `bot_chief_of_staff`: a read-check that returns eligibility and never an upload URL. `content.queue_distribution` and `content.record_publication` are real for `bot_distribution` only ([Phase 10](phase-10-distribution-manager.md)), same hard-coded pattern, since `bot_production` keeps a `content.*` wildcard for its other real content tools. Every other Bot gets `not_implemented`/"Tool unavailable or unauthorized." for those names.


Phase 12: `bot_admin` has an exact 15-tool ceiling (nine reads/six writes), including four AA-native `admin.*` event tools. Other Bots cannot invoke Admin tools even with stale wildcard grants. Admin has no Finance, Security, Engineering, pipeline, sales_agents or content tools, and `workflow.record_decision` remains universally denied. Events do not send invitations or notifications. See [Phase 12](phase-12-admin-calendar.md) for database objects, guarded RPCs, replay authorization and `smoke:admin`. Gate 12 is NOT YET CLOSED.


Phase 13: `bot_finance` has an exact 14-tool ceiling (ten reads/four writes): five named `economics.*` Client Economics OS reads, `attribution.get_revenue_attribution`, and the eight-tool workflow suite. The seeded `economics.*` wildcard is replaced with exact rows. Other Bots cannot invoke `economics.*` even with stale wildcards. Money writes (`pipeline.record_sale`, payments, bank/Stripe/Xero) are not granted and stay stub. See [Phase 13](phase-13-finance-controller.md) for guarded RPCs and `smoke:finance`. Gate 13 is NOT YET CLOSED.


Phase 14: `bot_engineering` has an exact 12-tool ceiling (seven reads/five writes). The seeded `engineering.*` wildcard is replaced with four named engineering tools plus the eight workflow names. Issue create/get are bot_engineering only. Release and deployment status reads project client-scoped `client_pages` / `agent_jobs` (no HTML, params, costs or secrets) and remain callable by `bot_security_devops` via its existing exact grants. No Railway write, secret rotation or unrestricted deploy tools. See [Phase 14](phase-14-engineering-ops.md). Gate 14 is NOT YET CLOSED.


Phase 15: `bot_security_devops` has an exact 14-tool ceiling (nine reads/five writes). The seeded `security.*` wildcard is replaced with four named security tools, two engineering status reads, and the eight workflow names. Security tools are bot_security_devops only. System status is client-scoped counts (no HTML, params, costs, tokens or env). Findings/incidents are AA-native tracking records. No destroy, secret rotation, Railway write, unrestricted deploy or global/unscoped client tools. See [Phase 15](phase-15-security-devops.md). Gate 15 is NOT YET CLOSED.


Phase 16 (PR #48 / mig 89): `bot_marketing` post-#48 ceiling is **40** exact tools (19 reads/21 writes) via **additive** grants — Gate 9's 23 rows stay; this phase insert-only-owns 17 conversion + campaign execution names. This is **not** the final 45 (`brand.*` / `sites.*` / remaining attribution are out). After #48 then #46 then #47 the target is Marketing **45** / Sales Ops **28**; those PRs must APPEND, not replace. Registry length **97** is catalog size after #48 only. Ten `conversion.*` Page Builder tools are real against `client_pages` / polish jobs (no page publish). `campaign.launch` marks Execution OS `client_campaigns.status=live` only — no ad spend, Meta, or paid channels — so it stays MEDIUM without approval. CoS keeps `campaign.*` and is denied conversion. Production does not get conversion. See [Phase 16](phase-16-conversion-campaign.md). Gate 16 is NOT YET CLOSED.


Phase 16b: `bot_sales_ops` has an exact 25-tool ceiling after this PR (Phase 11b's 22 plus `sales_agents.attach_to_page`, `sales_agents.set_deployment_enabled`, `sales_agents.build`). Phase 16c (PR #46) additively grants `brand.get_profile`, `sites.provision`, `sites.publish_page` → final 28; it must append, not overwrite from the 22-tool baseline. `sales_agents.create` stays draft-only; `build` enqueues the Console `sales_agent` job. Attach inserts `client_sales_agent_deployments` with `enabled:false` and origin from the published URL. Enable is a kill-switch (one enabled deployment per page). `sales_agents.deploy` stays CRITICAL stub + ungranted. `approved_at` remains human-only. All six `proof.*` tools are real for `bot_production`; bots cannot set `usage_rights` clearance. `content.assign_production` and `content.submit_asset` are real for `bot_production` only; `content.approve_asset` stays Production-only. Catalog after #48 (97) + this PR's 3 sales_agents names: **100**. See [Phase 16b](phase-16b-sales-proof-production.md). Gate 16b is NOT YET CLOSED.


Phase 16c: Attribution funnel and content-performance reads are real (empty data returns zeros/null ratios or `items: []`, never invented numbers). `attribution.generate_report` stays stub. `attribution.get_revenue_attribution` remains Finance/CoS. `brand.get_profile` is read-only for Marketing, Sales Ops and Production. `sites.provision` / `sites.publish_page` call the same runtime orchestration as Console admin routes; GitHub App keys stay on the agent-runtime. Owners are `bot_marketing` and `bot_sales_ops` — not Engineering. Both sites writes require gateway approval (HIGH, irreversible GitHub write). Conversion and campaign execution tools stay **real** after this last-writer PR (merge order #48→#47→#46). Marketing ceiling is **45**; Sales Ops is **28**. Catalog after A+B+C: **103**. See [Phase 16c](phase-16c-attribution-brand-sites.md). Gate 16c is NOT YET CLOSED.


`content.create_upload_url` (migration 126): `bot_production` receives a 30-minute `client-media` reservation and a signed PUT URL minted by the Console runtime service role. Flow is `content.create_upload_url` → HTTP PUT bytes → existing `content.submit_asset` (`client_id`, `idempotency_key`, `storage_path`, `media_type`, optional `brief_id`). `bot_chief_of_staff` gets an eligibility read-check and never a URL. Marketing and every other bot are denied. No service-role key is added to a bot environment. Catalog **104**. See [content.create_upload_url](content-create-upload-url.md).

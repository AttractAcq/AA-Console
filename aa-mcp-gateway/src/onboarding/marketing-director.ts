import { chiefOfStaff } from "./chief-of-staff.js";
/**
 * Alex-locked 2026-09-15 Phase 16 (PR #48 / mig 89) then Phase 16c (PR #46 / mig 91).
 * Declaration only; provisions no credentials or grants.
 *
 * Post-#48 Marketing ceiling is 40 (Gate 9's 23 + 17 conversion/campaign).
 * Phase 16c APPENDS five names: attribution.get_conversion_funnel,
 * attribution.get_content_performance, brand.get_profile, sites.provision,
 * sites.publish_page → **45**. Do not replace Gate 9 or Phase 16 grants.
 */
const gate9Reads = [
  "campaign.list",
  "campaign.get",
  "campaign.get_status",
  "content.list_ideas",
  "content.get_idea",
  "content.get_brief",
  "content.get_production_status",
  "attribution.get_campaign_performance",
  "delivery.get_client",
  "delivery.get_status",
  "delivery.get_client_health",
  "workflow.get_pending_approvals",
  "workflow.get_activity",
  "workflow.list_tasks",
  "workflow.get_task",
] as const;
const gate9Writes = [
  "content.generate_brief",
  "content.request_revision",
  "content.request_approval",
  "content.create_repurpose_plan",
  "workflow.create_task",
  "workflow.assign_task",
  "workflow.complete_task",
  "workflow.create_approval",
] as const;
/** Tools PR #48 realizes and additively grants. #46 must not delete these. */
const phase16Reads = [
  "campaign.get_readiness",
  "conversion.list_pages",
  "conversion.get_page",
  "conversion.get_performance",
] as const;
const phase16Writes = [
  "conversion.create_page",
  "conversion.generate_structure",
  "conversion.generate_copy",
  "conversion.request_approval",
  "conversion.audit_page",
  "conversion.revise_page",
  "conversion.revert_page",
  "campaign.create",
  "campaign.update",
  "campaign.request_approval",
  "campaign.plan",
  "campaign.provision",
  "campaign.launch",
] as const;
const phase16cReads = [
  "attribution.get_conversion_funnel",
  "attribution.get_content_performance",
  "brand.get_profile",
] as const;
const phase16cWrites = ["sites.provision", "sites.publish_page"] as const;
const reads = [...gate9Reads, ...phase16Reads, ...phase16cReads] as const;
const writes = [...gate9Writes, ...phase16Writes, ...phase16cWrites] as const;
export const marketingDirector = {
  bot_id: "bot_marketing",
  reads,
  writes,
  grants: [...reads, ...writes],
  expectedDiscovery: [...reads, ...writes],
  phase16Owned: [...phase16Reads, ...phase16Writes],
  forbidden: [
    "economics",
    "security",
    "engineering",
    "pipeline",
    "sales_agents",
    "finance",
    "deploy",
    "infra",
    "secrets",
    "admin",
    "workflow.record_decision",
    "content.approve_asset",
    "content.queue_distribution",
    "content.assign_production",
    "content.create_upload_url",
    "content.submit_asset",
    "attribution.get_revenue_attribution",
    "delivery.list_clients",
    "sales_agents.deploy",
  ],
  future: [
    "content.generate_ideas",
    "content.select_idea",
    "proof.search",
    "proof.get",
    "proof.get_for_avatar",
    "proof.get_for_claim",
    "proof.create",
    "proof.attach_asset",
  ],
  connector: { ...chiefOfStaff.connector, args: [...chiefOfStaff.connector.args] },
  contractSteps: [4, 5, 6, 7, 8, 9, 10],
} as const;

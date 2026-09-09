import { chiefOfStaff } from "./chief-of-staff.js";
/** Alex-locked 2026-09-09. Declaration only; provisions no credentials or grants. */
const reads = ["campaign.list", "campaign.get", "campaign.get_status", "content.list_ideas", "content.get_idea", "content.get_brief", "content.get_production_status", "attribution.get_campaign_performance", "delivery.get_client", "delivery.get_status", "delivery.get_client_health", "workflow.get_pending_approvals", "workflow.get_activity", "workflow.list_tasks", "workflow.get_task"] as const;
const writes = ["content.generate_brief", "content.request_revision", "content.request_approval", "content.create_repurpose_plan", "workflow.create_task", "workflow.assign_task", "workflow.complete_task", "workflow.create_approval"] as const;
export const marketingDirector = {
 bot_id: "bot_marketing", reads, writes,
 grants: [...reads, ...writes],
 expectedDiscovery: [...reads, ...writes],
 forbidden: ["economics", "security", "engineering", "pipeline", "sales_agents", "finance", "deploy", "infra", "secrets", "admin", "workflow.record_decision", "content.approve_asset", "content.queue_distribution", "content.assign_production", "content.submit_asset", "attribution.get_revenue_attribution", "delivery.list_clients"],
 future: ["campaign.create", "campaign.update", "campaign.request_approval", "content.generate_ideas", "content.select_idea", "attribution.get_content_performance", "proof.search", "proof.get", "proof.get_for_avatar", "proof.get_for_claim", "proof.create", "proof.attach_asset", "conversion.*"],
 connector: { ...chiefOfStaff.connector, args: [...chiefOfStaff.connector.args] },
 contractSteps: [4,5,6,7,8,9,10],
} as const;

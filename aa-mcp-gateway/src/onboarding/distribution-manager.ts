import { chiefOfStaff } from "./chief-of-staff.js";
/** Alex-locked 2026-09-09. Declaration only; provisions no credentials or grants. */
const reads = ["content.get_brief", "content.get_production_status", "workflow.get_task", "workflow.list_tasks", "workflow.get_pending_approvals", "workflow.get_activity"] as const;
const writes = ["content.queue_distribution", "content.record_publication", "workflow.create_task", "workflow.assign_task", "workflow.complete_task", "workflow.create_approval"] as const;
/** Granted (migration 65/75) but not yet realized; hidden from default discovery. Not "future" (ungranted) — see design note §7. */
const stubs = ["content.get_performance", "attribution.get_content_performance"] as const;
export const distributionManager = {
  bot_id: "bot_distribution", reads, writes, stubs,
  grants: [...reads, ...writes, ...stubs],
  expectedDiscovery: [...reads, ...writes],
  forbidden: ["economics", "security", "engineering", "pipeline", "sales_agents", "finance", "deploy", "infra", "secrets", "admin", "workflow.record_decision", "content.select_idea", "content.approve_asset", "content.generate_brief", "content.generate_ideas", "content.assign_production", "content.submit_asset", "campaign.create", "campaign.update", "campaign.request_approval"],
  future: [] as string[],
  connector: { ...chiefOfStaff.connector, args: [...chiefOfStaff.connector.args] },
  contractSteps: [4, 5, 6, 7, 8, 9, 10],
} as const;

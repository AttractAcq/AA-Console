import { chiefOfStaff } from "./chief-of-staff.js";
/**
 * Alex-locked 2026-09-10 (SEC_BAR.md, Sec-locked same day). Declaration only;
 * provisions no credentials or grants.
 * Phase 11b addendum (SEC_BAR.md, locked 2026-09-10, same day): additive
 * factory writes (generate_config/create/update_knowledge/
 * update_qualification_rules/test) join the write set; sales_agents.deploy
 * stays forbidden/deferred to Phase 11c or Eng. 17 -> 22.
 */
const reads = ["pipeline.list_leads", "pipeline.get_lead", "pipeline.get_stalled_leads", "pipeline.get_pipeline_summary", "sales_agents.list", "sales_agents.get", "sales_agents.get_conversations", "workflow.get_pending_approvals", "workflow.get_activity", "workflow.list_tasks", "workflow.get_task"] as const;
const writes = ["pipeline.update_stage", "pipeline.create_followup", "sales_agents.generate_config", "sales_agents.create", "sales_agents.update_knowledge", "sales_agents.update_qualification_rules", "sales_agents.test", "workflow.create_task", "workflow.assign_task", "workflow.complete_task", "workflow.create_approval"] as const;
export const salesOps = {
  bot_id: "bot_sales_ops", reads, writes,
  grants: [...reads, ...writes],
  expectedDiscovery: [...reads, ...writes],
  forbidden: ["economics", "security", "engineering", "finance", "deploy", "infra", "secrets", "admin", "workflow.record_decision", "pipeline.record_sale", "sales_agents.deploy", "proof.search", "proof.get", "content.select_idea", "content.approve_asset", "content.queue_distribution", "content.record_publication", "content.generate_brief", "content.generate_ideas", "content.assign_production", "content.submit_asset", "campaign.create", "campaign.update", "campaign.request_approval"],
  /** Not granted; require a separate Alex CLEAR before any future phase realizes or grants these (Alex CLEAR #5, SEC_BAR #2/#3/#4). sales_agents.deploy + live channel OAuth/webhook/send deferred to Phase 11c / Eng. */
  future: ["pipeline.record_sale", "sales_agents.deploy", "proof.search", "proof.get"] as string[],
  connector: { ...chiefOfStaff.connector, args: [...chiefOfStaff.connector.args] },
  contractSteps: [4, 5, 6, 7, 8, 9, 10],
} as const;

import { chiefOfStaff } from "./chief-of-staff.js";
/** Phase 13 locked surface. Declaration only: no provisioning. */
const reads = [
  "economics.get_client_economics",
  "economics.get_campaign_economics",
  "economics.get_costs",
  "economics.get_revenue",
  "economics.get_roi",
  "attribution.get_revenue_attribution",
  "workflow.get_task",
  "workflow.list_tasks",
  "workflow.get_pending_approvals",
  "workflow.get_activity",
] as const;
const writes = [
  "workflow.create_task",
  "workflow.assign_task",
  "workflow.complete_task",
  "workflow.create_approval",
] as const;
export const financeController = {
  bot_id: "bot_finance",
  reads,
  writes,
  grants: [...reads, ...writes],
  expectedDiscovery: [...reads, ...writes],
  forbidden: [
    "security",
    "engineering",
    "pipeline",
    "sales_agents",
    "content",
    "admin",
    "delivery",
    "campaign",
    "finance",
    "deploy",
    "infra",
    "secrets",
    "workflow.record_decision",
    "pipeline.record_sale",
    "sales_agents.deploy",
    "attribution.get_campaign_performance",
    "attribution.generate_report",
  ],
  future: [
    "pipeline.record_sale",
    "attribution.get_content_performance",
    "attribution.get_conversion_funnel",
    "attribution.generate_report",
  ] as string[],
  connector: {
    ...chiefOfStaff.connector,
    args: [...chiefOfStaff.connector.args],
  },
  contractSteps: [4, 5, 6, 7, 8, 9, 10],
} as const;

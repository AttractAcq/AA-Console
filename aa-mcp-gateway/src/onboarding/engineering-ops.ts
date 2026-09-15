import { chiefOfStaff } from "./chief-of-staff.js";
/** Phase 14 locked surface. Declaration only: no provisioning. */
const reads = [
  "engineering.get_issue",
  "engineering.get_release_status",
  "engineering.get_deployment_status",
  "workflow.get_task",
  "workflow.list_tasks",
  "workflow.get_pending_approvals",
  "workflow.get_activity",
] as const;
const writes = [
  "engineering.create_issue",
  "workflow.create_task",
  "workflow.assign_task",
  "workflow.complete_task",
  "workflow.create_approval",
] as const;
export const engineeringOps = {
  bot_id: "bot_engineering",
  reads,
  writes,
  grants: [...reads, ...writes],
  expectedDiscovery: [...reads, ...writes],
  forbidden: [
    "economics",
    "security",
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
    "railway",
    "sites",
    "brand",
    "workflow.record_decision",
    "pipeline.record_sale",
    "sales_agents.deploy",
  ],
  future: [
    "sales_agents.deploy",
    "security.get_system_status",
    "security.get_open_findings",
    "security.create_finding",
    "security.get_incident_status",
  ] as string[],
  connector: {
    ...chiefOfStaff.connector,
    args: [...chiefOfStaff.connector.args],
  },
  contractSteps: [4, 5, 6, 7, 8, 9, 10],
} as const;

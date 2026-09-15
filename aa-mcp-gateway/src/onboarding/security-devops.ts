import { chiefOfStaff } from "./chief-of-staff.js";
/** Phase 15 locked surface. Declaration only: no provisioning. */
const reads = [
  "security.get_system_status",
  "security.get_open_findings",
  "security.get_incident_status",
  "engineering.get_release_status",
  "engineering.get_deployment_status",
  "workflow.get_task",
  "workflow.list_tasks",
  "workflow.get_pending_approvals",
  "workflow.get_activity",
] as const;
const writes = [
  "security.create_finding",
  "workflow.create_task",
  "workflow.assign_task",
  "workflow.complete_task",
  "workflow.create_approval",
] as const;
export const securityDevops = {
  bot_id: "bot_security_devops",
  reads,
  writes,
  grants: [...reads, ...writes],
  expectedDiscovery: [...reads, ...writes],
  forbidden: [
    "economics",
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
    "destroy",
    "rotate",
    "workflow.record_decision",
    "pipeline.record_sale",
    "sales_agents.deploy",
    "engineering.create_issue",
    "engineering.get_issue",
  ],
  future: [
    "sales_agents.deploy",
    "engineering.create_issue",
  ] as string[],
  connector: {
    ...chiefOfStaff.connector,
    args: [...chiefOfStaff.connector.args],
  },
  contractSteps: [4, 5, 6, 7, 8, 9, 10],
} as const;

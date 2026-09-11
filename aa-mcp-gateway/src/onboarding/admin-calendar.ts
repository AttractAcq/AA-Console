import { chiefOfStaff } from "./chief-of-staff.js";
/** Phase 12 locked surface. Declaration only: no provisioning. */
const reads = [
  "delivery.list_clients",
  "delivery.get_client",
  "delivery.get_status",
  "workflow.get_task",
  "workflow.list_tasks",
  "workflow.get_pending_approvals",
  "workflow.get_activity",
  "admin.list_events",
  "admin.get_event",
] as const;
const writes = [
  "workflow.create_task",
  "workflow.assign_task",
  "workflow.complete_task",
  "workflow.create_approval",
  "admin.create_event",
  "admin.update_event",
] as const;
export const adminCalendar = {
  bot_id: "bot_admin",
  reads,
  writes,
  grants: [...reads, ...writes],
  expectedDiscovery: [...reads, ...writes],
  forbidden: [
    "economics",
    "security",
    "engineering",
    "pipeline",
    "sales_agents",
    "content",
    "workflow.record_decision",
  ],
  connector: {
    ...chiefOfStaff.connector,
    args: [...chiefOfStaff.connector.args],
  },
  contractSteps: [4, 5, 6, 7, 8, 9, 10],
} as const;

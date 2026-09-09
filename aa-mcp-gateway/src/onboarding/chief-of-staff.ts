/** Reference onboarding definition; contains no credentials and provisions nothing. */
export const chiefOfStaff = {
  bot_id: "bot_chief_of_staff",
  grants: ["delivery.*", "campaign.*", "workflow.*", "attribution.*"],
  forbidden: [
    "economics",
    "security",
    "engineering",
    "pipeline",
    "sales_agents",
    "workflow.record_decision",
  ],
  reads: [
    "delivery.list_clients",
    "delivery.get_status",
    "delivery.get_blockers",
    "delivery.get_client_health",
    "workflow.get_pending_approvals",
    "workflow.get_activity",
    "workflow.list_tasks",
    "workflow.get_task",
    "campaign.list",
    "campaign.get",
    "campaign.get_status",
    "attribution.get_campaign_performance",
  ],
  writes: [
    "workflow.create_task",
    "workflow.assign_task",
    "workflow.complete_task",
  ],
  connector: {
    command: "npx",
    args: [
      "-y",
      "mcp-remote",
      "https://mcp.attractacq.com/mcp",
      "--header-file",
      "<private-header-file>",
    ],
  },
  contractSteps: [4, 5, 6, 7, 8, 9, 10],
} as const;

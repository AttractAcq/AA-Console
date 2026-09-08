import type { Bot, Identity, Tool } from "../shared/types.js";
const workflow = [
  "workflow.create_task",
  "workflow.assign_task",
  "workflow.get_task",
  "workflow.list_tasks",
  "workflow.complete_task",
  "workflow.create_approval",
  "workflow.get_pending_approvals",
  "workflow.get_activity",
];
export const grants: Record<Bot, string[]> = {
  bot_chief_of_staff: [
    "delivery.*",
    "campaign.*",
    "workflow.*",
    "attribution.*",
  ],
  bot_client_delivery: [
    "delivery.*",
    "workflow.*",
    "campaign.get",
    "campaign.get_status",
    "content.get_production_status",
  ],
  bot_marketing: [
    "campaign.*",
    "content.*",
    "conversion.*",
    "proof.*",
    "attribution.*",
    ...workflow,
  ],
  bot_production: [
    "content.*",
    "proof.search",
    "proof.get",
    "proof.get_for_avatar",
    "proof.get_for_claim",
    ...workflow,
  ],
  bot_distribution: [
    "content.get_brief",
    "content.get_production_status",
    "content.queue_distribution",
    "content.get_performance",
    "attribution.get_content_performance",
    ...workflow,
  ],
  bot_sales_ops: [
    "pipeline.*",
    "sales_agents.*",
    "proof.search",
    "proof.get",
    ...workflow,
  ],
  bot_admin: ["delivery.list_clients", "delivery.get_client", ...workflow],
  bot_finance: [
    "economics.*",
    "attribution.get_revenue_attribution",
    ...workflow,
  ],
  bot_engineering: ["engineering.*", ...workflow],
  bot_security_devops: [
    "security.*",
    "engineering.get_release_status",
    "engineering.get_deployment_status",
    ...workflow,
  ],
};
/** Exact tool name, or single-segment domain wildcard (`content.*` → `content.<one segment>`). */
export function permissionMatches(grant: string, permission: string): boolean {
  if (grant === permission) return true;
  if (!/^[a-z0-9_]+\.\*$/.test(grant)) return false;
  const prefix = grant.slice(0, -1);
  if (!permission.startsWith(prefix)) return false;
  const rest = permission.slice(prefix.length);
  return rest.length > 0 && !rest.includes(".");
}

export function grantPatterns(identity: Identity): string[] {
  return Array.isArray(identity.permissions)
    ? identity.permissions
    : grants[identity.bot];
}

export function allowed(botOrIdentity: Bot | Identity, tool: Tool): boolean {
  if (tool.name === "workflow.record_decision") return false; // human-only API, never discoverable by Bots
  const identity: Identity =
    typeof botOrIdentity === "string"
      ? { bot: botOrIdentity, clients: [] }
      : botOrIdentity;
  const patterns = grantPatterns(identity);
  return tool.permissions.every((permission) =>
    patterns.some((g) => permissionMatches(g, permission)),
  );
}

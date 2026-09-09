import { marketingDirector } from "../onboarding/marketing-director.js";
import { distributionManager } from "../onboarding/distribution-manager.js";
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
  bot_marketing: [...marketingDirector.grants],
  bot_production: [
    "content.*",
    "proof.search",
    "proof.get",
    "proof.get_for_avatar",
    "proof.get_for_claim",
    ...workflow,
  ],
  bot_distribution: [...distributionManager.grants],
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

/**
 * Sec Phase 9b Alex CLEAR (2026-09-09): Bot idea-approve / asset-decide is
 * bot_production only. bot_marketing already holds `content.*` for its other
 * real content tools, so this cannot be expressed by withholding a grant —
 * it is a hard, non-grant-based deny, evaluated before the pattern match,
 * exactly like the `workflow.record_decision` line below. A future PR that
 * wants to extend either tool to another Bot must change this set and go
 * through Sec again; it cannot happen by adding a permission row.
 */
export const PRODUCTION_ONLY_TOOLS = new Set([
  "content.select_idea",
  "content.approve_asset",
]);
/**
 * Sec Phase 10 Alex CLEAR (2026-09-09): distribution schedule/publication
 * writes are bot_distribution only. bot_production already holds `content.*`
 * for its other real content tools, so this cannot be expressed by
 * withholding a grant either — same hard, non-grant-based deny pattern as
 * PRODUCTION_ONLY_TOOLS above.
 */
export const DISTRIBUTION_ONLY_TOOLS = new Set([
  "content.queue_distribution",
  "content.record_publication",
]);
export function allowed(botOrIdentity: Bot | Identity, tool: Tool): boolean {
  // Sec Phase 5 #5 / Phase 3–4 locked: hard-deny stays in gateway code forever.
  if (tool.name === "workflow.record_decision") return false; // human-only API, never discoverable by Bots
  const identity: Identity =
    typeof botOrIdentity === "string"
      ? { bot: botOrIdentity, clients: [] }
      : botOrIdentity;
  if (PRODUCTION_ONLY_TOOLS.has(tool.name) && identity.bot !== "bot_production")
    return false;
  if (DISTRIBUTION_ONLY_TOOLS.has(tool.name) && identity.bot !== "bot_distribution")
    return false;
  // Locked Marketing/Distribution ceilings also constrain stale/overbroad
  // database grants (Alex CLEAR Phase 10 #4: exact allowlist like Marketing).
  if (identity.bot === "bot_marketing" &&
      !marketingDirector.grants.some((name) => name === tool.name)) return false;
  if (identity.bot === "bot_distribution" &&
      !distributionManager.grants.some((name) => name === tool.name)) return false;
  const patterns = grantPatterns(identity);
  return tool.permissions.every((permission) =>
    patterns.some((g) => permissionMatches(g, permission)),
  );
}

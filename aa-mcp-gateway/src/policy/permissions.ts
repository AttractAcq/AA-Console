import { adminCalendar } from "../onboarding/admin-calendar.js";
import { engineeringOps } from "../onboarding/engineering-ops.js";
import { marketingDirector } from "../onboarding/marketing-director.js";
import { distributionManager } from "../onboarding/distribution-manager.js";
import { salesOps } from "../onboarding/sales-ops.js";
import { financeController } from "../onboarding/finance-controller.js";
import { securityDevops } from "../onboarding/security-devops.js";
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
  bot_sales_ops: [...salesOps.grants],
  bot_admin: [...adminCalendar.grants],
  bot_finance: [...financeController.grants],
  bot_engineering: [...engineeringOps.grants],
  bot_security_devops: [...securityDevops.grants],
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
/**
 * Phase 14: issue create/get are bot_engineering only. Status reads stay
 * callable by bot_security_devops via its existing exact grants. A blanket
 * engineering-domain deny would hide those two status tools from Security.
 */
export const ENGINEERING_ISSUE_TOOLS = new Set([
  "engineering.create_issue",
  "engineering.get_issue",
]);
export const ENGINEERING_STATUS_TOOLS = new Set([
  "engineering.get_release_status",
  "engineering.get_deployment_status",
]);
/**
 * Phase 15: every security.* tool is bot_security_devops only. A stale
 * security.* wildcard on any other bot must not widen discovery/call.
 */
export const SECURITY_TOOLS = new Set([
  "security.get_system_status",
  "security.get_open_findings",
  "security.create_finding",
  "security.get_incident_status",
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
  if (
    DISTRIBUTION_ONLY_TOOLS.has(tool.name) &&
    identity.bot !== "bot_distribution"
  )
    return false;
  // Locked Marketing/Distribution ceilings also constrain stale/overbroad
  // database grants (Alex CLEAR Phase 10 #4: exact allowlist like Marketing).
  if (
    identity.bot === "bot_marketing" &&
    !marketingDirector.grants.some((name) => name === tool.name)
  )
    return false;
  if (
    identity.bot === "bot_distribution" &&
    !distributionManager.grants.some((name) => name === tool.name)
  )
    return false;
  // Phase 11 Alex CLEAR / SEC_BAR #1: exact allowlist ceiling for Sales Ops,
  // same pattern as Marketing/Distribution above. Constrains stale/overbroad
  // database grants too (e.g. a leftover pipeline.*/sales_agents.* row).
  if (
    identity.bot === "bot_sales_ops" &&
    !salesOps.grants.some((name) => name === tool.name)
  )
    return false;
  if (tool.domain === "admin" && identity.bot !== "bot_admin") return false;
  if (
    identity.bot === "bot_admin" &&
    !adminCalendar.grants.some((name) => name === tool.name)
  )
    return false;
  if (tool.domain === "economics" && identity.bot !== "bot_finance")
    return false;
  if (
    identity.bot === "bot_finance" &&
    !financeController.grants.some((name) => name === tool.name)
  )
    return false;
  if (tool.domain === "engineering") {
    if (identity.bot === "bot_engineering") {
      // Exact ceiling below.
    } else if (
      identity.bot === "bot_security_devops" &&
      ENGINEERING_STATUS_TOOLS.has(tool.name)
    ) {
      // Existing exact grants; Phase 15 may tighten this.
    } else {
      return false;
    }
  }
  if (
    identity.bot === "bot_engineering" &&
    !engineeringOps.grants.some((name) => name === tool.name)
  )
    return false;
  if (ENGINEERING_ISSUE_TOOLS.has(tool.name) && identity.bot !== "bot_engineering")
    return false;
  if (tool.domain === "security" && identity.bot !== "bot_security_devops")
    return false;
  if (
    identity.bot === "bot_security_devops" &&
    !securityDevops.grants.some((name) => name === tool.name)
  )
    return false;
  if (SECURITY_TOOLS.has(tool.name) && identity.bot !== "bot_security_devops")
    return false;
  const patterns = grantPatterns(identity);
  return tool.permissions.every((permission) =>
    patterns.some((g) => permissionMatches(g, permission)),
  );
}

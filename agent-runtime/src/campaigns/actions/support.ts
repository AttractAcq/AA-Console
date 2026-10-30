/**
 * Compare the database's support claims with handlers in this runtime build.
 * This is deliberately narrower than account, approval or deployment health:
 * a registered handler only means that this process has code for the action.
 */
export interface CampaignActionCapability {
  key: string;
  module: string;
  supported: boolean;
  handlerRegistered: boolean;
}

// The baseline keys in migration 230's database constraint and seed. A
// partial PostgREST response must not hide a supported key without a handler.
const REQUIRED_KEYS = [
  "campaign_launch", "meta_ad_build", "google_ad_build", "organic_publish",
  "proof_publish", "page_deploy", "lead_message", "profile_update", "budget_change",
] as const;

export function inspectCampaignActionRegistry(
  rows: unknown,
  handlerKeys: ReadonlySet<string>,
): { actions: CampaignActionCapability[]; unhandledSupportedKeys: string[] } {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error("Campaign action registry is missing or invalid.");
  }

  const seen = new Set<string>();
  const actions = rows.map((raw): CampaignActionCapability => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("Campaign action registry is missing or invalid.");
    }
    const row = raw as Record<string, unknown>;
    const key = row.action_key;
    const module = row.executor_module;
    if (typeof key !== "string" || !/^[a-z][a-z0-9_]*$/.test(key) ||
        typeof module !== "string" || !/^[a-z][a-z0-9_]*$/.test(module) ||
        typeof row.supported !== "boolean" || seen.has(key)) {
      throw new Error("Campaign action registry is missing or invalid.");
    }
    seen.add(key);
    return {
      key,
      module,
      supported: row.supported,
      handlerRegistered: handlerKeys.has(key),
    };
  });
  if (REQUIRED_KEYS.some((key) => !seen.has(key))) {
    throw new Error("Campaign action registry is missing or invalid.");
  }

  return {
    actions,
    unhandledSupportedKeys: actions.filter((action) =>
      action.supported && !action.handlerRegistered).map((action) => action.key),
  };
}

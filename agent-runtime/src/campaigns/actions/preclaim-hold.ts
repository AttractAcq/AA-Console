/**
 * Migration 325 provides an atomic claim, but no deployed build is released
 * merely because the SQL exists. The second runtime flag remains off until
 * the build, handler registry, heartbeat and external outcome are validated.
 *
 * A job parameter or support bit cannot bypass the explicit release and
 * matching deployed-build checks.
 */
export const GENERIC_CAMPAIGN_ACTION_CLAIM_HOLD =
  "Campaign action claims are held pending release of the owned claim path. An Approval Inbox decision or CAMPAIGN_ACTIONS_ENABLED alone does not release this hold.";

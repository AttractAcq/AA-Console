/**
 * Migration 230's claim_campaign_actions(integer) has no action-key filter.
 * A separate registry read cannot stop a support flag from changing between
 * that read and the claim. Keep this runtime entry point closed until a
 * single SQL transaction validates handler ownership, the exact Inbox
 * decision and the due action while it takes the claim locks.
 *
 * There is deliberately no environment, job-parameter or support-bit bypass.
 */
export const GENERIC_CAMPAIGN_ACTION_CLAIM_HOLD =
  "Generic campaign action claims are held: the released SQL claim function has no atomic action-key and handler-ownership gate. An exact-version Approval Inbox decision, a supported registry row, or CAMPAIGN_ACTIONS_ENABLED does not release this hold.";

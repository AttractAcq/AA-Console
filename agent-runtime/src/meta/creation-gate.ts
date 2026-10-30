/**
 * Meta object creation is an external write even when every object is PAUSED.
 *
 * The legacy client builder and AA recruitment builder can both be queued
 * through the authenticated generic enqueue RPC. Neither route has an
 * exact-version AAL2 Approval Inbox decision or a last-moment execution
 * verifier. Keep their queued jobs visible but refuse to load credentials or
 * call Meta until B010/B012 replace this hold with a verified prewrite gate.
 * There is deliberately no runtime flag or caller-provided override.
 */
export function metaCreationPrewriteProblem(): string | null {
  return "Meta object creation is held until an exact-version AAL2 Approval Inbox decision and last-moment prewrite verification are connected. Use the read-only build sheet; this job remains recorded for review.";
}

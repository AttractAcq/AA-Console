/**
 * A profile PATCH is an external write. The older profile-change approval
 * records in migrations 240/241/254 are not bound to an exact AAL2 Approval
 * Inbox decision or a last-moment source/version/account check. A global
 * campaign-action switch must not turn those records into provider writes.
 *
 * This hold has no environment or job-parameter override. Replace it only
 * when the owning profile source, Inbox decision and prewrite verifier are
 * connected and tested together.
 */
export const PROFILE_FIELD_PATCH_HOLD =
  "Profile field updates are held until an exact-version AAL2 Approval Inbox decision and last-moment prewrite verification are connected. Approval records a proposal; it does not apply a profile field change.";

export function profileUpdatePrewriteProblem(): string | null {
  return `${PROFILE_FIELD_PATCH_HOLD} No profile change was claimed.`;
}

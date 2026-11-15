/**
 * A profile PATCH is an external write. The older profile-change approval
 * records in migrations 240/241/254 predate exact AAL2 Inbox decisions.
 * New proposal decisions and local prewrite predicates now exist, but no
 * one-shot profile PATCH claim and outcome receipt has been released. A
 * global campaign-action switch must not turn older records into writes.
 *
 * This hold has no environment or job-parameter override. Replace it only
 * when the owning profile source, Inbox decision and prewrite verifier are
 * connected and tested together.
 */
export const PROFILE_FIELD_PATCH_HOLD =
  "Profile field updates are held. The exact-version AAL2 Approval Inbox decisions and local prewrite checks exist, but no one-shot provider writer and readback receipt is released. Approval records a proposal; it does not apply a profile field change.";

export function profileUpdatePrewriteProblem(): string | null {
  return `${PROFILE_FIELD_PATCH_HOLD} No profile change was claimed.`;
}

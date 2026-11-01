# B005 Q022: conditional current employee role entitlement

Migration 298 is a held prototype. Do not apply it until Alex decides Q022,
recovery evidence is available for Q019, and migrations 283–300 are released
in order. It does not enable an external provider or change a publishing
switch.

## Proposed identity rule

An active `team_members` row and its `client_assignments` or
`job_assignments` grant employee authority only while the linked account's
current `profiles.role` is `employee`. A user whose profile is `client` keeps
their own `client_users` entitlement under migration 299, but a stale team row
does not make them an editor, SMM, creative director, or assignee. An admin
still has separate administrator access. Service and cron lookups resolve a
valid employee assignment without requiring a human JWT.

This is the reverse of migration 299, which makes `client_users` require a
current client profile. Neither migration removes historical rows. If Alex
chooses legitimate dual-role accounts, provision an explicit scoped model
instead of applying 296 or 298.

## Route matrix audited

| Route | Before 298 with `profiles.role='client'` plus an active team row | Held 298 behavior |
| --- | --- | --- |
| `can_access_client`, `accessible_client_ids` | Client/job assignments grant broad other-client access | Only current employee assignments count; same-client `client_users` and admin branches remain |
| `is_member`, `current_member_id` | Team row grants self-scoped table and Storage policies | Only current employee rows count; inactive and profileless accounts remain denied |
| `team_members_self_read` | Client profile can read its linked team row | Current employee role required; admin policy remains separate |
| `clients_former_assignee_read` | Client profile with an ended assignment can see a former client's identity | Current employee role required; an active employee's past-client identity remains available |
| `is_active_assigned_smm` | Client profile SMM can read the editor roster | Current employee role required |
| `active_video_approval_manager` | Client profile can become an SMM for video, proof, pages, content and Storage policies/RPCs | Latest active SMM must have current employee role; invalid latest seat returns `NULL` instead of reviving an older assignee |
| `active_creative_director` / `creative_seat_of` | Client profile can gain creative director approval seat | Latest active director must have current employee role; invalid latest seat returns `NULL` |
| Video finalization trigger | A profile can change role after an SMM signoff and before final approval | Lock the latest active SMM assignment, team row and employee profile at the final write; preserve migration 299's nominated-client lock |
| `is_channel_member` | Explicit channel membership allows client chat access | Unchanged: client chat membership is intentional and independent of team assignment |
| Sales entitlement helpers | `is_eligible_lead_owner` already checks the bound user's employee profile | Unchanged |

The resolver functions are shared by RLS and named RPCs across video edit,
creative review, proof capture/distribution, offer studio, GBP/reply,
lead magnets, pages, motion scenes, campaign actions and the canonical Inbox
owner route. Changing the helpers avoids per-page exceptions. The live
assignment action RPCs still check `is_member` through their internal state
machine. The `client-media` and `proof` upload policies use
`can_access_client`, so this also removes a cross-client upload inherited
from a stale team assignment while preserving the client's own folder.

## Verification and limits

`agent-runtime/src/public/employee-role-entitlement.pg.test.ts` applies the
actual 298 SQL to a disposable database with pre-298 functions and policies.
It proves the old client-profile SMM path, then tests cross-client table and
Storage denial, same-client rights, employee job access, admin scope,
service/cron resolver behavior, latest-invalid-seat behavior, video manager
RPC denial, direct finalization rejection, profile drift, and anonymous and
profileless denial. The repository schema replay must also pass clean and
upgrade paths, generated types and catalog parity before review.

Migration 28 describes former client identity for past assignees. After
migration 127, its policy subquery is itself limited by assignment RLS, so an
inactive retired team member cannot currently read that identity. 298
preserves the effective behavior: an **active** employee with an ended
assignment can still see the former client's identity; a retired employee
cannot. Changing retired-history visibility requires a separate business
decision and a security-definer path, and is outside Q022.

The `media_obj_employee_insert` policy currently uses broad
`can_access_client`; thus a current client user can still upload into their
own client folder even though the policy name says employee. That existing
same-client behavior is preserved here. Whether upload roles should split is
a separate product/ACL decision.

---

*Migration numbers in this document refer to the released labels. The nineteen migrations integrated by #297 were renumbered from their original 280–298 to 283–301; references here were corrected on 1 November 2026. See `V6_MERGE_ARCHIVE_RECORD.md`.*

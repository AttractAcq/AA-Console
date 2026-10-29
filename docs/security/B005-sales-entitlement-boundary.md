# B005 sales entitlement boundary (migration 267)

This is a reviewable, dormant sales-seat contract. Applying migration 267 does
not enable employee Sales OS access. The only current production grant is
`client_sales_entitlement_controls.inbox_enforced = false`, so an admin's
approved request remains ineffective until B008 connects the exact decision
to the unified Approval Inbox and changes the switch in a reviewed migration.

## Identity and scope

An entitlement binds one `client_id`, one `team_members.id`, and that member's
current `profiles.id` (`bound_user_id`). The member must be active, linked to a
profile with `role = employee`, and have an approved grant request. Neither a
job assignment nor an SMM client assignment is a sales grant. Existing team
categories remain unchanged; a person doing two jobs needs an explicit sales
grant for each client. That avoids giving every editor commercial data.

`request_client_sales_entitlement` and `decide_client_sales_entitlement` are
administrator-only security-definer RPCs. The request stores the exact
client/member/user/action hash. A decision must present that hash; it records
the human actor, time, status, and note. The decision RPC requires the signed
Supabase JWT to carry MFA assurance level `aal2`; an `aal1` admin cannot decide.
An approved revoke is immediately
effective. Retired or relinked members can still be revoked against the
original bound identity. Tables allow no direct authenticated write path.

An approved grant is effective only when **all** of these are true:

1. `inbox_enforced` has been enabled by a later, reviewed migration.
2. `inbox_decision_id` identifies a real unified Inbox decision that B008
   binds with a database foreign key and the same request ID and scope hash.
3. The stored grant request is approved for the same client, member, bound
   user, and `grant` action, and its hash still matches the canonical scope.
4. The grant is not revoked and the bound employee/member identity is still
   active and linked.

Migration 267 implements conditions 1, 3, and 4 and leaves conditions 1 and 2
false. B008 must add the Inbox relation/check for condition 2 before switching
condition 1 on. It must not turn the switch on for historical decisions that
were never displayed and approved in that Inbox; require a fresh Inbox decision
or an explicit migration audit and reapproval for each grant. The fixture test
simulates conditions 1 and 2 with privileged SQL only in disposable PGlite.

## Access matrix

| Actor | Lead rows and actions | Commercial reporting RPCs | Eligible owner | Why |
| --- | --- | --- | --- | --- |
| Administrator | All clients | All clients | Only a live sales-granted member for that lead's client | Existing administrator route; owner guard applies equally |
| Client user | Own client(s) | Own client(s) | Only a live sales-granted member for that lead's client | Existing client membership route |
| Service role | Trusted service RPCs | Trusted service RPCs | Only a live sales-granted member for that lead's client | Existing service route; owner guard applies equally |
| Employee with creative/job assignment only | None | None | No | `can_access_client` is not a sales grant |
| Employee with exact approved grant and Inbox binding | Granted client only | Granted client only | Yes, for that client | Explicit sales entitlement |
| Employee with grant while switch off, revoked grant, changed identity, or retired member | None | None | No | Every live check fails closed |
| Anonymous or unrelated client | None | None | No | No role or client entitlement |

The lead owner picker calls `list_client_lead_owners(client_id)`. It returns
only members who satisfy the live entitlement for the same client, exposing
only ID and display name. The database trigger checks the same predicate on
new or changed `owner_member_id`, including admin and service writes. Existing
historical owner IDs remain readable; editing unrelated fields does not
silently reassign them. The UI omits an unchanged owner from `update_lead`.

The client Add Lead form calls `create_manual_lead`. Direct client and employee
INSERT on `client_leads` has no RLS policy. The RPC accepts identity, follow-up,
owner, and nonnegative forecast value only. It always starts at
`profile_visit`, records `source = manual_entry`, and leaves sale, cash,
appointment outcome, consent, probe, and attribution fields neutral. A later
stage change uses `advance_lead` so its event is recorded. Existing trusted
service producers and the administrator table policy keep their write paths.

## Follow-on work

- B008: add a real unified Inbox record and immutable FK/hash validation for
  `inbox_decision_id`; expose grant/revoke requests and decisions in one queue;
  then enable `inbox_enforced` only after a reviewed release and fresh decisions.
- B005: add an administrator provisioning view for sales grants, a dedicated
  employee Sales console route that uses explicit client scope, and permission
  tests for its navigation and lead capture/submission panels. Keep the route
  closed until the Inbox gate is live.
- B005: review related lead-linked tables and older views beyond the core
  lead, event, archive, identity, and reporting surfaces covered here. In
  particular, migration 235's `lead_submissions_read` exposes contact and
  consent details through `can_access_client`; migration 236's
  `lead_magnet_deliveries_read` exposes recipient addresses; migration 251's
  `lead_sequence_enrollments_read`, migration 248's `outbound_messages_read`,
  and migration 257's `dm_messages_read` also use that broad helper. Narrow
  these in a subsequent B005 slice and test generic creative assignees versus
  same-client sales actors. The `lead_pipeline_counts` view is changed to
  `security_invoker` in 267.
- R000/B003: run full clean and upgrade schema replay in CI, generate database
  types from the resulting schema, and verify production SQL/version evidence
  through the release gate before applying any migration.

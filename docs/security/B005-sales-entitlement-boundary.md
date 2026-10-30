# B005 sales entitlement boundary (migrations 267–269)

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
An approved revoke is immediately effective. Retired or relinked members can
still be revoked against the original bound identity. A stale pending grant can
be rejected after its member retires or relinks; only approval rechecks current
membership. Tables allow no direct authenticated write path.

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
While the B008 Inbox binding is absent, the picker is empty and no new owner
can be assigned. The read-only production preflight on 29 October 2026 found
zero `client_leads`, so this temporary freeze did not strand an existing lead
there; verify the count again immediately before release.
On archive recovery, a still eligible owner is retained. A retired or revoked
historical owner is cleared and a lead event records its prior ID, so recovery
succeeds without silently reviving access.

The client Add Lead form calls `create_manual_lead`. Direct client and employee
INSERT on `client_leads` has no RLS policy. The RPC accepts identity, follow-up,
owner, and nonnegative forecast value only. It always starts at
`profile_visit`, records `source = manual_entry`, and leaves sale, cash,
appointment outcome, consent, probe, and attribution fields neutral. A later
stage change uses `advance_lead` so its event is recorded. Existing trusted
service producers and the administrator table policy keep their write paths.

## Contact and conversation reads (migration 268)

The same sales permission contract now governs SELECT on the ten tables that
hold contact, consent, scheduling, delivery, send, or message history:

| Table | Protected data |
| --- | --- |
| `lead_submissions` | Submitted contact and consent evidence |
| `lead_magnet_deliveries` | Recipient addresses and delivery status |
| `lead_sequence_enrollments` | Lead follow-up state |
| `workflow_lead_attribution` | Lead IDs, attribution labels, and evidence tied to a workflow run |
| `lead_suppressions` | Recipient address and suppression reason |
| `outbound_messages` | Recipient, body, transport, and result |
| `client_appointments` | Lead booking and attendance |
| `dm_identities` | Social identity and contact link |
| `dm_conversations` | DM thread identity and state |
| `dm_messages` | DM content and send/receive history |

`can_read_client_sales_data` delegates to `may_manage_client_leads`: admin,
same-client user, service role, and a live explicitly entitled sales employee.
A generic job assignment no longer reads these tables. The existing
`sales_agent_conversations` admin/client policy remains, with a separate
same-client sales policy and explicit table SELECT grant. The sales path stays
dormant while `inbox_enforced` is false. PGlite checks the prior assigned-editor
exposure, the new denial on all ten tables, cross-client isolation, service
reads, and retirement/revocation after a fixture-only Inbox bridge. The
workflow attribution policy resolves `client_id` from `workflow_runs` inside
`can_read_workflow_lead_attribution`, a narrow security-definer scope helper.
The existing `workflow_runs` RLS admits creative assignment but a sales-only
employee may have no such assignment. The fixture uses that real run policy
and verifies sales attribution visibility without granting direct run rows.

Migration 268 also redefines four security-definer RPCs that bypass table RLS:
`dm_reply_refusal_v6`, `close_dm_conversation_v6`, `merge_dm_lead_v6`, and
`queue_lead_message_v6`. They now require the same client sales permission
before returning thread details, mutating a conversation, or queueing a
person-specific message. An unauthorized refusal check returns the same
generic result as an unknown conversation ID. The DM PGlite fixture proves
an assigned editor cannot use any of the four, while client, service, and a
fixture-only live sales member retain scoped operations.

`lead_capture_endpoints`, `booking_links`, message templates, sequence
templates, and booking window/settings tables retain their existing policies;
they hold configuration or hashed tokens rather than a prospect's contact or
conversation. Review their commercial sensitivity separately before opening
an employee Sales console.

## Authenticated RPCs (migration 269)

Security-definer RPCs can bypass the table policies above. Migration 269
replays the latest definitions of these authenticated entry points with
`may_manage_client_leads` in place of broad job-assignment access:

| RPC | Private operation or returned data | New boundary |
| --- | --- | --- |
| `suppress_lead_v6` | Suppress a person's dedupe key | Admin, same-client user, active granted sales member, service |
| `sequence_exit_reason_v6` | Reveal lead consent, suppression, and stage exit reason | Same client as the sequence and lead; unauthorized sequence IDs yield the same generic result as missing ones |
| `enroll_lead_in_sequence_v6` | Create/read a person's sequence enrollment | Same client sales permission, with the existing approved-sequence and exit checks |
| `exit_lead_from_sequence_v6` | Change a person's enrollment | Same client sales permission |
| `book_appointment_v6` | Take a slot and advance a lead | A signed-in permitted person for `person`; only service for `public_link` and `sales_agent` routes |
| `record_appointment_outcome_v6` | Change attendance and lead stage | Same client sales permission |
| `create_booking_link_v6` | Create a booking capability and return its hash | Same client sales permission |
| `capture_sales_agent_lead` | Turn a conversation into a lead, or return its linked lead ID | Same client sales permission; trusted runtime and gateway still work as service |
| `workflow_run_outcomes` | Return lead counts and collected cash in a workflow report | Same client sales permission |

Booking and booking-link creation reject a campaign ID belonging to another
client. `book_appointment_v6` checks the effective ID after applying the
lead's saved `source_client_campaign_id` fallback; an old foreign source ID
cannot silently enter an appointment. `queue_lead_message_v6` makes the same
check after choosing the template's campaign or the lead's fallback, before
inserting an outbound message. `create_message_template_v6` checks the
author-supplied campaign before saving the template. These checks do not
change message approval or the human Inbox gate.

Migration 269 adds `NOT VALID` same-client composite foreign keys to
`client_leads`, `client_appointments`, `outbound_messages`,
`message_templates`, `booking_links`, and `lead_capture_endpoints`. PostgreSQL
enforces these on new writes, including direct trusted-service writes, and
preserves `ON DELETE SET NULL` for only the campaign column. Historical
cross-client links are retained for explicit audit rather than silently
rewriting attribution. They must be inspected, repaired with an audit trail,
and the constraints validated before the 100/100 release gate. The fixture
proves a preexisting mismatch survives for audit, new mismatches are rejected
at all six tables, and deleting a valid campaign clears only its ID.

Read-only historical audit before validation:

```sql
with links as (
  select 'client_leads' as source, id, client_id,
         source_client_campaign_id as campaign_id from public.client_leads
  union all select 'client_appointments', id, client_id, campaign_id
    from public.client_appointments
  union all select 'outbound_messages', id, client_id, campaign_id
    from public.outbound_messages
  union all select 'message_templates', id, client_id, campaign_id
    from public.message_templates
  union all select 'booking_links', id, client_id, campaign_id
    from public.booking_links
  union all select 'lead_capture_endpoints', id, client_id, campaign_id
    from public.lead_capture_endpoints
)
select links.source, links.id, links.client_id, links.campaign_id,
       campaigns.client_id as campaign_client_id
  from links
  left join public.client_campaigns campaigns on campaigns.id = links.campaign_id
 where links.campaign_id is not null
   and campaigns.client_id is distinct from links.client_id;
```

`enqueue_sequence_sweep()` was callable by every authenticated user and could
start a global nurture worker. Its authenticated EXECUTE grant is revoked;
cron and the trusted service keep the call. The role matrix tests a broad
assigned editor against every RPC above, checks that an unapproved sales seat
is dormant, enables a fixture-only sales grant, then tests cross-client,
retirement, revocation, administrator, client, and service behavior. The test
also verifies the sweep function's database privilege.

The audit found no further authenticated security-definer lead/contact read
or mutation entry point using `can_access_client` after 267–269. The
remaining functions that touch lead/contact rows are service-only producer,
claim, webhook, and worker functions; manager-only approval revocation
functions; or the existing guarded lead actions in 265. `available_slots_v6`
returns appointment availability times without a person's identity or
contact details. `render_message_v6` formats a caller-supplied lead composite
and does not fetch a lead. The older broad definitions in historical
migrations are superseded by the later `CREATE OR REPLACE` definitions here.
This is a source audit, not evidence of a production deployment.

## Follow-on work

- B008: add a real unified Inbox record and immutable FK/hash validation for
  `inbox_decision_id`; expose grant/revoke requests and decisions in one queue;
  then enable `inbox_enforced` only after a reviewed release and fresh decisions.
- B005: add an administrator provisioning view for sales grants, a dedicated
  employee Sales console route that uses explicit client scope, and permission
  tests for its navigation and lead capture/submission panels. Keep the route
  closed until the Inbox gate is live.
- B005: treat 268 as a **partial dormant slice** unless 269 is applied and
  reviewed with it. Do not enable employee Sales access from the 268 table
  policies alone. `lead_pipeline_counts` is `security_invoker` from 267.
- B004/privacy: `proof_capture_submissions` holds submitted names and consent
  but still has broad assignment SELECT in migration 216. Review that
  adjacent proof workflow separately from lead/contact entitlements.
- R000/B003: run full clean and upgrade schema replay in CI, generate database
  types from the resulting schema, and verify production SQL/version evidence
  through the release gate before applying any migration.
- B005: inspect and repair historical campaign/client mismatches, then run
  `VALIDATE CONSTRAINT` for the six new composite foreign keys. Until then,
  new writes are guarded but historical attribution is a data-quality gate.
- B005 identity decision (held SQL follow-up): `is_client_user(target)` from
  migration 19 checks only `client_users` membership. It does not require the
  current `profiles.role` to be `client`. An `employee` profile with a surviving
  `client_users` row for client B therefore passes the client-user branch of
  `may_manage_client_leads(B)` and `can_read_client_sales_data(B)` without a
  B005 sales grant, even if the employee's job or client assignment ended.
  Decide whether such a dual employee/client identity is valid. If it is,
  provision and audit it as explicit client authority; otherwise require a
  current client profile role for this branch in every affected table, RPC,
  and Storage policy. Do not enable the employee Sales route on an implicit
  membership interpretation.

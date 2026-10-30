# B004 controlled invitations: integration and release contract

This dependent branch builds on B004 migration 283 and adds 284–286. It is a
review slice. No Auth invitation has been sent. Apply only after the released
B008 canonical approval ledger 273–279 and B006 280–282, then 283, in order.
The PGlite test replays the committed 273 and 279 migrations so invitation
source-state checks use the same adapter as the integrated source tree.

## Exact card and owning decision

Migration 284 creates a single `approval_requests_v6` card as part of the
owning request transaction. It has:

| Field | Frozen value |
| --- | --- |
| `source_system`, `source_kind` | `auth`, `console_invitation` |
| `client_id`, `owner_role` | `null` for employee or the exact target client ID for client invitations; `admin` (global Inbox) |
| `source_id` | Invitation request UUID |
| `source_version`, `artifact_hash` | Same SHA-256 of the immutable JSON payload |
| `destination`, `account_ref` | Normalized recipient email, configured Auth sender email |
| `preview` | Recipient, sender, role, member/client ID, team category and lifecycle generation, full name, Supabase project origin, sender verification ID and evidence SHA-256, complete Auth template subject/body and SHA-256, redirect origin, exact redirect URL including request ID, expiry |
| `scope` | Role and member/client target IDs |
| `owning_path` | `/approvals` |

The source decision RPC is
`decide_console_invitation_v6(p_request_id uuid, p_expected_source_version text,
p_expected_artifact_hash text, p_approved boolean, p_reason text default null)`.
It requires a provisioned human admin at AAL2; it locks the request, checks the
selected hash/version against the frozen card and current source, transitions
the owning request, and records the canonical event in the same transaction.
Reject requires a reason. It never sends email. Direct browser or service-role
calls to the canonical ledger helpers remain revoked.

The B008 global Inbox integration in this branch imports
`invitationApprovalBlocker`, `invitationCanApprove`, and `invitationCanReject`
from `src/lib/invitationApproval.ts`. Only a complete card with the
exact recipient, sender, template, redirect and target fields may expose an Approve
button. The global Inbox has a separate invitation decision branch for agency-null
employee cards and client-scoped client cards. It re-reads the selected card from
`approval_inbox_v6` by ID, compares every field with the selected version,
rechecks current AAL2, and calls the owning RPC above. Refresh card and decision
history after either result. Reject expired cards only with a reason. Keep all
other source classes read-only unless their own adapters are proven. Mark
class #34 green only after this UI integration and the runtime gates pass.
Migration 286 advances class #34 to source `verified`, decision `blocked`,
executor `blocked`; it does not claim operational coverage from mocked tests.

The Team panel links pending requests to the integrated `/approvals` route.

## Runtime and acceptance

`/admin/invitations/request` verifies the caller's Supabase user and JWT
claims, profile admin role and AAL2. It reads existing Auth users through the
Auth Admin API, including unverified users, before calling the trusted request
RPC. The SQL rechecks `auth.users` in its transaction. A used idempotency key
can only return the same frozen request. A different email or target conflicts.

`/admin/invitations/send` returns 503 before a claim, Auth operation, or email.
There is no autonomous invitation sweep. The old
`auth.admin.inviteUserByEmail` call was removed from the runtime because its
mutable Auth dashboard template cannot provide exact rendered-email approval.
The send claim and receipt SQL are inert foundations for the next executor.
Mocked claim/receipt tests do not authorize a production send. In particular,
an AAL2 approval of this card cannot authorize a future provider-controlled
email with different bytes or link semantics; that executor must register a
**new** frozen card/version and obtain a new AAL2 decision.

`/admin/invitations/inspect` reveals a minimal invitation preview only to the
exact invited Auth user ID and email. `/admin/invitations/accept` verifies that
session against Supabase Auth and passes the ID to migration 286. The database
requires matching confirmed Auth ID/email, a live sent request, active
unlinked target, and no existing profile. It creates the profile and roster or
client link in one transaction. Repeated acceptance by the same user is a
no-op; wrong user, expiry, cancellation or retired target grants nothing.
The browser page asks for explicit acceptance after showing role and recipient.

## Deployment gates and known follow-up

1. Verify the actual Supabase Auth SMTP sender account, then set
   `AUTH_INVITE_SENDER_EMAIL` to that exact address on `agent-runtime`. The
   request and send paths refuse to operate without a matching, unexpired row
   in `console_auth_sender_verifications_v6`. A provisioned admin at AAL2 must
   inspect the **actual Supabase dashboard** SMTP From identity, project URL,
   invitation template subject and complete body, and redirect allowlist;
   retain a read-back artifact and call
   `record_console_auth_sender_verification_v6(sender_email,
   supabase_url_origin, redirect_origin, template_subject, template_body,
   evidence_ref, evidence_sha256)`.
   The row expires after 30 days for requests. No send consumes the record in
   this slice. This is an operator-attested read-back gate;
   the runtime cannot introspect Supabase's SMTP settings through the Auth
   Admin API. No verification row exists by default. Verify `CONSOLE_URL` is
   the canonical HTTPS origin and `/invite/accept` is in Auth's permitted
   redirect URLs. Keep public signup disabled.
2. Release 273–283 and the integrated global Inbox decision control before
   applying 284–286. Run the migration-order test and the focused PGlite,
   runtime and UI suites. Deploy runtime and UI together only after the
   integrated Inbox and release gates are reviewed. Class #34 remains blocked.
   The next build must use `auth.admin.generateLink({type:'invite', email,
   options:{redirectTo}})` to create a secret link without invoking Auth's
   mutable email template, then a verified Resend sender/domain to send a
   provider-controlled subject/body with one explicit dynamic secret-link
   slot. Freeze that template and slot semantics in a **new** approval card;
   use a stable Resend idempotency key and reconcile uncertain outcomes.
   Retain the link only in process memory and never in database, logs, Inbox,
   browser response or artifacts. No sender/domain/key or real-send evidence
   has been verified for this new design. The current card cannot be reused.
3. Existing Auth email, including unverified email, is a conflict. No
   pre-existing account is silently attached. An admin must verify provenance
   and consent through a separate reviewed recovery/transfer procedure. A
   `reconcile` request must be manually checked against Auth and provider
   delivery before any replacement invitation; there is intentionally no
   automatic retry. A crash after the durable claim leaves `sending` reserved.
   Ordinary cancellation refuses `sending` and `reconcile`. After 15 minutes,
   a provisioned AAL2 admin may call
   `resolve_console_invitation_uncertain_v6(request_id, expected_hash,
   evidence_ref, evidence_sha256, reason)` only with retained provider no-send
   evidence. The database also checks that no Auth user has the recipient email
   and records canonical revocation. It does not send another email. If an
   Auth user exists, investigate and disable/reconcile that identity first.
   Cancelling an already-sent invitation revokes its canonical decision and
   prevents `accept_console_invitation_v6` from creating access, but does not
   recall the delivered email or delete/revoke its profileless Supabase Auth
   user. The Auth user and provider link must be examined and disabled through
   a separate controlled Auth-admin reconciliation step. The cancelled user
   can have a Supabase session but cannot enter a role console because no
   profile/member/client link is created.
4. Team UI covers employee roster invitations. The SQL supports client
   invitations by client ID, but a dedicated client-facing admin request UI and
   profile-name input are future work. Do not declare client invitation UX or
   overall 100/100 readiness green from this slice alone.

5. Each active employee invitation reserves both its normalized email and its
   roster member. Retirement or a material roster edit advances a database
   lifecycle generation, invalidating old approvals and sent-link acceptance
   even if the member is restored with the same name. The Team UI lists all
   known historical and active invitations for that member. The request RPC
   passes the source row's validated admin actor as canonical `requested_by`
   with `requester_kind='human'`, preserving provenance under service-role
   card registration.

No secret, invitation token or provider link belongs in a database event,
browser response, log or review artifact.

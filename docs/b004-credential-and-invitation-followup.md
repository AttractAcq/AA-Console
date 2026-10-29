# B004 credential safety and controlled invitations

This is the implementation handoff after migration 263. It records the exact
remaining Auth work; it is not a release approval.

## Verified repository state

| Path | Current behavior | Consequence |
| --- | --- | --- |
| `supabase/migrations/20260903105742_11_auth_users_and_role_metadata.sql` | The raw replay seeds five Auth accounts, falling back to `change-me` when seed settings are absent. Its original `create_console_user` also rewrites an existing user's password. | A clean raw replay temporarily creates known-password users; an upgrade replay executes migration 11 before corrective migration 263. Existing credentials can be reset during that earlier step. |
| `supabase/migrations/20261029140000_263_auth_signup_role_hardening.sql` | New signups receive an unprivileged profile, and later calls to `create_console_user` leave existing Auth credentials alone. | This is a forward fix after 263 runs; it cannot prevent migration 11's earlier replay effects. |
| `supabase/migrations/20260904074557_13_admin_form_rpcs.sql` | `admin_create_team_member` accepts a three-character password, then calls `create_console_user`, which writes `auth.users` and `auth.identities` directly for a new account. | Team onboarding bypasses a recipient-owned invitation and password setup flow. |
| `src/pages/operations/TeamCategoryPanel.tsx` | The Add Member form asks an admin to choose and handle a person's password. | The admin knows a reusable credential; a safe invitation flow should remove this field. |
| `src/components/forms/FormModal.tsx` and `src/pages/account/IntegrationsPanel.tsx` | The shared draft writer formerly serialized every non-file value, including the team password and Vault credential. | Browser localStorage could retain sensitive values after the modal closed. The local B004 follow-up branch removes this draft behavior, changes those forms to versioned draft keys, and purges the two old key families without inspecting their contents. |
| `src/pages/Page.tsx` and `src/pages/approvals/*` | The Approval Inbox is client-scoped and split into content, engine, and campaign-action tabs. | A team invitation has no global unified approval entry or exact-version decision yet. |

The owner reports that hosted Supabase **Allow new users to sign up** is off.
That is an attestation, not an independent dashboard readback. Local
`supabase/config.toml` is not evidence of the hosted setting.

## Next implementation order

1. **Protect raw replay before changing onboarding.** Make a disposable clean
   and upgrade replay reproduce migration 11's seed and reset behavior. Add a
   fail-closed replay preflight or a later corrective migration that removes
   any surviving known fallback credentials before the environment can serve
   traffic. Do not rewrite an applied historical migration or put seed values
   in the repository. Test that a replay has no usable known-password account
   and never changes an existing production-style credential. Reconcile the
   real admin roster before any automated correction of existing profiles.
2. **Add a durable invitation proposal.** Store member ID, normalized email,
   intended role/category, recipient-facing message and redirect, requester,
   immutable version/hash, status, decision actor/time, and execution state.
   Bind each proposal to an active unlinked member. Restrict request and read
   paths to authorized admins, and prevent client/employee users from editing
   decisions or snapshots. Do not store a password, recovery token, or invite
   link in the proposal.
3. **Replace direct password creation.** Make Add Member create a roster entry
   without a login, then request an invitation proposal for the intended
   email. Remove the password field and direct client call to
   `admin_create_team_member` with `p_password`. Retire the function's new
   Auth-user insertion path after the invitation executor is available; keep
   existing-profile updates credential-preserving. Verify that no public or
   authenticated direct RPC can create or reset an Auth password.
4. **Put the proposal in the unified Approval Inbox.** B008 must show every
   invitation alongside all other external actions in a global view. The
   approver sees the exact email, member, role/category, redirect and message
   version/hash. Approval signs only that version; any edit invalidates the
   decision. Require `aal2` in the SQL decision function and enforce distinct
   requester/approver when the product's separation rule applies.
5. **Execute only after approval.** A service-only worker claims one approved
   version and calls Supabase Auth Admin's invitation operation. The recipient
   sets their own password via Auth. Link `profiles` and `team_members` only
   after Auth returns the user identity and verify email/member/category
   consistency. Record provider result and idempotency key without recording
   the invite URL or token. Treat a network timeout after an attempted send as
   uncertain; require reconciliation before retrying to avoid duplicate mail.
   Never send from a browser or from a database trigger.
6. **Finish human MFA.** Add TOTP enrollment/challenge/recovery UX and require
   `aal2` in SQL for all human approval, publish/send, deployment and spend
   decision RPCs, including this invitation decision. A client-side check is
   insufficient. Exercise `aal1`, `aal2`, service-role and cross-client paths
   in tests. Capture an authorized hosted-setting readback and credential
   rotation evidence for the release record.

## Acceptance for the controlled invitation path

- A new team member can be proposed without any admin-supplied password.
- The pending invitation is visible in the single Approval Inbox, with its
  exact version and all material fields.
- No invitation is sent until a qualified human approves that exact version.
- Editing a proposal after approval blocks the send until reapproval.
- A failed or uncertain provider response never silently retries an email.
- The recipient alone chooses a password; no plaintext password or invite
  token enters application tables, browser drafts, logs, or approval records.
- Database authorization tests reject direct Auth creation/reset paths and
  lower-assurance human decisions.

The current B004 follow-up branch implements only the browser draft protection
in this sequence. No invitation is sent or enabled by it.

## Separate B004 browser draft policy

Team profile, lead, contact and billing forms also use persisted browser
drafts for personal or commercial information. The password/Vault change does
not decide whether that broader data should be kept in localStorage. B004
needs a separate field-by-field inventory, explicit retention policy, safe
migration of existing drafts, and tests for whichever fields are excluded.

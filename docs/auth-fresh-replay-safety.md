# B004: fresh Auth replay safety

## Scope and release boundary

Migration `20260903105742_11_auth_users_and_role_metadata.sql` is historical:
production has already recorded its version. The source file in this branch
was already different from the deployed historical SQL because hard-coded
passwords had previously been replaced with database settings. This review
changes that source again **only for a fresh replay or deliberate reapplication**.
An ordinary incremental migration push against production does not execute
version 11. Do not repair migration history, run version 11 directly, or apply
this change to production outside a separately approved and reviewed recovery
plan. The PR also changes the source checksum; Supabase's tracked version
history is not proof that source bytes equal the SQL originally applied. Keep
the version, both the original production artifact and this correction, and
the review decision in release evidence. A `migration fetch` can overwrite
the corrected file with the production copy and expose literal secrets;
restore and review the source before any commit.

A later additive migration alone cannot prevent a fresh project from creating
known-password accounts during migration 11. The interval before that later
migration would remain exposed, and a later migration cannot undo a password
rewrite that already occurred. This correction therefore changes the replayed
historical source. It leaves production data and the already-applied version
untouched.

## Exact behavior of the corrected source

- If no seed setting is present, each of the five accounts receives its own
  32-byte random secret encoded as 64 hex characters before Auth hashes it.
  No default password, secret value, or hash is written to a log or source.
- An explicitly configured seed password shorter than 16 characters fails
  the migration. Empty settings behave as absent. The legacy shared employee
  setting is rejected; SMM, editor, and avatar each have a separate optional
  setting, and duplicate explicit values are rejected.
- If **any** seeded email already exists in `auth.users`, the seed block fails
  before creating or promoting an account. A pre-registered or unconfirmed
  account cannot inherit the seeded admin, client, or employee role by email
  match. A repeat replay also fails closed. Existing Auth password hashes,
  metadata, confirmation, and update timestamps remain unchanged. The
  restricted provisioning helper separately preserves those Auth fields on
  an authorized existing-user call; do not use migration 11 as a password
  reset or profile reconciliation operation.
- The signup trigger assigns only `employee` and a null category; editable
  Auth user metadata cannot grant admin or client access before migration
  263 runs. Trusted seed provisioning explicitly updates the profile role.

## First administrator on a new project

The seeded `alex@attractacq.com` admin account has an unknown random password
when no seed setting was supplied. The verified owner of that mailbox should
use the hosted Supabase Auth recovery/invitation flow to set a strong personal
password. An authorized operator must verify the mailbox and account ID from
the trusted roster before sending a one-time recovery link. The link must not
be copied into a PR, ticket, database log, or chat. Confirm the recovered
account signs in as the intended admin, enrolls TOTP, and appears in the
approved admin roster before enabling any human approval decision. If email
recovery is not configured, establish first-admin access through a reviewed
Auth Admin process with equivalent identity verification and audit evidence.
Do not use `create_console_user()` or rerun migration 11 to reset a password.

## Evidence and unresolved work

`agent-runtime/src/auth-replay.pg.test.ts` executes the tracked migration 11
SQL against PGlite with pgcrypto test stubs. It tests no-setting replay,
distinct unknown seed secrets, rejection of a pre-registered admin email,
fail-closed repeat replay with unchanged Auth fields, forged signup metadata,
weak settings, and duplicate/shared employee secrets.
The existing migration 263 tests then verify the post-upgrade trigger and
provisioning helper. CI's schema job sets `AA_SCHEMA_REPLAY_RAW_SOURCE=1` to
exercise the exact tracked file through clean and released-to-head upgrade
paths. Raw-source replay passed in CI run 40963048537, so the disposable seed
fixture was removed from the harness. The follow-up full CI run on this commit
must also pass before release. A green source replay, schema catalog parity,
and generated type diff are required before release.

This patch does not create an invitation workflow, remove direct Auth table
writes, raise migration 13's three-character password minimum, close old
sessions, rotate existing accounts, prove the hosted signup switch, or enforce
SQL `aal2` at approval decisions. These remain B004 gates.

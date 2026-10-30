# Auth signup role hardening (migration 263)

Migration 11 copies `auth.users.raw_user_meta_data.role` and
`employee_category` into `public.profiles` when an Auth user is inserted.
Auth user metadata is editable by the user, so that trigger must not choose
authorization fields. Migration 263 replaces `public.handle_new_user()`:
new users receive `employee` and no team category. It also replaces the
restricted `create_console_user()` helper. New account creation still writes
the supplied seed password and metadata; on an existing account, a repeat
call leaves `auth.users.encrypted_password` and both metadata fields alone
while updating the authoritative profile role, category, and name. The
migration does not rewrite existing profiles or broaden the helper's grants.

## Release and verification

1. Migrations 260–263 were released to production on 29 October 2026.
   The linked dry run selected only 263 before it was applied, and the
   remote migration list confirmed its exact timestamp afterward.
2. Keep hosted Supabase Auth public signup disabled during this rollout. The
   owner disabled it on 29 October 2026; verify that setting again before
   enabling signup or invitations. The tracked local `supabase/config.toml`
   enables email signup and does not prove the hosted setting. A new Auth
   signup still receives the `employee` role, which has some broad read
   policies even without a client assignment.
3. Inspect every **existing** admin profile against a separate trusted
   roster and its creation history. The metadata claim alone is not proof
   of authorization. This read-only query gives the IDs and timestamps to
   reconcile without exposing passwords or tokens:

   ```sql
   select p.id, p.email, p.created_at as profile_created_at,
          u.created_at as auth_created_at,
          u.raw_user_meta_data ->> 'role' as editable_metadata_role
     from public.profiles p
     join auth.users u on u.id = p.id
    where p.role = 'admin'
    order by p.created_at, p.id;
   ```

4. In a disposable environment, insert an Auth user with metadata
   `{ "role": "admin", "employee_category": "smm" }`. Verify its profile
   remains `employee` with a null category and `public.is_admin()` is false.
   The focused PGlite suite exercises this, repeat provisioning without an
   Auth password or metadata rewrite, and client/team link preservation.
5. After an authorized deployment, confirm migration 263 appears under its
   exact timestamp in `supabase_migrations.schema_migrations`, then rerun the
   admin roster audit. Keep the migration and release decision's exact
   version in the release approval record. The future unified Approval Inbox
   should display that record when its B008 work is built.

## Remaining B004 work

This patch does not discover or demote any existing forged administrator.
The separate B004 replay correction in `docs/auth-fresh-replay-safety.md`
changes the tracked migration 11 source so a new database has unique random
seed secrets and a repeat fails before touching an existing Auth account.
Its raw-source CI replay must pass before this historical-file change is
released. Migration 13 still permits a three-character team-member password,
and `create_console_user()` still writes Auth tables directly rather than
using controlled Auth Admin invitations. Full B004 acceptance, including
hosted signup readback, existing-account provenance, MFA at decision RPCs,
credential rotation, and first-admin recovery evidence, remains open.

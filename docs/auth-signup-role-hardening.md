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

1. Review and release migration 260, then 261 and 262, before 263. The
   migration-order gate blocks 263 while 260 is absent from this branch.
2. Confirm the hosted Supabase Auth signup setting. The tracked local
   `supabase/config.toml` enables email signup and disables confirmation;
   it does not prove the hosted setting. If public signup is enabled, the
   owner can disable it as a temporary containment step through the approved
   release path while 263 is reviewed.
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
It also does not repair migration 11's `change-me` seed password fallback,
`create_console_user()`'s direct Auth table writes, or migration 13's
three-character team-member password minimum. **A raw schema replay still
executes migration 11 before 263.** A clean replay therefore runs its seed
with the original fallback password; a replay against existing seeded
accounts can reset their Auth passwords and metadata during that earlier
step. Migration 263 prevents only later repeat calls after it is applied.
Replay-time seed handling needs its own remedy. Full B004 acceptance,
including hosted signup configuration and existing-account audit, remains
open.

# Auth signup role hardening (migration 263)

Migration 11 copies `auth.users.raw_user_meta_data.role` and
`employee_category` into `public.profiles` when an Auth user is inserted.
Auth user metadata is editable by the user, so that trigger must not choose
authorization fields. Migration 263 replaces only `public.handle_new_user()`:
new users receive `employee` and no team category. The trusted
`create_console_user()` helper still explicitly assigns an admin, client, or
employee role after the insert trigger runs. The migration does not alter
existing profiles or the helper's privileges.

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
   The focused PGlite suite exercises this and the trusted seed helper.
5. After an authorized deployment, confirm migration 263 appears under its
   exact timestamp in `supabase_migrations.schema_migrations`, then rerun the
   admin roster audit. Keep the migration and release decision's exact
   version in the release approval record. The future unified Approval Inbox
   should display that record when its B008 work is built.

## Remaining B004 work

This patch does not discover or demote any existing forged administrator.
It also does not repair migration 11's `change-me` seed password fallback,
`create_console_user()`'s direct Auth table writes and password reset on
replay, or migration 13's three-character team-member password minimum.
Those require separate credential and provisioning changes with their own
tests and release review. Full B004 acceptance, including hosted signup
configuration and existing-account audit, remains open.

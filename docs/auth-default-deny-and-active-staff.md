# Default-deny Auth signup and active staff boundary (migration 270)

Migration 263 prevents editable signup metadata from assigning an administrator
role, but its Auth trigger still creates an `employee` profile. Migration 16
limits chat to explicitly added channel members, yet an unlinked or retired
employee profile can retain that membership and use a Supabase JWT directly.
The frontend's team-member check does not constrain direct database calls.
Migration 266 separately closes the analogous SOP metadata and storage path.

Migration 270 closes that path. A new Auth user receives **no console profile**
from the Auth insert trigger. Only the restricted `create_console_user()`
provisioning helper creates the intended profile. For chat, migration 270
hardens the existing `is_channel_member()` helper: employees need both explicit
channel membership and an active `team_members` record. Clients and admins
retain their explicit channel membership. The name-only `chat_participants()`
helper and own-message update policy use the same live membership; former
members cannot list channel membership rows. The migration
also removes direct self-update RLS policies on `profiles` and `team_members`;
their admin policies and trusted provisioning/name-sync functions remain.
The current employee account page is read-only and directs employees to an
administrator for changes.

## Release prerequisites

1. Release migrations 263 through 269 in timestamp order before 270. At the
   time this branch was created, 264–269 were still in the B005 PR stack.
   Require the schema-order guard and clean/upgrade replay to pass for the
   final exact commit. The production-linked `supabase db push --linked
   --dry-run` must list **only 270** before the production apply.
2. Keep hosted public signup disabled. Migration 270 makes an unknown Auth
   identity default-deny, but a complete invitation and lifecycle flow is
   still a separate B004 requirement. Do not enable public signup on the
   strength of this migration alone.
3. Read the affected account inventory before apply. An active employee with
   no `team_members` row is an inconsistent provisioned account; a retired
   employee retaining shared staff access is precisely the path this migration
   closes. The queries below disclose no passwords or tokens:

   ```sql
   select p.id, p.email, p.employee_category, tm.id as member_id,
          tm.category as member_category, tm.active
     from public.profiles p
     left join public.team_members tm on tm.user_id = p.id
    where p.role = 'employee'
    order by p.email, p.id;

   select p.id, p.email, p.employee_category, tm.category as member_category
     from public.profiles p
     join public.team_members tm on tm.user_id = p.id
    where p.role = 'employee'
      and p.employee_category is distinct from tm.category
    order by p.email, p.id;
   ```

4. After apply, verify migration version `20261029210000` in
   `supabase_migrations.schema_migrations`; re-run the inventory and check a
   real active employee, retired employee, and administrator through the UI.
   Do not use an operator's own token to simulate another identity.

## Automated evidence

`agent-runtime/src/auth-default-deny.pg.test.ts` executes the repository's
Auth trigger/provisioning definitions, migration 127's active-member helper,
migration 16's channel policies, migration 47's name-only helper, migration 263,
and migration 270 in PostgreSQL via PGlite. It first proves pre-270 channel
exposure for an unlinked employee. It then tests a fresh profileless signup,
denied channel/messages/names for unlinked and retired employees, retained
active employee/client/admin chat, rejected self category/active edits,
preserved admin updates, and trusted provisioning after the trigger becomes a no-op. Full CI
schema replay checks the migration against the complete catalog.

## Remaining B004 work

This migration does not audit or remove a historical administrator created
under the old metadata trigger. It does not replace direct Auth table writes
in `create_console_user()`, implement a controlled invitation workflow, enforce
MFA on exact-version human decisions, or repair legacy short-password creation.
Those requirements remain open. A future self-service display-name edit must
use a narrow RPC rather than restoring broad profile or team-row self-update.

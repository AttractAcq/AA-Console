-- 270 · Auth users have no console access until trusted provisioning links them.
-- Migration 263 stopped editable metadata from choosing a privileged role, but
-- the fallback employee profile could still read agency-wide chat through
-- policies that checked only profiles.role. Migration 266 separately closes
-- the corresponding SOP metadata/storage path. The Auth insert trigger must
-- not grant even that baseline role. create_console_user() explicitly
-- inserts the intended profile after the Auth insert fires this trigger.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  return new;
end;
$$;

revoke execute on function public.handle_new_user() from public, anon, authenticated;

-- Migration 127's current_member_id() returns an ID only for active staff.
-- Use the same predicate as migration 266's SOP policies.
drop policy if exists tc_staff_read on public.team_channels;
create policy tc_staff_read on public.team_channels
  for select to authenticated
  using (public.is_admin() or
    (public.current_role_of() = 'employee'::public.app_role
      and public.current_member_id() is not null));

drop policy if exists tmsg_staff_read on public.team_messages;
create policy tmsg_staff_read on public.team_messages
  for select to authenticated
  using (public.is_admin() or
    (public.current_role_of() = 'employee'::public.app_role
      and public.current_member_id() is not null));

drop policy if exists tmsg_staff_insert on public.team_messages;
create policy tmsg_staff_insert on public.team_messages
  for insert to authenticated
  with check (
    (public.is_admin() or
      (public.current_role_of() = 'employee'::public.app_role
        and public.current_member_id() is not null))
    and author_id = auth.uid()
  );

-- Current employee and client account pages are read-only. The old self
-- update policies allowed direct API callers to change employee_category,
-- active, category, and other authority-bearing fields. Admin policies and
-- trusted SECURITY DEFINER provisioning/name-sync functions retain writes.
drop policy if exists profiles_self_update on public.profiles;
drop policy if exists team_members_self_update on public.team_members;

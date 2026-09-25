-- Keep the login profile's display name in step with the editable team roster.
create or replace function sync_team_member_profile_name()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.user_id is not null and new.name is distinct from old.name then
    update profiles set full_name = new.name where id = new.user_id;
  end if;
  return new;
end;
$$;

create trigger team_member_profile_name_sync
after update of name on team_members
for each row execute function sync_team_member_profile_name();

-- Retired members keep their history, but lose access through assignments and
-- self-scoped policies. Admins can restore them without rebuilding records.
drop policy if exists team_members_self_read on team_members;
create policy team_members_self_read on team_members
  for select to authenticated using (user_id = auth.uid() and active);
drop policy if exists team_members_self_update on team_members;
create policy team_members_self_update on team_members
  for update to authenticated using (user_id = auth.uid() and active)
  with check (user_id = auth.uid() and active);

create or replace function accessible_client_ids()
returns setof uuid language sql stable security definer set search_path = public as $$
  select c.id from clients c where is_admin()
  union
  select cu.client_id from client_users cu where cu.user_id = auth.uid()
  union
  select ca.client_id from client_assignments ca
    join team_members tm on tm.id = ca.member_id
   where tm.user_id = auth.uid() and tm.active and ca.ended_at is null
  union
  select ja.client_id from job_assignments ja
    join team_members tm on tm.id = ja.member_id
   where tm.user_id = auth.uid() and tm.active and ja.client_id is not null;
$$;

create or replace function can_access_client(target uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select is_admin()
      or exists (select 1 from client_users cu
                  where cu.user_id = auth.uid() and cu.client_id = target)
      or exists (select 1 from client_assignments ca join team_members tm on tm.id = ca.member_id
                  where tm.user_id = auth.uid() and tm.active and ca.client_id = target and ca.ended_at is null)
      or exists (select 1 from job_assignments ja join team_members tm on tm.id = ja.member_id
                  where tm.user_id = auth.uid() and tm.active and ja.client_id = target);
$$;

create or replace function is_member(target uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from team_members tm where tm.id = target and tm.user_id = auth.uid() and tm.active
  );
$$;

create or replace function current_member_id()
returns uuid language sql stable security definer set search_path = public as $$
  select id from team_members where user_id = auth.uid() and active limit 1;
$$;

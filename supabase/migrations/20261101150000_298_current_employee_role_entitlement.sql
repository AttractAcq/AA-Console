-- B005 / Q022 CONDITIONAL PROTOTYPE. Do not release until Alex selects the
-- identity rule and the lower 280–297 stack and recovery gate are complete.
-- A linked team_members row is an employee entitlement only while the linked
-- account's current profiles.role is employee. Keep historical assignments;
-- deny their authority at read time after role drift.

create or replace function public.accessible_client_ids()
returns setof uuid language sql stable security definer
set search_path = pg_catalog, public as $$
  select c.id from public.clients c where public.is_admin()
  union
  select cu.client_id from public.client_users cu
   where cu.user_id = auth.uid() and public.is_client_user(cu.client_id)
  union
  select ca.client_id from public.client_assignments ca
    join public.team_members tm on tm.id = ca.member_id
   where coalesce(public.current_role_of() = 'employee'::public.app_role, false)
     and tm.user_id = auth.uid() and tm.active and ca.ended_at is null
  union
  select ja.client_id from public.job_assignments ja
    join public.team_members tm on tm.id = ja.member_id
   where coalesce(public.current_role_of() = 'employee'::public.app_role, false)
     and tm.user_id = auth.uid() and tm.active and ja.client_id is not null;
$$;

create or replace function public.can_access_client(target uuid)
returns boolean language sql stable security definer
set search_path = pg_catalog, public as $$
  select coalesce(public.is_admin(), false)
      or coalesce(public.is_client_user(target), false)
      or (
        coalesce(public.current_role_of() = 'employee'::public.app_role, false)
        and exists (
          select 1 from public.client_assignments ca
            join public.team_members tm on tm.id = ca.member_id
           where tm.user_id = auth.uid() and tm.active
             and ca.client_id = target and ca.ended_at is null
        )
      )
      or (
        coalesce(public.current_role_of() = 'employee'::public.app_role, false)
        and exists (
          select 1 from public.job_assignments ja
            join public.team_members tm on tm.id = ja.member_id
           where tm.user_id = auth.uid() and tm.active
             and ja.client_id = target
        )
      );
$$;

create or replace function public.is_member(target uuid)
returns boolean language sql stable security definer
set search_path = pg_catalog, public as $$
  select coalesce(public.current_role_of() = 'employee'::public.app_role, false)
     and exists (
       select 1 from public.team_members tm
        where tm.id = target and tm.user_id = auth.uid() and tm.active
     );
$$;

create or replace function public.current_member_id()
returns uuid language sql stable security definer
set search_path = pg_catalog, public as $$
  select tm.id from public.team_members tm
   where coalesce(public.current_role_of() = 'employee'::public.app_role, false)
     and tm.user_id = auth.uid() and tm.active
   limit 1;
$$;

-- Resolve the latest active assignment first, then validate that assignee's
-- current role. Filtering invalid rows before LIMIT 1 would silently revive
-- an older SMM/director, possibly changing who may approve a live artifact.
create or replace function public.active_video_approval_manager(p_client_id uuid)
returns uuid language sql stable security definer
set search_path = pg_catalog, public as $$
  select case when p.role = 'employee'::public.app_role
              then tm.user_id else null::uuid end
    from public.client_assignments ca
    join public.team_members tm on tm.id = ca.member_id
    left join public.profiles p on p.id = tm.user_id
   where ca.client_id = p_client_id and ca.ended_at is null
     and tm.active and tm.category = 'smm' and tm.user_id is not null
     and (auth.role() is distinct from 'authenticated'
          or public.current_role_of() is not null)
   order by ca.created_at desc, ca.id desc limit 1;
$$;

create or replace function public.active_creative_director(p_client_id uuid)
returns uuid language sql stable security definer
set search_path = pg_catalog, public as $$
  select case when p.role = 'employee'::public.app_role
              then tm.user_id else null::uuid end
    from public.client_assignments ca
    join public.team_members tm on tm.id = ca.member_id
    left join public.profiles p on p.id = tm.user_id
   where ca.client_id = p_client_id and ca.ended_at is null
     and tm.active and tm.category::text = 'creative_director'
     and tm.user_id is not null
     and (auth.role() is distinct from 'authenticated'
          or public.current_role_of() is not null)
   order by ca.created_at desc, ca.id desc limit 1;
$$;

create or replace function public.is_active_assigned_smm()
returns boolean language sql stable security definer
set search_path = pg_catalog, public as $$
  select coalesce(public.current_role_of() = 'employee'::public.app_role, false)
     and exists (
       select 1 from public.client_assignments ca
         join public.team_members tm on tm.id = ca.member_id
        where ca.ended_at is null and tm.active
          and tm.category = 'smm' and tm.user_id = auth.uid()
     );
$$;

-- These two direct policies bypassed the shared helpers. Past client identity
-- remains available to a retired employee whose profile is still employee;
-- an old team row on a client account does not grant employee history.
drop policy if exists team_members_self_read on public.team_members;
create policy team_members_self_read on public.team_members
  for select to authenticated using (
    user_id = auth.uid() and active
    and coalesce(public.current_role_of() = 'employee'::public.app_role, false)
  );

drop policy if exists clients_former_assignee_read on public.clients;
create policy clients_former_assignee_read on public.clients
  for select to authenticated using (
    coalesce(public.current_role_of() = 'employee'::public.app_role, false)
    and exists (
      select 1 from public.client_assignments ca
        join public.team_members tm on tm.id = ca.member_id
       where tm.user_id = auth.uid() and ca.client_id = clients.id
         and ca.ended_at is not null
    )
  );

-- The 296 final-video trigger locks the nominated client role. At the same
-- final write, lock the selected SMM's assignment, team link and role so a
-- concurrent role/assignment change cannot leave an approved video with an
-- invalid manager. The review RPC already requires this manager and signoff.
create or replace function public.guard_video_client_signoff_role()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public as $$
declare
  v_manager_user uuid;
  v_manager_role public.app_role;
  v_client_user uuid;
begin
  if new.media_type = 'video'
     and old.human_approved_at is null and new.human_approved_at is not null then
    select tm.user_id into v_manager_user
      from public.client_assignments ca
      join public.team_members tm on tm.id = ca.member_id
     where ca.client_id = new.client_id and ca.ended_at is null
       and tm.active and tm.category = 'smm' and tm.user_id is not null
     order by ca.created_at desc, ca.id desc limit 1
     for share of ca, tm;
    if v_manager_user is null then
      raise exception 'An active employee SMM is required to finalize video.'
        using errcode = '42501';
    end if;
    select p.role into v_manager_role from public.profiles p
     where p.id = v_manager_user for share;
    if v_manager_role is distinct from 'employee'::public.app_role then
      raise exception 'The assigned SMM is no longer a current employee.'
        using errcode = '42501';
    end if;

    select r.client_user_id into v_client_user
      from public.video_client_approval_requests r where r.asset_id = new.id;
    if v_client_user is not null then
      perform 1 from public.profiles p
        join public.client_users cu on cu.user_id = p.id
       where p.id = v_client_user and p.role = 'client'
         and cu.client_id = new.client_id
       for share of p, cu;
      if not found then
        raise exception 'The nominated client account is no longer current.'
          using errcode = '42501';
      end if;
    end if;
  end if;
  return new;
end;
$$;

-- CREATE OR REPLACE preserves existing executor grants. These helpers remain
-- available only through their prior authenticated/service or owner routes.
revoke execute on function public.accessible_client_ids() from public, anon;
revoke execute on function public.can_access_client(uuid) from public, anon;
revoke execute on function public.is_member(uuid) from public, anon;
revoke execute on function public.current_member_id() from public, anon;
revoke execute on function public.active_video_approval_manager(uuid) from public, anon;
revoke execute on function public.active_creative_director(uuid) from public, anon;
revoke execute on function public.is_active_assigned_smm() from public, anon;
revoke execute on function public.guard_video_client_signoff_role()
  from public, anon, authenticated, service_role;

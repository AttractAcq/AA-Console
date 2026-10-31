-- B005 / Q022 CONDITIONAL PROTOTYPE. Do not release until Alex selects the
-- identity rule. Under the proposed rule, a client_users row is a client
-- entitlement only while that account's current profiles.role is 'client'.
-- Keep the row for audit/provisioning history; do not let an employee profile
-- reuse it as a second, implicit client console or commercial-data grant.

create or replace function public.is_client_user(target uuid)
returns boolean language sql stable security definer
set search_path = pg_catalog, public as $$
  select coalesce(public.current_role_of() = 'client'::public.app_role, false)
     and exists (
       select 1 from public.client_users cu
        where cu.user_id = auth.uid() and cu.client_id = target
     );
$$;
revoke execute on function public.is_client_user(uuid) from public, anon;
grant execute on function public.is_client_user(uuid) to authenticated, service_role;

-- Migration 127 retained a second raw client_users route. Route that branch
-- through the same read-time predicate, preserving admin and active employee
-- assignment paths exactly as before.
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
   where tm.user_id = auth.uid() and tm.active and ca.ended_at is null
  union
  select ja.client_id from public.job_assignments ja
    join public.team_members tm on tm.id = ja.member_id
   where tm.user_id = auth.uid() and tm.active and ja.client_id is not null;
$$;

create or replace function public.can_access_client(target uuid)
returns boolean language sql stable security definer
set search_path = pg_catalog, public as $$
  select public.is_admin()
      or public.is_client_user(target)
      or exists (
        select 1 from public.client_assignments ca
          join public.team_members tm on tm.id = ca.member_id
         where tm.user_id = auth.uid() and tm.active
           and ca.client_id = target and ca.ended_at is null
      )
      or exists (
        select 1 from public.job_assignments ja
          join public.team_members tm on tm.id = ja.member_id
         where tm.user_id = auth.uid() and tm.active
           and ja.client_id = target
      );
$$;

-- Direct membership policies bypassed is_client_user. These are client
-- console, personal media, contract/billing, onboarding and Storage routes.
drop policy if exists client_users_self_read on public.client_users;
create policy client_users_self_read on public.client_users
  for select to authenticated
  using (user_id = auth.uid() and public.current_role_of() = 'client'::public.app_role);

drop policy if exists cma_client_read on public.client_media_assets;
create policy cma_client_read on public.client_media_assets
  for select to authenticated using (public.is_client_user(client_id));

drop policy if exists cos_client_update on public.client_onboarding_steps;
create policy cos_client_update on public.client_onboarding_steps
  for update to authenticated
  using (step_key = 'onboarding_form' and public.is_client_user(client_id))
  with check (step_key = 'onboarding_form' and public.is_client_user(client_id));

drop policy if exists cc_client_read on public.client_contracts;
create policy cc_client_read on public.client_contracts
  for select to authenticated using (public.is_client_user(client_id));

drop policy if exists cbill_client_read on public.client_billing;
create policy cbill_client_read on public.client_billing
  for select to authenticated using (public.is_client_user(client_id));

drop policy if exists contracts_obj_client_read on storage.objects;
create policy contracts_obj_client_read on storage.objects
  for select to authenticated using (
    bucket_id = 'contracts'
    and public.is_client_user(public.try_uuid((storage.foldername(name))[1]))
  );

drop policy if exists media_obj_client_read on storage.objects;
create policy media_obj_client_read on storage.objects
  for select to authenticated using (
    bucket_id = 'client-media'
    and public.is_client_user(public.try_uuid((storage.foldername(name))[1]))
  );

-- A SECURITY DEFINER client-facing helper also used raw membership.
create or replace function public.my_account_team()
returns table (name text, category text)
language sql stable security definer set search_path = pg_catalog, public as $$
  select tm.name, tm.category::text
    from public.client_assignments ca
    join public.team_members tm on tm.id = ca.member_id
   where ca.ended_at is null and tm.active = true
     and public.is_client_user(ca.client_id)
   order by tm.category, tm.name;
$$;

-- The video client seat may be chosen by an SMM, then the selected person's
-- role can change. Check the candidate at nomination and again at decision,
-- and make an old signoff ineligible for finalization after role drift.
create or replace function public.video_approval_state(p_asset_id uuid)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public as $$
declare
  a public.client_media_assets%rowtype;
  v_owner uuid;
  v_manager uuid;
  v_client uuid;
begin
  select * into a from public.client_media_assets where id = p_asset_id;
  if a.id is null or not public.can_access_client(a.client_id) then
    raise exception 'Not permitted for this asset';
  end if;
  select owner_user_id into v_owner from public.content_approval_settings where singleton;
  v_manager := public.active_video_approval_manager(a.client_id);
  select client_user_id into v_client from public.video_client_approval_requests where asset_id = a.id;
  return jsonb_build_object(
    'owner_user_id', v_owner, 'manager_user_id', v_manager,
    'client_user_id', v_client,
    'client_rejection_reason', (select rejection_reason from public.video_client_approval_requests where asset_id = a.id),
    'owner_approved', exists(select 1 from public.video_approval_signoffs where asset_id = a.id and approval_role = 'owner' and user_id = v_owner and render_path = coalesce(a.render_path, a.storage_path)),
    'manager_approved', exists(select 1 from public.video_approval_signoffs where asset_id = a.id and approval_role = 'manager' and user_id = v_manager and render_path = coalesce(a.render_path, a.storage_path)),
    'client_approved', v_client is not null
      and exists(select 1 from public.profiles p join public.client_users cu on cu.user_id = p.id
                  where p.id = v_client and p.role = 'client' and cu.client_id = a.client_id)
      and exists(select 1 from public.video_approval_signoffs where asset_id = a.id and approval_role = 'client' and user_id = v_client and render_path = coalesce(a.render_path, a.storage_path)),
    'can_configure', public.is_admin(), 'current_user_id', auth.uid(),
    'client_accounts', case when auth.uid() = v_manager then (
      select coalesce(jsonb_agg(jsonb_build_object('id', p.id,
        'name', coalesce(p.full_name, p.email, 'Client')) order by p.full_name), '[]'::jsonb)
      from public.client_users cu join public.profiles p on p.id = cu.user_id
      where cu.client_id = a.client_id and p.role = 'client'
    ) else '[]'::jsonb end
  );
end;
$$;

create or replace function public.request_video_client_approval(p_asset_id uuid, p_client_user_id uuid)
returns void language plpgsql security definer set search_path = pg_catalog, public as $$
declare a public.client_media_assets%rowtype;
begin
  select * into a from public.client_media_assets where id = p_asset_id for update;
  if a.id is null or a.media_type <> 'video' or a.edit_stage <> 'review_ready'
      or a.human_approved_at is not null then
    raise exception 'Choose a finished video.';
  end if;
  if auth.uid() is distinct from public.active_video_approval_manager(a.client_id) then
    raise exception 'Only the active assigned SMM can send this video to the client.';
  end if;
  if not exists (select 1 from public.client_users cu
                   join public.profiles p on p.id = cu.user_id
                  where cu.client_id = a.client_id and cu.user_id = p_client_user_id
                    and p.role = 'client') then
    raise exception 'Choose a current client account for this client.';
  end if;
  insert into public.video_client_approval_requests(asset_id, client_user_id, requested_by)
  values (a.id, p_client_user_id, auth.uid())
  on conflict (asset_id) do update set client_user_id = excluded.client_user_id,
    requested_by = excluded.requested_by, requested_at = now(),
    rejected_at = null, rejection_reason = null;
  delete from public.video_approval_signoffs where asset_id = a.id and approval_role = 'client';
end;
$$;

create or replace function public.sign_video_approval(p_asset_id uuid, p_role text)
returns void language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  a public.client_media_assets%rowtype;
  v_approver uuid;
begin
  select * into a from public.client_media_assets where id = p_asset_id for update;
  if a.id is null or a.media_type <> 'video' or a.edit_stage <> 'review_ready'
      or a.human_approved_at is not null then
    raise exception 'Only a finished video can be signed off.';
  end if;
  if p_role = 'owner' then
    select owner_user_id into v_approver from public.content_approval_settings where singleton;
  elsif p_role = 'manager' then
    v_approver := public.active_video_approval_manager(a.client_id);
  elsif p_role = 'client' then
    select client_user_id into v_approver from public.video_client_approval_requests where asset_id = a.id;
    if exists (select 1 from public.video_client_approval_requests
        where asset_id = a.id and rejected_at is not null) then
      raise exception 'This video was declined. Ask the SMM to request a new review.';
    end if;
    if not public.is_client_user(a.client_id) then
      raise exception 'Only a current client account can sign this client review.';
    end if;
  else
    raise exception 'Unknown approval role.';
  end if;
  if v_approver is null or v_approver <> auth.uid() then
    raise exception 'This approval is assigned to another account.';
  end if;
  if nullif(btrim(coalesce(a.render_path, a.storage_path)), '') is null then
    raise exception 'Finish the video cut before requesting sign-off.';
  end if;
  insert into public.video_approval_signoffs(asset_id, approval_role, user_id, render_path)
  values (a.id, p_role, auth.uid(), coalesce(a.render_path, a.storage_path))
  on conflict (asset_id, approval_role) do update
    set user_id = excluded.user_id, render_path = excluded.render_path, signed_at = now();
end;
$$;

create or replace function public.decline_video_client_approval(p_asset_id uuid, p_reason text)
returns void language plpgsql security definer set search_path = pg_catalog, public as $$
declare a public.client_media_assets%rowtype;
begin
  if nullif(btrim(p_reason), '') is null then raise exception 'Say what needs changing.'; end if;
  select * into a from public.client_media_assets where id = p_asset_id for update;
  if a.id is null or a.human_approved_at is not null then
    raise exception 'This video is no longer awaiting client review.';
  end if;
  if not public.is_client_user(a.client_id) then
    raise exception 'Only a current client account can decline this client review.';
  end if;
  update public.video_client_approval_requests
    set rejected_at = now(), rejection_reason = btrim(p_reason)
    where asset_id = a.id and client_user_id = auth.uid();
  if not found then raise exception 'This client review is assigned to another account.'; end if;
  delete from public.video_approval_signoffs where asset_id = a.id and approval_role = 'client';
end;
$$;

create or replace function public.creative_seat_of(p_client_id uuid, p_user_id uuid)
returns text language sql stable security definer
set search_path = pg_catalog, public as $$
  select case
    when p_user_id is null then 'other'
    when coalesce(public.is_admin(), false) then 'admin'
    when p_user_id = public.active_creative_director(p_client_id) then 'creative_director'
    when p_user_id = public.active_video_approval_manager(p_client_id) then 'smm'
    when exists (select 1 from public.client_users cu
                  join public.profiles p on p.id = cu.user_id
                  where cu.client_id = p_client_id and cu.user_id = p_user_id
                    and p.role = 'client') then 'client'
    else 'other'
  end;
$$;

-- review_media_asset checks video_approval_state before updating the asset.
-- Lock the nominated client's current role and membership at the final write
-- as well, closing a concurrent role-change gap between that read and commit.
create or replace function public.guard_video_client_signoff_role()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public as $$
declare v_client_user uuid;
begin
  if new.media_type = 'video'
     and old.human_approved_at is null and new.human_approved_at is not null then
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
drop trigger if exists cma_guard_video_client_signoff_role on public.client_media_assets;
create trigger cma_guard_video_client_signoff_role
  before update of human_approved_at on public.client_media_assets
  for each row execute function public.guard_video_client_signoff_role();
revoke execute on function public.guard_video_client_signoff_role() from public, anon, authenticated;

-- CREATE OR REPLACE preserves prior EXECUTE ACLs. Keep the historical RPC
-- surface explicit and closed to PUBLIC/anon; no new decision route is added.
revoke execute on function public.my_account_team() from public, anon;
revoke execute on function public.video_approval_state(uuid) from public, anon;
revoke execute on function public.request_video_client_approval(uuid, uuid) from public, anon;
revoke execute on function public.sign_video_approval(uuid, text) from public, anon;
revoke execute on function public.decline_video_client_approval(uuid, text) from public, anon;
revoke execute on function public.creative_seat_of(uuid, uuid) from public, anon;
grant execute on function public.my_account_team() to authenticated;
grant execute on function public.video_approval_state(uuid) to authenticated;
grant execute on function public.request_video_client_approval(uuid, uuid) to authenticated;
grant execute on function public.sign_video_approval(uuid, text) to authenticated;
grant execute on function public.decline_video_client_approval(uuid, text) to authenticated;
grant execute on function public.creative_seat_of(uuid, uuid) to authenticated, service_role;

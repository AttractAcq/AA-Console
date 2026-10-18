-- Video approval is a two-person handoff: the configured owner and the
-- client's active SMM. The SMM may also request a client sign-off.
create table content_approval_settings (
  singleton boolean primary key default true check (singleton),
  owner_user_id uuid not null references profiles(id),
  updated_by uuid references profiles(id),
  updated_at timestamptz not null default now()
);
alter table content_approval_settings enable row level security;

create table video_approval_signoffs (
  asset_id uuid not null references client_media_assets(id) on delete cascade,
  approval_role text not null check (approval_role in ('owner', 'manager', 'client')),
  user_id uuid not null references profiles(id),
  render_path text not null,
  signed_at timestamptz not null default now(),
  primary key (asset_id, approval_role)
);
alter table video_approval_signoffs enable row level security;

create table video_client_approval_requests (
  asset_id uuid primary key references client_media_assets(id) on delete cascade,
  client_user_id uuid not null references profiles(id),
  requested_by uuid not null references profiles(id),
  requested_at timestamptz not null default now(),
  rejected_at timestamptz,
  rejection_reason text
);
alter table video_client_approval_requests enable row level security;

create or replace function protect_approved_video_version()
returns trigger language plpgsql as $$
begin
  if old.media_type = 'video' and old.human_approved_at is not null
     and (new.render_path is distinct from old.render_path
       or new.storage_path is distinct from old.storage_path) then
    raise exception 'Create a new version to change an approved video.';
  end if;
  return new;
end;
$$;
create trigger cma_protect_approved_video_version before update on client_media_assets
  for each row execute function protect_approved_video_version();

create or replace function active_video_approval_manager(p_client_id uuid)
returns uuid language sql stable security definer set search_path = public as $$
  select tm.user_id from client_assignments ca
  join team_members tm on tm.id = ca.member_id
  where ca.client_id = p_client_id and ca.ended_at is null
    and tm.active and tm.category = 'smm' and tm.user_id is not null
  order by ca.created_at desc, ca.id desc limit 1;
$$;

create or replace function set_content_approval_owner(p_user_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'Only an admin can configure the owner.'; end if;
  if not exists (select 1 from profiles where id = p_user_id and role = 'admin') then
    raise exception 'Choose an admin account for the owner.';
  end if;
  insert into content_approval_settings (singleton, owner_user_id, updated_by)
  values (true, p_user_id, auth.uid())
  on conflict (singleton) do update set owner_user_id = excluded.owner_user_id,
    updated_by = excluded.updated_by, updated_at = now();
end;
$$;

create or replace function video_approval_state(p_asset_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  a client_media_assets%rowtype;
  v_owner uuid;
  v_manager uuid;
  v_client uuid;
begin
  select * into a from client_media_assets where id = p_asset_id;
  if a.id is null or not can_access_client(a.client_id) then
    raise exception 'Not permitted for this asset';
  end if;
  select owner_user_id into v_owner from content_approval_settings where singleton;
  v_manager := active_video_approval_manager(a.client_id);
  select client_user_id into v_client from video_client_approval_requests where asset_id = a.id;
  return jsonb_build_object(
    'owner_user_id', v_owner, 'manager_user_id', v_manager,
    'client_user_id', v_client,
    'client_rejection_reason', (select rejection_reason from video_client_approval_requests where asset_id = a.id),
    'owner_approved', exists(select 1 from video_approval_signoffs where asset_id = a.id and approval_role = 'owner' and user_id = v_owner and render_path = coalesce(a.render_path, a.storage_path)),
    'manager_approved', exists(select 1 from video_approval_signoffs where asset_id = a.id and approval_role = 'manager' and user_id = v_manager and render_path = coalesce(a.render_path, a.storage_path)),
    'client_approved', v_client is not null and exists(select 1 from video_approval_signoffs where asset_id = a.id and approval_role = 'client' and user_id = v_client and render_path = coalesce(a.render_path, a.storage_path)),
    'can_configure', is_admin(), 'current_user_id', auth.uid(),
    'client_accounts', case when auth.uid() = v_manager then (
      select coalesce(jsonb_agg(jsonb_build_object('id', p.id,
        'name', coalesce(p.full_name, p.email, 'Client')) order by p.full_name), '[]'::jsonb)
      from client_users cu join profiles p on p.id = cu.user_id
      where cu.client_id = a.client_id
    ) else '[]'::jsonb end
  );
end;
$$;

create or replace function sign_video_approval(p_asset_id uuid, p_role text)
returns void language plpgsql security definer set search_path = public as $$
declare
  a client_media_assets%rowtype;
  v_approver uuid;
begin
  select * into a from client_media_assets where id = p_asset_id for update;
  if a.id is null or a.media_type <> 'video' or a.edit_stage <> 'review_ready'
      or a.human_approved_at is not null then
    raise exception 'Only a finished video can be signed off.';
  end if;
  if p_role = 'owner' then
    select owner_user_id into v_approver from content_approval_settings where singleton;
  elsif p_role = 'manager' then
    v_approver := active_video_approval_manager(a.client_id);
  elsif p_role = 'client' then
    select client_user_id into v_approver from video_client_approval_requests where asset_id = a.id;
    if exists (select 1 from video_client_approval_requests
        where asset_id = a.id and rejected_at is not null) then
      raise exception 'This video was declined. Ask the SMM to request a new review.';
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
  insert into video_approval_signoffs(asset_id, approval_role, user_id, render_path)
  values (a.id, p_role, auth.uid(), coalesce(a.render_path, a.storage_path))
  on conflict (asset_id, approval_role) do update
    set user_id = excluded.user_id, render_path = excluded.render_path, signed_at = now();
end;
$$;

create or replace function request_video_client_approval(p_asset_id uuid, p_client_user_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare a client_media_assets%rowtype;
begin
  select * into a from client_media_assets where id = p_asset_id for update;
  if a.id is null or a.media_type <> 'video' or a.edit_stage <> 'review_ready'
      or a.human_approved_at is not null then
    raise exception 'Choose a finished video.';
  end if;
  if auth.uid() is distinct from active_video_approval_manager(a.client_id) then
    raise exception 'Only the active assigned SMM can send this video to the client.';
  end if;
  if not exists (select 1 from client_users where client_id = a.client_id and user_id = p_client_user_id) then
    raise exception 'Choose an account for this client.';
  end if;
  insert into video_client_approval_requests(asset_id, client_user_id, requested_by)
  values (a.id, p_client_user_id, auth.uid())
  on conflict (asset_id) do update set client_user_id = excluded.client_user_id,
    requested_by = excluded.requested_by, requested_at = now(),
    rejected_at = null, rejection_reason = null;
  delete from video_approval_signoffs where asset_id = a.id and approval_role = 'client';
end;
$$;

create or replace function decline_video_client_approval(p_asset_id uuid, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare a client_media_assets%rowtype;
begin
  if nullif(btrim(p_reason), '') is null then raise exception 'Say what needs changing.'; end if;
  select * into a from client_media_assets where id = p_asset_id for update;
  if a.id is null or a.human_approved_at is not null then
    raise exception 'This video is no longer awaiting client review.';
  end if;
  update video_client_approval_requests
    set rejected_at = now(), rejection_reason = btrim(p_reason)
    where asset_id = a.id and client_user_id = auth.uid();
  if not found then raise exception 'This client review is assigned to another account.'; end if;
  delete from video_approval_signoffs where asset_id = a.id and approval_role = 'client';
end;
$$;

-- Keep all existing review callers honest, including approve_slot and the
-- client dashboard. No UI path may finalize a video without all sign-offs.
create or replace function review_media_asset(
  p_asset_id uuid, p_decision review_status, p_reason text default null
) returns void language plpgsql security definer set search_path = public as $$
declare
  a client_media_assets%rowtype;
  v_state jsonb;
begin
  select * into a from client_media_assets where id = p_asset_id for update;
  if a.id is null then raise exception 'Asset not found'; end if;
  if not can_access_client(a.client_id) then raise exception 'Not permitted for this client'; end if;
  if a.media_type = 'video' and a.human_approved_at is not null then
    raise exception 'This video version has already been finalized.';
  end if;
  if p_decision = 'pending' then raise exception 'Decision must be approved or rejected'; end if;
  if p_decision = 'approved' and a.edit_stage <> 'review_ready' then
    raise exception 'Edit the source footage before approving a finished video.';
  end if;
  if p_decision = 'approved' and a.content_format = 'reel'
     and nullif(btrim(a.render_path), '') is null then
    raise exception 'Finish the reel cut before approving it';
  end if;
  if p_decision = 'approved' and a.media_type = 'video' then
    v_state := video_approval_state(a.id);
    if (v_state->>'owner_user_id') is null then
      raise exception 'Configure an owner account before approving video.';
    end if;
    if (v_state->>'manager_user_id') is null then
      raise exception 'Assign an active SMM to this client before approving video.';
    end if;
    if auth.uid() is distinct from (v_state->>'owner_user_id')::uuid
       and auth.uid() is distinct from (v_state->>'manager_user_id')::uuid then
      raise exception 'Only the owner or active SMM can finalize video approval.';
    end if;
    if not coalesce((v_state->>'owner_approved')::boolean, false)
       or not coalesce((v_state->>'manager_approved')::boolean, false)
       or ((v_state->>'client_user_id') is not null
           and not coalesce((v_state->>'client_approved')::boolean, false)) then
      raise exception 'Wait for the owner, SMM and requested client sign-offs.';
    end if;
  end if;
  update client_media_assets set review_status = p_decision,
    human_approved_at = case when p_decision = 'approved' then now() else null end
    where id = p_asset_id;
  insert into client_asset_reviews (asset_id, decision, reason, reviewed_by)
    values (p_asset_id, p_decision, p_reason, auth.uid());
end;
$$;

revoke execute on function set_content_approval_owner(uuid) from public, anon;
revoke execute on function video_approval_state(uuid) from public, anon;
revoke execute on function sign_video_approval(uuid, text) from public, anon;
revoke execute on function request_video_client_approval(uuid, uuid) from public, anon;
revoke execute on function decline_video_client_approval(uuid, text) from public, anon;
grant execute on function set_content_approval_owner(uuid) to authenticated;
grant execute on function video_approval_state(uuid) to authenticated;
grant execute on function sign_video_approval(uuid, text) to authenticated;
grant execute on function request_video_client_approval(uuid, uuid) to authenticated;
grant execute on function decline_video_client_approval(uuid, text) to authenticated;

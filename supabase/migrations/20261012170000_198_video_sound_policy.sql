-- An export's sound is a brief decision backed by an approved source file.
-- Existing briefs remain deliberate captions-only exports until changed.
create table video_sound_assets (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  kind text not null check (kind in ('licensed_music', 'approved_narration')),
  storage_path text not null unique,
  rights_reference text not null check (length(btrim(rights_reference)) > 0),
  attested_by uuid not null references profiles(id),
  attested_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
alter table video_sound_assets enable row level security;
create policy video_sound_assets_read on video_sound_assets for select to authenticated
  using (is_admin() or auth.uid() = active_video_approval_manager(client_id));
grant select on video_sound_assets to authenticated;

alter table client_briefs
  add column sound_treatment text not null default 'captions_only'
    check (sound_treatment in ('captions_only', 'licensed_music', 'approved_narration')),
  add column sound_asset_id uuid references video_sound_assets(id) on delete restrict,
  add constraint brief_sound_asset_pair check (
    (sound_treatment = 'captions_only' and sound_asset_id is null)
    or (sound_treatment <> 'captions_only' and sound_asset_id is not null));

create function attest_video_sound_asset(
  p_client_id uuid, p_kind text, p_storage_path text, p_rights_reference text
) returns video_sound_assets
language plpgsql security definer set search_path to 'public' as $$
declare v_asset video_sound_assets;
begin
  if auth.role() <> 'authenticated' or auth.uid() is null
     or (not is_admin() and auth.uid() is distinct from active_video_approval_manager(p_client_id)) then
    raise exception 'An authorized human must attest sound rights.';
  end if;
  if p_kind not in ('licensed_music', 'approved_narration')
     or nullif(btrim(coalesce(p_rights_reference, '')), '') is null
     or p_storage_path !~ ('^' || p_client_id::text || '/audio/[A-Za-z0-9._/-]+$')
     or p_storage_path like '%..%'
     or not exists (select 1 from storage.objects o
       where o.bucket_id = 'client-media' and o.name = p_storage_path) then
    raise exception 'A stored client audio file and rights reference are required.';
  end if;
  insert into video_sound_assets(client_id, kind, storage_path, rights_reference, attested_by)
  values (p_client_id, p_kind, p_storage_path, p_rights_reference, auth.uid())
  on conflict (storage_path) do nothing returning * into v_asset;
  if not found then
    select * into v_asset from video_sound_assets where storage_path = p_storage_path;
    if v_asset.client_id <> p_client_id or v_asset.kind <> p_kind
       or v_asset.rights_reference <> p_rights_reference then
      raise exception 'idempotency_conflict';
    end if;
  end if;
  return v_asset;
end;
$$;

create function set_brief_sound_treatment(
  p_brief_id uuid, p_treatment text, p_sound_asset_id uuid default null
) returns client_briefs
language plpgsql security definer set search_path to 'public' as $$
declare v_brief client_briefs; v_sound video_sound_assets;
begin
  select * into v_brief from client_briefs where id = p_brief_id for update;
  if v_brief.id is null or v_brief.media_type <> 'video'
     or (auth.role() <> 'service_role' and not is_admin()
       and auth.uid() is distinct from active_video_approval_manager(v_brief.client_id)) then
    raise exception 'An accessible video brief is required.';
  end if;
  if exists (select 1 from client_media_assets m
    where m.brief_id = p_brief_id and (m.human_approved_at is not null
      or exists (select 1 from video_render_candidates c
        where c.asset_id = m.id and c.verdict = 'accepted'))) then
    raise exception 'A finished cut cannot change its sound treatment; create a new brief version.';
  end if;
  if exists (select 1 from client_media_assets m join agent_jobs j
    on j.input_table = 'client_media_assets' and j.input_id = m.id
    where m.brief_id = p_brief_id and j.agent_key = 'video_edit'
      and j.status in ('queued', 'running')) then
    raise exception 'Wait for the active video edit to finish before changing sound.';
  end if;
  if p_treatment not in ('captions_only', 'licensed_music', 'approved_narration') then
    raise exception 'Unsupported sound treatment.';
  end if;
  if p_treatment = 'captions_only' and p_sound_asset_id is not null then
    raise exception 'Captions-only export cannot carry an audio asset.';
  end if;
  if p_treatment <> 'captions_only' then
    select * into v_sound from video_sound_assets where id = p_sound_asset_id;
    if v_sound.id is null or v_sound.client_id <> v_brief.client_id
       or v_sound.kind <> p_treatment then
      raise exception 'The sound source must be attested for this client and treatment.';
    end if;
  end if;
  update client_briefs set sound_treatment = p_treatment,
    sound_asset_id = p_sound_asset_id where id = p_brief_id returning * into v_brief;
  return v_brief;
end;
$$;

revoke all on function attest_video_sound_asset(uuid, text, text, text)
  from public, anon, service_role;
revoke all on function set_brief_sound_treatment(uuid, text, uuid)
  from public, anon;
grant execute on function attest_video_sound_asset(uuid, text, text, text) to authenticated;
grant execute on function set_brief_sound_treatment(uuid, text, uuid) to authenticated, service_role;
select lock_down_definer_functions();

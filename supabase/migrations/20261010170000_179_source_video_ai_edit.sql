-- Claude plans cuts from supplied footage; FFmpeg renders a new version while
-- preserving the original and its audio. This is separate from F6/F7 reels.
create table video_source_edit_requests (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id),
  source_asset_id uuid not null references client_media_assets(id),
  output_asset_id uuid references client_media_assets(id),
  job_id uuid references agent_jobs(id),
  direction text not null,
  aspect text not null check (aspect in ('vertical', 'square', 'horizontal')),
  remove_pauses boolean not null default true,
  captions boolean not null default true,
  animated_title boolean not null default false,
  brand_treatment text not null check (brand_treatment in ('on_brand', 'off_brand')),
  feel text not null check (feel in ('calm', 'balanced', 'expressive')),
  status text not null default 'queued' check (status in ('queued', 'running', 'completed', 'failed')),
  error text,
  transcript jsonb,
  edit_plan jsonb,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  completed_at timestamptz
);
create index video_source_edit_requests_source_idx
  on video_source_edit_requests(source_asset_id, created_at desc);
create unique index video_source_edit_requests_one_active_idx
  on video_source_edit_requests(source_asset_id) where status in ('queued', 'running');
alter table video_source_edit_requests enable row level security;
create policy video_source_edit_requests_manager_read on video_source_edit_requests
  for select to authenticated using (is_admin()
    or auth.uid() = active_video_approval_manager(client_id));

insert into agents(agent_key, name, initials, domain, description, requires_upstream, requires_input)
values ('source_video_edit', 'Source Video Edit', 'SVE', 'content',
  'Transcribes supplied footage, asks Claude for a timecoded cut, and renders an audio-preserving version.',
  '{}', true)
on conflict (agent_key) do nothing;

create or replace function request_source_video_edit(
  p_asset_id uuid, p_direction text, p_aspect text, p_remove_pauses boolean,
  p_captions boolean, p_animated_title boolean, p_brand_treatment text, p_feel text
) returns uuid language plpgsql security definer set search_path = public as $$
declare
  a client_media_assets%rowtype;
  v_request uuid;
  v_job uuid;
begin
  select * into a from client_media_assets where id = p_asset_id for update;
  if a.id is null or a.media_type <> 'video' or a.edit_stage <> 'needs_edit'
      or a.brief_id is null or nullif(btrim(a.storage_path), '') is null then
    raise exception 'Choose source footage waiting for an edit.';
  end if;
  if not is_admin() and auth.uid() is distinct from active_video_approval_manager(a.client_id) then
    raise exception 'Only an admin or the assigned SMM may request an AI edit.';
  end if;
  if length(btrim(coalesce(p_direction, ''))) < 10 or length(p_direction) > 4000 then
    raise exception 'Give the editor 10 to 4000 characters of direction.';
  end if;
  if p_aspect not in ('vertical', 'square', 'horizontal')
     or p_brand_treatment not in ('on_brand', 'off_brand')
     or p_feel not in ('calm', 'balanced', 'expressive')
     or p_remove_pauses is null or p_captions is null or p_animated_title is null then
    raise exception 'Choose valid edit controls.';
  end if;
  if exists (select 1 from video_source_edit_requests r where r.source_asset_id = a.id
      and r.status in ('queued', 'running')) then
    raise exception 'This footage already has an AI edit in progress.';
  end if;
  insert into video_source_edit_requests(client_id, source_asset_id, direction, aspect,
    remove_pauses, captions, animated_title, brand_treatment, feel, created_by)
  values (a.client_id, a.id, btrim(p_direction), p_aspect, p_remove_pauses,
    p_captions, p_animated_title, p_brand_treatment, p_feel, auth.uid())
  returning id into v_request;
  v_job := enqueue_agent_job_internal('source_video_edit', a.client_id,
    'client_media_assets', a.id, auth.uid(), jsonb_build_object('request_id', v_request),
    'Queued: edit supplied video');
  update video_source_edit_requests set job_id = v_job where id = v_request;
  update client_media_assets set edit_stage = 'editing' where id = a.id;
  return v_request;
end;
$$;
revoke execute on function request_source_video_edit(uuid, text, text, boolean, boolean, boolean, text, text)
  from public, anon;
grant execute on function request_source_video_edit(uuid, text, text, boolean, boolean, boolean, text, text)
  to authenticated;

-- The worker inserts the derived asset as service_role; human deliveries still
-- require an editor with an active assignment, as in migration 174.
create or replace function set_human_video_edit_stage()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_category team_category;
  v_source client_media_assets%rowtype;
begin
  if new.source_asset_id is null then
    if new.media_type = 'video' and new.member_id is not null then
      select category into v_category from team_members where id = new.member_id;
      if v_category = 'avatars' then new.edit_stage := 'needs_edit'; end if;
    end if;
    return new;
  end if;
  select * into v_source from client_media_assets where id = new.source_asset_id;
  if new.media_type <> 'video' or v_source.id is null or v_source.client_id <> new.client_id
      or v_source.media_type <> 'video' then
    raise exception 'The source footage is missing or belongs to another client.';
  end if;
  if new.member_id is null then
    if auth.role() <> 'service_role' or v_source.edit_stage <> 'editing'
      or not exists (select 1 from video_source_edit_requests r
        where r.source_asset_id = v_source.id and r.status = 'running') then
      raise exception 'Only the active AI edit may save this video version.';
    end if;
  else
    select category into v_category from team_members where id = new.member_id;
    if v_category <> 'editors' or v_source.edit_stage <> 'editing' or not exists (
      select 1 from job_assignments j where j.source_asset_id = v_source.id
        and j.member_id = new.member_id and j.stage in ('assigned', 'accepted', 'rework')) then
      raise exception 'This editor has no active edit assignment for that footage.';
    end if;
  end if;
  new.edit_stage := 'review_ready';
  if new.content_format = 'reel' then new.render_path := new.storage_path; end if;
  return new;
end;
$$;

-- Register the output and advance both lifecycle records in one transaction.
create function complete_source_video_edit(
  p_request_id uuid, p_storage_path text, p_edit_plan jsonb,
  p_width integer, p_height integer, p_duration_sec numeric
) returns uuid language plpgsql security definer set search_path = public as $$
declare
  r video_source_edit_requests%rowtype;
  a client_media_assets%rowtype;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Only the video edit worker can complete a source edit.';
  end if;
  select * into r from video_source_edit_requests where id = p_request_id for update;
  select * into a from client_media_assets where id = r.source_asset_id for update;
  if r.id is null or r.status <> 'running' or a.id is null or a.edit_stage <> 'editing'
      or a.client_id <> r.client_id then
    raise exception 'The source edit is no longer active.';
  end if;
  if p_storage_path <> (r.client_id::text || '/edits/' || r.id::text || '/cut.mp4')
      or p_edit_plan is null or p_width < 1 or p_height < 1 or p_duration_sec <= 0 then
    raise exception 'The rendered video metadata is invalid.';
  end if;
  if not exists (select 1 from storage.objects where bucket_id = 'client-media'
      and name = p_storage_path) then
    raise exception 'The rendered video has not been stored.';
  end if;
  insert into client_media_assets(id, client_id, brief_id, source_asset_id,
    media_type, content_format, title, storage_path, uploaded_by, edit_stage,
    edit_plan, width, height, duration_sec)
  values (r.id, r.client_id, a.brief_id, a.id, 'video', a.content_format,
    coalesce(a.title, 'Video') || ' — AI edit', p_storage_path, r.created_by,
    'review_ready', p_edit_plan, p_width, p_height, p_duration_sec);
  update client_media_assets set edit_stage = 'edited' where id = a.id;
  update video_source_edit_requests set status = 'completed', output_asset_id = r.id,
    completed_at = now(), error = null where id = r.id;
  return r.id;
end;
$$;
revoke execute on function complete_source_video_edit(uuid, text, jsonb, integer, integer, numeric)
  from public, anon, authenticated;
grant execute on function complete_source_video_edit(uuid, text, jsonb, integer, integer, numeric)
  to service_role;

-- An approved derivative video brief may create a physical source clip. It
-- enters Edit / Repurpose as needs_edit; it is never auto-approved.
create table video_repurpose_clip_requests (
  id uuid primary key default gen_random_uuid(),
  derivative_id uuid not null references video_repurpose_derivatives(id),
  client_id uuid not null references clients(id),
  source_asset_id uuid not null references client_media_assets(id),
  brief_id uuid not null references client_briefs(id),
  source_in_sec numeric not null,
  source_out_sec numeric not null,
  output_asset_id uuid references client_media_assets(id),
  status text not null default 'queued' check (status in ('queued', 'running', 'completed', 'failed')),
  job_id uuid references agent_jobs(id),
  error text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  unique(derivative_id, brief_id)
);
alter table video_repurpose_clip_requests enable row level security;
create policy video_repurpose_clip_requests_read on video_repurpose_clip_requests for select to authenticated
  using (is_admin() or auth.uid() = active_video_approval_manager(client_id));

insert into agents(agent_key, name, initials, domain, description, requires_upstream, requires_input)
values ('repurpose_clip_extract', 'Repurpose Clip Extract', 'RCE', 'content',
  'Cuts an evidenced source range into a new audio-preserving video awaiting edit.', '{}', true)
on conflict (agent_key) do nothing;

create function request_repurpose_clip(p_derivative_id uuid, p_brief_id uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  d video_repurpose_derivatives%rowtype;
  r video_repurpose_requests%rowtype;
  b client_briefs%rowtype;
  v_existing uuid;
  v_existing_status text;
  v_request uuid;
  v_job uuid;
begin
  select * into d from video_repurpose_derivatives where id = p_derivative_id;
  select * into r from video_repurpose_requests where id = d.request_id;
  select * into b from client_briefs where id = p_brief_id;
  if d.id is null or r.id is null or r.status <> 'completed'
      or r.candidates->(d.candidate_index - 1)->>'kind' <> 'short_clip'
      or b.id is null or b.client_id <> r.client_id or b.source_idea_id <> d.idea_id
      or b.media_type <> 'video' or b.content_format <> 'reel' or b.status <> 'approved' then
    raise exception 'Choose an approved reel brief from this clip candidate.';
  end if;
  if not is_admin() and auth.uid() is distinct from active_video_approval_manager(r.client_id) then
    raise exception 'Only an admin or the assigned SMM can create a repurposed clip.';
  end if;
  select id, status into v_existing, v_existing_status from video_repurpose_clip_requests
    where derivative_id = d.id and brief_id = b.id;
  if v_existing is not null then
    if v_existing_status = 'failed' then
      v_job := enqueue_agent_job_internal('repurpose_clip_extract', r.client_id,
        'video_repurpose_derivatives', d.id, auth.uid(),
        jsonb_build_object('request_id', v_existing), 'Queued: retry repurposed clip');
      update video_repurpose_clip_requests set status = 'queued', error = null,
        job_id = v_job where id = v_existing;
    end if;
    return v_existing;
  end if;
  insert into video_repurpose_clip_requests(derivative_id, client_id, source_asset_id,
    brief_id, source_in_sec, source_out_sec, created_by)
  values (d.id, r.client_id, r.source_asset_id, b.id,
    d.source_in_sec, d.source_out_sec, auth.uid()) returning id into v_request;
  v_job := enqueue_agent_job_internal('repurpose_clip_extract', r.client_id,
    'video_repurpose_derivatives', d.id, auth.uid(),
    jsonb_build_object('request_id', v_request), 'Queued: extract repurposed clip');
  update video_repurpose_clip_requests set job_id = v_job where id = v_request;
  return v_request;
end;
$$;
revoke execute on function request_repurpose_clip(uuid, uuid) from public, anon;
grant execute on function request_repurpose_clip(uuid, uuid) to authenticated;

create function complete_repurpose_clip(p_request_id uuid, p_storage_path text, p_duration_sec numeric)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  r video_repurpose_clip_requests%rowtype;
  b client_briefs%rowtype;
  source client_media_assets%rowtype;
  v_asset uuid;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Only the clip worker may register a repurposed video.';
  end if;
  select * into r from video_repurpose_clip_requests where id = p_request_id for update;
  select * into b from client_briefs where id = r.brief_id;
  select * into source from client_media_assets where id = r.source_asset_id;
  if r.id is null or r.status <> 'running' or b.id is null or source.id is null
      or source.client_id <> r.client_id or p_duration_sec <= 0 or p_duration_sec > 60.1
      or p_storage_path <> (r.client_id::text || '/repurpose-clips/' || r.id::text || '/source.mp4')
      or not exists (select 1 from storage.objects where bucket_id = 'client-media'
        and name = p_storage_path) then
    raise exception 'Repurposed clip metadata or stored output is invalid.';
  end if;
  insert into client_media_assets(client_id, brief_id, media_type, content_format,
    title, storage_path, uploaded_by, edit_stage, usage_rights, intake_notes, duration_sec)
  values (r.client_id, r.brief_id, 'video', 'reel',
    left(coalesce(b.title, 'Repurposed clip'), 300), p_storage_path, r.created_by,
    'needs_edit', source.usage_rights,
    'Cut from source asset ' || r.source_asset_id::text || ' at '
      || r.source_in_sec::text || '–' || r.source_out_sec::text || ' seconds.', p_duration_sec)
  returning id into v_asset;
  update video_repurpose_clip_requests set status = 'completed', output_asset_id = v_asset,
    completed_at = now(), error = null where id = r.id;
  return v_asset;
end;
$$;
revoke execute on function complete_repurpose_clip(uuid, text, numeric)
  from public, anon, authenticated;
grant execute on function complete_repurpose_clip(uuid, text, numeric) to service_role;

-- Source-video repurposing starts with evidence-backed candidates. A chosen
-- candidate re-enters Ideation as a draft; it cannot bypass brief or approval.
create table video_repurpose_requests (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id),
  source_asset_id uuid not null references client_media_assets(id),
  direction text not null default '',
  status text not null default 'queued' check (status in ('queued', 'running', 'completed', 'failed')),
  transcript jsonb,
  candidates jsonb,
  error text,
  job_id uuid references agent_jobs(id),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  completed_at timestamptz
);
create index video_repurpose_requests_source_idx
  on video_repurpose_requests(source_asset_id, created_at desc);
alter table video_repurpose_requests enable row level security;
create policy video_repurpose_requests_read on video_repurpose_requests for select to authenticated
  using (is_admin() or auth.uid() = active_video_approval_manager(client_id));

create table video_repurpose_derivatives (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references video_repurpose_requests(id),
  source_asset_id uuid not null references client_media_assets(id),
  candidate_index integer not null,
  target_platform post_platform not null,
  reentry_stage text not null default 'ideation' check (reentry_stage = 'ideation'),
  idea_id uuid not null references client_ideas(id),
  source_in_sec numeric not null,
  source_out_sec numeric not null,
  exact_quote text not null,
  created_at timestamptz not null default now(),
  unique(request_id, candidate_index, target_platform)
);
alter table video_repurpose_derivatives enable row level security;
create policy video_repurpose_derivatives_read on video_repurpose_derivatives for select to authenticated
  using (exists (select 1 from video_repurpose_requests r where r.id = request_id
    and (is_admin() or auth.uid() = active_video_approval_manager(r.client_id))));

insert into agents(agent_key, name, initials, domain, description, requires_upstream, requires_input)
values ('video_repurpose_insights', 'Video Repurpose Insights', 'VRI', 'content',
  'Transcribes source video and proposes evidenced quote-image and short-clip ideas.', '{}', true)
on conflict (agent_key) do nothing;

create function request_video_repurpose_insights(p_asset_id uuid, p_direction text default '')
returns uuid language plpgsql security definer set search_path = public as $$
declare
  a client_media_assets%rowtype;
  v_request uuid;
  v_job uuid;
begin
  select * into a from client_media_assets where id = p_asset_id;
  if a.id is null or a.media_type <> 'video' or a.review_status = 'rejected'
      or a.edit_stage = 'superseded'
      or nullif(btrim(coalesce(a.render_path, a.storage_path)), '') is null then
    raise exception 'Choose a stored video to repurpose.';
  end if;
  if not is_admin() and auth.uid() is distinct from active_video_approval_manager(a.client_id) then
    raise exception 'Only an admin or the assigned SMM can repurpose video.';
  end if;
  if length(coalesce(p_direction, '')) > 2000 then
    raise exception 'Repurpose direction must be at most 2000 characters.';
  end if;
  insert into video_repurpose_requests(client_id, source_asset_id, direction, created_by)
  values (a.client_id, a.id, btrim(coalesce(p_direction, '')), auth.uid()) returning id into v_request;
  v_job := enqueue_agent_job_internal('video_repurpose_insights', a.client_id,
    'client_media_assets', a.id, auth.uid(), jsonb_build_object('request_id', v_request),
    'Queued: understand source video for repurposing');
  update video_repurpose_requests set job_id = v_job where id = v_request;
  return v_request;
end;
$$;
revoke execute on function request_video_repurpose_insights(uuid, text) from public, anon;
grant execute on function request_video_repurpose_insights(uuid, text) to authenticated;

create function create_video_repurpose_idea(
  p_request_id uuid, p_candidate_index integer, p_target_platform post_platform
) returns uuid language plpgsql security definer set search_path = public as $$
declare
  r video_repurpose_requests%rowtype;
  c jsonb;
  v_kind text;
  v_format content_format;
  v_media media_type;
  v_existing uuid;
  v_idea uuid;
begin
  select * into r from video_repurpose_requests where id = p_request_id for update;
  if r.id is null or r.status <> 'completed' or p_candidate_index < 1
      or p_candidate_index > jsonb_array_length(coalesce(r.candidates, '[]'::jsonb)) then
    raise exception 'Choose a completed repurpose candidate.';
  end if;
  if not is_admin() and auth.uid() is distinct from active_video_approval_manager(r.client_id) then
    raise exception 'Only an admin or the assigned SMM can create a derivative idea.';
  end if;
  c := r.candidates->(p_candidate_index - 1);
  v_kind := c->>'kind';
  v_format := case when v_kind = 'quote_image' then 'single'::content_format
    when v_kind = 'short_clip' then 'reel'::content_format else null end;
  v_media := case when v_kind = 'quote_image' then 'image'::media_type
    when v_kind = 'short_clip' then 'video'::media_type else null end;
  if p_target_platform is null or v_format is null
      or not format_fits_media(v_format, v_media)
      or (v_format = 'reel' and p_target_platform = 'linkedin') then
    raise exception 'This candidate format is not supported on that platform.';
  end if;
  select idea_id into v_existing from video_repurpose_derivatives
    where request_id = r.id and candidate_index = p_candidate_index
      and target_platform = p_target_platform;
  if v_existing is not null then return v_existing; end if;
  insert into client_ideas(client_id, title, body, media_type, content_format,
    target_platform, source, status, created_by, strategic_reason)
  values (r.client_id, left(c->>'title', 300),
    'Derivative from video source ' || r.source_asset_id::text || E'\n'
      || 'Source range: ' || (c->>'start_sec') || '–' || (c->>'end_sec') || E' seconds\n'
      || 'Exact spoken quote: ' || (c->>'exact_quote') || E'\n'
      || 'Direction: ' || coalesce(c->>'reason', ''),
    v_media, v_format, p_target_platform, 'auto', 'draft', auth.uid(),
    coalesce(c->>'reason', 'Repurposed from source video'))
  returning id into v_idea;
  insert into video_repurpose_derivatives(request_id, source_asset_id, candidate_index,
    target_platform, idea_id, source_in_sec, source_out_sec, exact_quote)
  values (r.id, r.source_asset_id, p_candidate_index, p_target_platform,
    v_idea, (c->>'start_sec')::numeric, (c->>'end_sec')::numeric, c->>'exact_quote');
  return v_idea;
end;
$$;
revoke execute on function create_video_repurpose_idea(uuid, integer, post_platform)
  from public, anon;
grant execute on function create_video_repurpose_idea(uuid, integer, post_platform)
  to authenticated;

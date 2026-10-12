-- Preserve every rendered candidate. Only an internally accepted exact file
-- becomes the asset's render_path and enters the existing human sign-off.
create table video_render_candidates (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  asset_id uuid not null references client_media_assets(id) on delete cascade,
  job_id uuid not null references agent_jobs(id) on delete cascade,
  attempt integer not null check (attempt > 0),
  render_path text not null unique check (length(btrim(render_path)) > 0),
  media_probe jsonb not null check (jsonb_typeof(media_probe) = 'object'),
  creative_review jsonb,
  edit_plan jsonb,
  verdict text not null default 'pending' check (verdict in ('pending', 'rejected', 'accepted')),
  rejection_reason text,
  created_at timestamptz not null default now(),
  reviewed_at timestamptz,
  unique (job_id, attempt)
);
create index video_render_candidates_asset_idx on video_render_candidates (asset_id, created_at desc);
alter table video_render_candidates enable row level security;
create policy video_render_candidates_read on video_render_candidates for select to authenticated
  using (can_access_client(client_id));
grant select on video_render_candidates to authenticated;

create function record_video_render_candidate(
  p_job_id uuid, p_attempt integer, p_asset_id uuid, p_render_path text, p_media_probe jsonb
) returns video_render_candidates
language plpgsql security definer set search_path to 'public' as $$
declare v_job agent_jobs; v_asset client_media_assets; v_candidate video_render_candidates;
begin
  if auth.role() <> 'service_role' then raise exception 'AUTH: service role required'; end if;
  select * into v_job from agent_jobs where id = p_job_id;
  select * into v_asset from client_media_assets where id = p_asset_id;
  if v_job.id is null or v_asset.id is null or v_job.agent_key <> 'video_edit'
     or v_job.input_table <> 'client_media_assets' or v_job.input_id <> p_asset_id
     or v_job.attempts <> p_attempt or p_attempt < 1
     or v_job.client_id <> v_asset.client_id then
    raise exception 'Candidate must belong to this video-edit job and asset.';
  end if;
  if nullif(btrim(coalesce(p_render_path, '')), '') is null
     or p_render_path !~ ('^' || v_asset.client_id::text || '/reels/' || v_asset.id::text || '/candidates/')
     or p_media_probe is null or p_media_probe->>'result' is null
     or p_media_probe->>'result' not in ('pass', 'fail') then
    raise exception 'Candidate path and media probe are required.';
  end if;
  insert into video_render_candidates (client_id, asset_id, job_id, attempt, render_path, media_probe)
  values (v_asset.client_id, p_asset_id, p_job_id, p_attempt, p_render_path, p_media_probe)
  on conflict (job_id, attempt) do nothing returning * into v_candidate;
  if not found then
    select * into v_candidate from video_render_candidates
      where job_id = p_job_id and attempt = p_attempt;
    if v_candidate.asset_id <> p_asset_id or v_candidate.render_path <> p_render_path
       or v_candidate.media_probe <> p_media_probe then raise exception 'idempotency_conflict'; end if;
  end if;
  return v_candidate;
end;
$$;

create function decide_video_render_candidate(
  p_candidate_id uuid, p_verdict text, p_creative_review jsonb,
  p_rejection_reason text default null, p_edit_plan jsonb default null
) returns video_render_candidates
language plpgsql security definer set search_path to 'public' as $$
declare v_candidate video_render_candidates; v_asset client_media_assets;
begin
  if auth.role() <> 'service_role' then raise exception 'AUTH: service role required'; end if;
  select * into v_candidate from video_render_candidates where id = p_candidate_id for update;
  if not found then raise exception 'No such candidate.'; end if;
  if v_candidate.verdict <> 'pending' then
    if v_candidate.verdict = p_verdict and v_candidate.creative_review = p_creative_review
       and v_candidate.rejection_reason is not distinct from p_rejection_reason
       and v_candidate.edit_plan is not distinct from p_edit_plan then
      return v_candidate;
    end if;
    raise exception 'idempotency_conflict';
  end if;
  if p_verdict not in ('accepted', 'rejected') or p_creative_review is null
     or jsonb_typeof(p_creative_review) <> 'object'
     or p_creative_review->>'result' is null
     or p_creative_review->>'result' not in ('pass', 'fail')
     or jsonb_typeof(p_creative_review->'checks') is distinct from 'array'
     or jsonb_array_length(p_creative_review->'checks') = 0 then
    raise exception 'A structured creative review is required.';
  end if;
  if p_verdict = 'accepted' and (v_candidate.media_probe->>'result' is distinct from 'pass'
     or p_creative_review->>'result' is distinct from 'pass'
     or p_edit_plan is null or jsonb_typeof(p_edit_plan) <> 'object') then
    raise exception 'Media and creative review must both pass.';
  end if;
  if p_verdict = 'rejected' and nullif(btrim(coalesce(p_rejection_reason, '')), '') is null then
    raise exception 'A rejection reason is required.';
  end if;
  select * into v_asset from client_media_assets where id = v_candidate.asset_id for update;
  if p_verdict = 'accepted' and v_asset.human_approved_at is not null then
    raise exception 'An approved render cannot be replaced; create a new asset version.';
  end if;
  update video_render_candidates set verdict = p_verdict,
    creative_review = p_creative_review,
    edit_plan = p_edit_plan,
    rejection_reason = p_rejection_reason, reviewed_at = now()
    where id = p_candidate_id returning * into v_candidate;
  if p_verdict = 'accepted' then
    update client_media_assets set render_path = v_candidate.render_path,
      edit_plan = p_edit_plan,
      width = (v_candidate.media_probe->>'width')::integer,
      height = (v_candidate.media_probe->>'height')::integer,
      duration_sec = (v_candidate.media_probe->>'duration_sec')::numeric
      where id = v_candidate.asset_id;
  end if;
  return v_candidate;
end;
$$;

revoke all on function record_video_render_candidate(uuid, integer, uuid, text, jsonb)
  from public, anon, authenticated;
revoke all on function decide_video_render_candidate(uuid, text, jsonb, text, jsonb)
  from public, anon, authenticated;
grant execute on function record_video_render_candidate(uuid, integer, uuid, text, jsonb) to service_role;
grant execute on function decide_video_render_candidate(uuid, text, jsonb, text, jsonb) to service_role;
select lock_down_definer_functions();

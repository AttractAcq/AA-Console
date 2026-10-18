-- A video_build job schedules its own continuation while it is still
-- running. Exclude that job from deduplication or the RPC returns its ID,
-- which is then marked completed and leaves the clips uncollected.
drop function if exists public.schedule_agent_follow_up(text, uuid, text, uuid, integer, text, jsonb);

create function public.schedule_agent_follow_up(
  p_agent_key text,
  p_client_id uuid,
  p_input_table text,
  p_input_id uuid,
  p_after_seconds integer,
  p_description text default 'Scheduled follow-up',
  p_params jsonb default '{}'::jsonb,
  p_current_job_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_delay integer := greatest(10, least(coalesce(p_after_seconds, 60), 3600));
  v_due timestamptz := now() + make_interval(secs => v_delay);
  v_job uuid;
begin
  if auth.role() <> 'service_role' then
    raise exception 'AUTH: service role required';
  end if;
  if p_agent_key is null or p_input_table is null or p_input_id is null then
    raise exception 'VALIDATION: agent, input table and input id are required';
  end if;
  if not exists (select 1 from agents where agent_key = p_agent_key) then
    raise exception 'Unknown agent: %', p_agent_key;
  end if;

  select j.id into v_job
  from agent_jobs j
  where j.agent_key = p_agent_key
    and j.input_table = p_input_table
    and j.input_id = p_input_id
    and j.id is distinct from p_current_job_id
    and j.terminal = false
    and j.status in ('queued', 'claimed', 'running')
  order by j.created_at desc
  limit 1;
  if found then return v_job; end if;

  insert into agent_jobs(agent_key, client_id, input_table, input_id, params, run_after)
  values (p_agent_key, p_client_id, p_input_table, p_input_id,
    coalesce(p_params, '{}'::jsonb), v_due)
  returning id into v_job;
  insert into agent_job_events(job_id, description, payload)
  values (v_job, p_description, jsonb_build_object('run_after', v_due, 'after_seconds', v_delay));
  return v_job;
end;
$function$;

revoke all on function public.schedule_agent_follow_up(text, uuid, text, uuid, integer, text, jsonb, uuid)
  from public, anon, authenticated;
grant execute on function public.schedule_agent_follow_up(text, uuid, text, uuid, integer, text, jsonb, uuid)
  to service_role;

-- Restore reels whose first poll was lost to that self-deduplication bug.
create or replace function retry_reel_video_build(p_brief_id uuid)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_brief client_briefs%rowtype;
  v_status job_status;
  v_job uuid;
begin
  if not is_admin() then raise exception 'Only an admin can retry a reel build.'; end if;
  select * into v_brief from client_briefs where id = p_brief_id for update;
  if not found then raise exception 'That brief does not exist.'; end if;
  if v_brief.media_type <> 'video' or v_brief.content_format <> 'reel'
    or (v_brief.format_code is not null and v_brief.format_code not in ('F6', 'F7')) then
    raise exception 'Only a Phase 1 reel can be retried.';
  end if;
  select status into v_status from agent_jobs
  where agent_key = 'video_build' and input_table = 'client_briefs' and input_id = p_brief_id
  order by created_at desc limit 1;
  if v_status is null or v_status not in ('failed', 'completed') then
    raise exception 'The latest video build is already in progress.';
  end if;
  if exists (
    select 1 from agent_jobs still_job
    join creative_renders render on render.id = still_job.input_id
    join creative_generations generation on generation.id = render.generation_id
    where still_job.agent_key = 'creative_build'
      and still_job.input_table = 'creative_renders'
      and still_job.params ->> 'opening_stills' = 'true'
      and still_job.status in ('queued', 'claimed', 'running')
      and generation.brief_id = p_brief_id
  ) then
    raise exception 'Opening stills are still being generated. Retry when they finish.';
  end if;
  if not exists (
    select 1 from client_media_frames frame
    join client_media_assets asset on asset.id = frame.asset_id
    where asset.brief_id = p_brief_id and frame.storage_path is not null
  ) then
    raise exception 'No opening still is on file yet.';
  end if;
  if v_status = 'completed' and not exists (
    select 1 from client_media_frames frame
    join client_media_assets asset on asset.id = frame.asset_id
    where asset.brief_id = p_brief_id and frame.provider_job_id is not null
      and frame.clip_path is null and asset.render_path is null
  ) then
    raise exception 'This reel has no submitted clip waiting to be collected.';
  end if;

  insert into agent_jobs(agent_key, client_id, input_table, input_id, params, created_by)
  values ('video_build', v_brief.client_id, 'client_briefs', p_brief_id, '{}'::jsonb, auth.uid())
  returning id into v_job;
  insert into agent_job_events(job_id, description)
  values (v_job, 'Reel motion or clip collection retried. Stored provider request IDs will be reused.');
  return v_job;
end;
$function$;

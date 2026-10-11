-- A reel build queues creative_build and video_build together. The video job
-- must stay queued until the opening stills job has finished, otherwise two
-- workers race and video_build fails before it can call Higgsfield.
create or replace function claim_agent_job(p_lease_owner text, p_lease_seconds integer default 900, p_agent_keys text[] default null)
returns agent_jobs
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_job agent_jobs;
begin
  if auth.role() <> 'service_role' then
    raise exception 'AUTH: service role required';
  end if;
  if nullif(trim(coalesce(p_lease_owner, '')), '') is null then
    raise exception 'VALIDATION: lease owner required';
  end if;
  if p_lease_seconds not between 30 and 3600 then
    raise exception 'VALIDATION: lease seconds must be between 30 and 3600';
  end if;

  select j.* into v_job
  from agent_jobs j
  join agents a on a.agent_key = j.agent_key
  where (p_agent_keys is null or j.agent_key = any(p_agent_keys))
    and a.paused = false
    and a.archived_at is null
    and j.terminal = false
    and (j.run_after is null or j.run_after <= now())
    and (j.client_id is null or can_run_agent(j.agent_key, j.client_id))
    -- The opening stills are the input to Higgsfield. This dependency is
    -- scoped to the same brief, so unrelated video jobs can still run.
    and (
      j.agent_key <> 'video_build'
      or j.input_table <> 'client_briefs'
      or not exists (
        select 1
        from agent_jobs still_job
        join creative_renders render on render.id = still_job.input_id
        join creative_generations generation on generation.id = render.generation_id
        where still_job.agent_key = 'creative_build'
          and still_job.input_table = 'creative_renders'
          and still_job.params ->> 'opening_stills' = 'true'
          and still_job.status in ('queued', 'claimed', 'running')
          and generation.brief_id = j.input_id
      )
    )
    and (
      j.status = 'queued'
      or (j.status = 'failed' and j.attempts < j.max_attempts)
      or (j.status in ('claimed', 'running')
          and j.lease_until is not null
          and j.lease_until < now()
          and j.attempts < j.max_attempts)
    )
  order by j.created_at
  for update of j skip locked
  limit 1;

  if not found then
    return null;
  end if;

  update agent_jobs
     set status      = 'claimed',
         attempts    = attempts + 1,
         lease_owner = p_lease_owner,
         lease_until = now() + make_interval(secs => p_lease_seconds),
         started_at  = coalesce(started_at, now()),
         error       = null
   where id = v_job.id
  returning * into v_job;

  return v_job;
end;
$function$;

-- Recover a video job that failed before this ordering gate was installed,
-- or after a provider failure. The worker reuses stored provider request IDs,
-- so retrying does not submit a completed clip again.
create function retry_reel_video_build(p_brief_id uuid)
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
  if v_status is distinct from 'failed' then
    raise exception 'The latest video build is not failed.';
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

  insert into agent_jobs(agent_key, client_id, input_table, input_id, params, created_by)
  values ('video_build', v_brief.client_id, 'client_briefs', p_brief_id, '{}'::jsonb, auth.uid())
  returning id into v_job;
  insert into agent_job_events(job_id, description)
  values (v_job, 'Reel motion retried after opening stills were checked. Existing provider request IDs will be reused.');
  return v_job;
end;
$function$;

revoke all on function retry_reel_video_build(uuid) from public, anon, authenticated;
grant execute on function retry_reel_video_build(uuid) to authenticated;

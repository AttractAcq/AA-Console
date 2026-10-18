-- Resume a partially submitted daily reel after a provider 403. The frame
-- rows are the durable generation intents: a new video_build job polls every
-- stored provider_job_id and submits only frames whose id is still empty.
-- Keep the failed job and accepted opening asset as evidence. One retry per
-- motion step prevents a provider/account outage from looping paid requests.
create function retry_partial_higgsfield_motion_step(p_step_id uuid)
returns workflow_steps language plpgsql security definer set search_path = public as $$
declare
  v_step workflow_steps;
  v_run workflow_runs;
  v_job agent_jobs;
  v_run_id uuid;
  v_asset_id uuid;
  v_total integer;
  v_submitted integer;
begin
  if auth.role() <> 'service_role' then raise exception 'AUTH: service role required'; end if;
  select run_id into v_run_id from workflow_steps where id = p_step_id;
  if not found then raise exception 'Workflow step not found.'; end if;
  select * into v_run from workflow_runs where id = v_run_id for update;
  select * into v_step from workflow_steps where id = p_step_id for update;
  select * into v_job from agent_jobs where id = v_step.job_id;
  select a.record_id into v_asset_id from workflow_steps source_step
    join workflow_artifacts a on a.step_id = source_step.id
    where source_step.run_id = v_run.id and source_step.step_key = 'reel_create'
      and source_step.status = 'completed' and a.artifact_kind = 'asset';
  select count(*), count(*) filter (where provider_job_id is not null)
    into v_total, v_submitted from client_media_frames where asset_id = v_asset_id;
  if v_run.kind <> 'daily_content_package' or v_run.deadline_at <= now()
    or v_run.status <> 'blocked' or v_step.step_key <> 'reel_motion'
    or v_step.agent_key <> 'video_build' or v_step.input_table <> 'client_briefs'
    or v_step.status <> 'blocked' or v_step.blocker <> 'Higgsfield returned 403.'
    or v_job.status <> 'failed' or v_job.error is distinct from v_step.blocker
    or v_job.input_id is distinct from v_step.resolved_input_id
    or v_asset_id is null or v_total < 2 or v_submitted < 1 or v_submitted >= v_total
    or exists (select 1 from workflow_artifacts a where a.step_id = v_step.id)
    or (select count(*) from agent_jobs j
      where j.params->>'v5_workflow_run_id' = v_run.id::text
        and j.params->>'v5_step_key' = v_step.step_key) <> 1
  then raise exception 'Step is not eligible for partial Higgsfield recovery.'; end if;
  update workflow_steps set status = 'pending', blocker = null,
    job_id = null, resolved_input_id = null, completed_at = null, updated_at = now()
    where id = p_step_id returning * into v_step;
  update workflow_runs r set
    status = case when exists (select 1 from workflow_steps s
      where s.run_id = r.id and s.status = 'blocked') then 'blocked' else 'running' end,
    blocker = (select s.blocker from workflow_steps s
      where s.run_id = r.id and s.status = 'blocked'
      order by s.created_at, s.id limit 1), updated_at = now()
    where id = v_run.id;
  return v_step;
end;
$$;
revoke all on function retry_partial_higgsfield_motion_step(uuid)
  from public, anon, authenticated;
grant execute on function retry_partial_higgsfield_motion_step(uuid) to service_role;
select lock_down_definer_functions();

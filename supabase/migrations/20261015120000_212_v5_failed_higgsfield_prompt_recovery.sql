-- One deliberate replacement for a failed batch of Higgsfield requests.
-- Preserve the provider ids for audit and rotate the idempotency key once.
alter table client_media_frames
  add column provider_retry_count integer not null default 0
    check (provider_retry_count between 0 and 1),
  add column provider_prior_job_ids text[] not null default '{}';

create function retry_failed_higgsfield_motion_step(
  p_step_id uuid, p_failed_requests jsonb
) returns workflow_steps language plpgsql security definer set search_path = public as $$
declare
  v_step workflow_steps;
  v_run workflow_runs;
  v_job agent_jobs;
  v_run_id uuid;
  v_asset_id uuid;
  v_total integer;
  v_matched integer;
begin
  if auth.role() <> 'service_role' then raise exception 'AUTH: service role required'; end if;
  if jsonb_typeof(p_failed_requests) is distinct from 'array'
    or jsonb_array_length(p_failed_requests) = 0
  then raise exception 'Failed requests must be a nonempty array.'; end if;
  select run_id into v_run_id from workflow_steps where id = p_step_id;
  if not found then raise exception 'Workflow step not found.'; end if;
  select * into v_run from workflow_runs where id = v_run_id for update;
  select * into v_step from workflow_steps where id = p_step_id for update;
  select * into v_job from agent_jobs where id = v_step.job_id;
  select a.record_id into v_asset_id from workflow_steps source_step
    join workflow_artifacts a on a.step_id = source_step.id
    where source_step.run_id = v_run.id and source_step.step_key = 'reel_create'
      and source_step.status = 'completed' and a.artifact_kind = 'asset';

  -- The operator has independently checked each provider request status.
  -- The supplied batch must match every active frame request exactly.
  select count(*) into v_total from client_media_frames where asset_id = v_asset_id;
  select count(distinct f.id) into v_matched from client_media_frames f
    join jsonb_to_recordset(p_failed_requests) as failed(frame_id uuid, request_id text)
      on failed.frame_id = f.id and failed.request_id = f.provider_job_id
    where f.asset_id = v_asset_id and f.clip_path is null
      and f.provider_retry_count = 0 and f.provider_job_id is not null;
  if v_run.kind <> 'daily_content_package' or v_run.deadline_at <= now()
    or v_run.status <> 'blocked' or v_step.step_key <> 'reel_motion'
    or v_step.agent_key <> 'video_build' or v_step.input_table <> 'client_briefs'
    or v_step.status <> 'blocked'
    or v_step.blocker <> 'Higgsfield reported a shot as failed. The request id is stored. It was not submitted again.'
    or v_job.status <> 'failed' or v_job.error is distinct from v_step.blocker
    or v_job.input_id is distinct from v_step.resolved_input_id
    or v_asset_id is null or v_total < 2 or v_matched <> v_total
    or jsonb_array_length(p_failed_requests) <> v_total
    or exists (select 1 from workflow_artifacts a where a.step_id = v_step.id)
  then raise exception 'Step is not eligible for failed Higgsfield recovery.'; end if;

  update client_media_frames f set
    provider_prior_job_ids = array_append(f.provider_prior_job_ids, f.provider_job_id),
    provider_job_id = null, provider_retry_count = 1
    where f.asset_id = v_asset_id;
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
revoke all on function retry_failed_higgsfield_motion_step(uuid, jsonb)
  from public, anon, authenticated;
grant execute on function retry_failed_higgsfield_motion_step(uuid, jsonb) to service_role;
select lock_down_definer_functions();

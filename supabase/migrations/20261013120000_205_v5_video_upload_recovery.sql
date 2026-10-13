-- Recover one workflow edit that rendered but exhausted its job attempts on
-- a Storage 500. The failed job stays in history and the original source
-- asset remains unchanged. This repair may be invoked only once per step.
create function retry_failed_video_upload_workflow_step(p_step_id uuid)
returns workflow_steps language plpgsql security definer set search_path = public as $$
declare
  v_step workflow_steps;
  v_run workflow_runs;
  v_job agent_jobs;
begin
  if auth.role() <> 'service_role' then raise exception 'AUTH: service role required'; end if;
  select * into v_step from workflow_steps where id = p_step_id for update;
  if not found then raise exception 'Workflow step not found.'; end if;
  select * into v_run from workflow_runs where id = v_step.run_id for update;
  select * into v_job from agent_jobs where id = v_step.job_id;
  if v_run.kind <> 'daily_content_package' or v_run.deadline_at <= now()
    or v_step.agent_key <> 'video_edit' or v_step.status <> 'blocked'
    or v_step.blocker <> 'Could not store the cut: Internal Server Error'
    or v_job.status <> 'failed' or v_job.error <> v_step.blocker
    or exists (select 1 from video_render_candidates c where c.job_id = v_job.id)
    or exists (select 1 from workflow_artifacts a where a.step_id = v_step.id)
    or (select count(*) from agent_jobs j
      where j.params->>'v5_workflow_run_id' = v_run.id::text
        and j.params->>'v5_step_key' = v_step.step_key) <> 1
  then raise exception 'Step is not eligible for video-upload recovery.'; end if;
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
revoke all on function retry_failed_video_upload_workflow_step(uuid)
  from public, anon, authenticated;
grant execute on function retry_failed_video_upload_workflow_step(uuid) to service_role;
select lock_down_definer_functions();

-- Keep a v5 motion step attached to its current paid-clip collector. The
-- initial video_build job can complete after scheduling a follow-up; its
-- completion alone is not evidence that every clip has reached Storage.
create or replace function public.schedule_agent_follow_up(
  p_agent_key text,
  p_client_id uuid,
  p_input_table text,
  p_input_id uuid,
  p_after_seconds integer,
  p_description text default 'Scheduled follow-up',
  p_params jsonb default '{}'::jsonb,
  p_current_job_id uuid default null
)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_delay integer := greatest(10, least(coalesce(p_after_seconds, 60), 3600));
  v_due timestamptz := now() + make_interval(secs => v_delay);
  v_job uuid;
  v_run_id uuid;
  v_step_key text;
  v_step workflow_steps;
begin
  if auth.role() <> 'service_role' then raise exception 'AUTH: service role required'; end if;
  if p_agent_key is null or p_input_table is null or p_input_id is null then
    raise exception 'VALIDATION: agent, input table and input id are required';
  end if;
  if not exists (select 1 from agents where agent_key = p_agent_key) then
    raise exception 'Unknown agent: %', p_agent_key;
  end if;

  v_step_key := nullif(p_params->>'v5_step_key', '');
  if p_params ? 'v5_workflow_run_id' or p_params ? 'v5_step_key' then
    if p_agent_key <> 'video_build' or p_input_table <> 'client_briefs'
      or p_current_job_id is null or v_step_key is null
      or nullif(p_params->>'v5_workflow_run_id', '') is null then
      raise exception 'Invalid v5 motion follow-up.';
    end if;
    v_run_id := (p_params->>'v5_workflow_run_id')::uuid;
    select * into v_step from workflow_steps
      where run_id = v_run_id and step_key = v_step_key for update;
    if not found or v_step.agent_key <> 'video_build'
      or v_step.input_table <> 'client_briefs'
      or v_step.resolved_input_id is distinct from p_input_id
      or v_step.job_id is distinct from p_current_job_id
      or v_step.status not in ('queued', 'running', 'needs_internal_qa')
      or not exists (select 1 from workflow_runs r
        where r.id = v_run_id and r.client_id = p_client_id
          and r.kind = 'daily_content_package') then
      raise exception 'V5 motion step does not match current job.';
    end if;
  end if;

  select j.id into v_job from agent_jobs j
  where j.agent_key = p_agent_key and j.input_table = p_input_table
    and j.input_id = p_input_id and j.id is distinct from p_current_job_id
    and j.terminal = false and j.status in ('queued', 'claimed', 'running')
    and (v_run_id is null or (j.params->>'v5_workflow_run_id' = v_run_id::text
      and j.params->>'v5_step_key' = v_step_key))
  order by j.created_at desc limit 1;
  if not found then
    insert into agent_jobs(agent_key, client_id, input_table, input_id, params, run_after, run_id)
    values (p_agent_key, p_client_id, p_input_table, p_input_id,
      coalesce(p_params, '{}'::jsonb), v_due, v_run_id)
    returning id into v_job;
    insert into agent_job_events(job_id, description, payload)
    values (v_job, p_description, jsonb_build_object('run_after', v_due, 'after_seconds', v_delay));
  end if;
  if v_run_id is not null then
    update workflow_steps set job_id = v_job, status = 'queued', blocker = null,
      updated_at = now() where id = v_step.id;
  end if;
  return v_job;
end;
$$;
revoke all on function public.schedule_agent_follow_up(text, uuid, text, uuid, integer, text, jsonb, uuid)
  from public, anon, authenticated;
grant execute on function public.schedule_agent_follow_up(text, uuid, text, uuid, integer, text, jsonb, uuid)
  to service_role;
select lock_down_definer_functions();

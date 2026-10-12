-- creative_build needs a generation and render before the worker can start.
-- Keep these rows in the same transaction as queueing so retries cannot pay for
-- an orphaned render. Video briefs use image media for opening stills only.
create function enqueue_workflow_step_job(
  p_run workflow_runs, p_step workflow_steps, p_resolved_input uuid
) returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_brief client_briefs;
  v_generation_id uuid;
  v_render_id uuid;
  v_job_id uuid;
  v_params jsonb;
begin
  if auth.role() <> 'service_role' then raise exception 'AUTH: service role required'; end if;
  v_params := p_step.input_params || jsonb_build_object(
    'v5_workflow_run_id', p_run.id, 'v5_step_key', p_step.step_key);
  if p_step.agent_key = 'creative_build' then
    if p_step.input_table <> 'client_briefs' then
      raise exception 'Creative workflow step requires a brief.';
    end if;
    select * into v_brief from client_briefs where id = p_resolved_input;
    if not found or v_brief.client_id <> p_run.client_id then
      raise exception 'Creative brief is missing or belongs to another client.';
    end if;
    if v_brief.media_type = 'video' and v_brief.content_format not in ('reel', 'story') then
      raise exception 'Only a reel or story may use a video brief for opening stills.';
    end if;
    insert into creative_generations
      (client_id, brief_id, media_type, quality, size, created_by)
    values (p_run.client_id, p_resolved_input,
      case when v_brief.media_type = 'video' then 'image'::media_type else v_brief.media_type end,
      'high', '1024x1536', p_run.created_by)
    returning id into v_generation_id;
    insert into creative_renders
      (generation_id, client_id, quality, size, created_by)
    values (v_generation_id, p_run.client_id, 'high', '1024x1536', p_run.created_by)
    returning id into v_render_id;
    v_params := v_params || jsonb_build_object('render_id', v_render_id);
  end if;
  v_job_id := enqueue_agent_job_internal(
    p_step.agent_key, p_run.client_id, p_step.input_table, p_resolved_input,
    p_run.created_by, v_params, 'V5 workflow step queued.');
  if v_generation_id is not null then
    update creative_generations set job_id = v_job_id where id = v_generation_id;
    update creative_renders set job_id = v_job_id where id = v_render_id;
  end if;
  return v_job_id;
end;
$$;
revoke all on function enqueue_workflow_step_job(workflow_runs, workflow_steps, uuid)
  from public, anon, authenticated;
grant execute on function enqueue_workflow_step_job(workflow_runs, workflow_steps, uuid)
  to service_role;

create or replace function reconcile_workflow_runs(p_limit integer default 100)
returns table (steps_queued integer, steps_for_qa integer, steps_blocked integer)
language plpgsql security definer set search_path to 'public' as $$
declare v_run workflow_runs; v_step workflow_steps; v_job agent_jobs;
  v_queued integer := 0; v_qa integer := 0; v_blocked integer := 0; v_job_id uuid;
  v_resolved_input uuid; v_source_kind text;
begin
  if auth.role() <> 'service_role' then raise exception 'AUTH: service role required'; end if;
  if p_limit not between 1 and 500 then raise exception 'Limit must be 1..500.'; end if;
  for v_run in select * from workflow_runs r
    where r.sealed_at is not null and r.status in ('pending', 'running', 'needs_internal_qa')
    order by r.deadline_at, r.created_at for update skip locked limit p_limit
  loop
    if v_run.deadline_at <= now() then
      update workflow_runs set status = 'blocked', blocker = 'Workflow deadline passed.', updated_at = now()
      where id = v_run.id;
      continue;
    end if;
    for v_step in select * from workflow_steps s where s.run_id = v_run.id order by s.created_at, s.id
    loop
      if v_step.status = 'pending' and not exists (
        select 1 from unnest(v_step.dependencies) dep
        where not exists (select 1 from workflow_steps prerequisite
          where prerequisite.run_id = v_run.id and prerequisite.step_key = dep
            and prerequisite.status = 'completed')
      ) then
        begin
          v_resolved_input := v_step.input_id;
          if v_step.input_from_step_key is not null then
            select a.record_id, a.artifact_kind into v_resolved_input, v_source_kind
            from workflow_steps source_step
            join workflow_artifacts a on a.step_id = source_step.id
            where source_step.run_id = v_run.id
              and source_step.step_key = v_step.input_from_step_key;
            if v_resolved_input is null or
              (v_source_kind, v_step.input_table) not in (
                ('idea', 'client_ideas'), ('brief', 'client_briefs'),
                ('asset', 'client_media_assets'), ('page', 'client_pages'),
                ('sales_agent', 'client_sales_agents')) then
              raise exception 'Accepted input artefact does not match %.', v_step.input_table;
            end if;
          end if;
          v_job_id := enqueue_workflow_step_job(v_run, v_step, v_resolved_input);
          update agent_jobs set run_id = v_run.id where id = v_job_id;
          update workflow_steps set status = 'queued', resolved_input_id = v_resolved_input,
            job_id = v_job_id, updated_at = now()
          where id = v_step.id;
          v_queued := v_queued + 1;
        exception when others then
          update workflow_steps set status = 'blocked', blocker = sqlerrm, updated_at = now()
          where id = v_step.id;
          v_blocked := v_blocked + 1;
        end;
      elsif v_step.status in ('queued', 'running') and v_step.job_id is not null then
        select * into v_job from agent_jobs where id = v_step.job_id;
        if v_job.status = 'completed' then
          update workflow_steps set status = 'needs_internal_qa', updated_at = now()
          where id = v_step.id;
          v_qa := v_qa + 1;
        elsif v_job.status = 'failed' and (v_job.terminal or v_job.attempts >= v_job.max_attempts) then
          update workflow_steps set status = 'blocked', blocker = coalesce(v_job.error, 'Agent job failed.'), updated_at = now()
          where id = v_step.id;
          v_blocked := v_blocked + 1;
        elsif v_job.status = 'cancelled' then
          update workflow_steps set status = 'blocked', blocker = 'Agent job was cancelled.', updated_at = now()
          where id = v_step.id;
          v_blocked := v_blocked + 1;
        elsif v_job.status in ('claimed', 'running') and v_step.status = 'queued' then
          update workflow_steps set status = 'running', updated_at = now() where id = v_step.id;
        end if;
      end if;
    end loop;
    update workflow_runs r set
      status = case
        when exists (select 1 from workflow_steps s where s.run_id = r.id and s.status = 'blocked')
          then 'blocked'
        when exists (select 1 from workflow_steps s where s.run_id = r.id and s.status = 'needs_internal_qa')
          then 'needs_internal_qa'
        else 'running' end,
      blocker = (select s.blocker from workflow_steps s
        where s.run_id = r.id and s.status = 'blocked' order by s.created_at, s.id limit 1),
      updated_at = now()
    where r.id = v_run.id;
  end loop;
  return query select v_queued, v_qa, v_blocked;
end;
$$;

-- Repair only the legacy wrapper's missing-render failures. The failed job
-- remains in history; the next reconcile creates a fresh, correctly linked job.
create function retry_missing_render_workflow_step(p_step_id uuid)
returns workflow_steps language plpgsql security definer set search_path = public as $$
declare v_step workflow_steps; v_run workflow_runs; v_job agent_jobs;
begin
  if auth.role() <> 'service_role' then raise exception 'AUTH: service role required'; end if;
  select * into v_step from workflow_steps where id = p_step_id for update;
  if not found then raise exception 'Workflow step not found.'; end if;
  select * into v_run from workflow_runs where id = v_step.run_id for update;
  select * into v_job from agent_jobs where id = v_step.job_id;
  if v_run.kind <> 'daily_content_package' or v_run.deadline_at <= now()
    or v_step.agent_key <> 'creative_build' or v_step.status <> 'blocked'
    or v_step.blocker <> 'No render to produce.'
    or v_job.status <> 'failed' or v_job.error <> 'No render to produce.'
    or exists (select 1 from workflow_artifacts where step_id = v_step.id)
  then raise exception 'Step is not eligible for missing-render recovery.'; end if;
  update workflow_steps set status = 'pending', blocker = null,
    job_id = null, resolved_input_id = null, updated_at = now()
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
revoke all on function retry_missing_render_workflow_step(uuid)
  from public, anon, authenticated;
grant execute on function retry_missing_render_workflow_step(uuid) to service_role;
select lock_down_definer_functions();

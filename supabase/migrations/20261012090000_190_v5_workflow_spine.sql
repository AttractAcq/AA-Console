-- A durable outcome-level run above the existing bounded agent jobs.
-- This migration deliberately does not turn on daily or launch production.

create table workflow_runs (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  campaign_id uuid references client_campaigns(id) on delete set null,
  kind text not null check (kind in ('daily_content_package', 'client_launch_package')),
  workflow_version text not null check (length(btrim(workflow_version)) between 1 and 80),
  idempotency_key text not null check (length(btrim(idempotency_key)) between 1 and 160),
  root_request_id text,
  input_snapshot jsonb not null check (jsonb_typeof(input_snapshot) = 'object'),
  deadline_at timestamptz not null,
  status text not null default 'pending' check (status in
    ('pending', 'running', 'needs_input', 'needs_internal_qa', 'awaiting_human_approval',
     'completed', 'blocked', 'failed')),
  blocker text,
  sealed_at timestamptz,
  created_by uuid references profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (client_id, kind, idempotency_key)
);
create index workflow_runs_active_idx on workflow_runs (status, deadline_at)
  where sealed_at is not null and status in ('pending', 'running', 'needs_internal_qa');
create index workflow_runs_client_idx on workflow_runs (client_id, created_at desc);

create table workflow_steps (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references workflow_runs(id) on delete cascade,
  step_key text not null check (step_key ~ '^[a-z][a-z0-9_]{0,79}$'),
  dependencies text[] not null default '{}',
  agent_key text not null references agents(agent_key),
  input_table text not null check (length(btrim(input_table)) between 1 and 100),
  input_id uuid,
  input_from_step_key text,
  resolved_input_id uuid,
  input_params jsonb not null default '{}'::jsonb check (jsonb_typeof(input_params) = 'object'),
  status text not null default 'pending' check (status in
    ('pending', 'queued', 'running', 'needs_internal_qa', 'completed', 'blocked', 'failed')),
  job_id uuid unique references agent_jobs(id) on delete set null,
  blocker text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (run_id, step_key),
  unique (id, run_id),
  check ((input_id is not null) <> (input_from_step_key is not null)),
  check (not step_key = any(dependencies)),
  check (not (input_params ? 'v5_workflow_run_id' or input_params ? 'v5_step_key'))
);
create index workflow_steps_ready_idx on workflow_steps (run_id, status, created_at);

create table workflow_artifacts (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references workflow_runs(id) on delete cascade,
  step_id uuid not null,
  artifact_kind text not null check (length(btrim(artifact_kind)) between 1 and 80),
  record_id uuid not null,
  version_key text not null check (length(btrim(version_key)) between 1 and 160),
  qa_evidence jsonb not null check (jsonb_typeof(qa_evidence) = 'object'),
  accepted_at timestamptz not null default now(),
  unique (step_id, artifact_kind, record_id, version_key),
  unique (step_id),
  foreign key (step_id, run_id) references workflow_steps(id, run_id) on delete cascade
);
create index workflow_artifacts_run_idx on workflow_artifacts (run_id, step_id);

alter table workflow_runs enable row level security;
alter table workflow_steps enable row level security;
alter table workflow_artifacts enable row level security;
create policy workflow_runs_read on workflow_runs for select to authenticated
  using (can_access_client(client_id));
create policy workflow_steps_read on workflow_steps for select to authenticated
  using (exists (select 1 from workflow_runs r where r.id = run_id and can_access_client(r.client_id)));
create policy workflow_artifacts_read on workflow_artifacts for select to authenticated
  using (exists (select 1 from workflow_runs r where r.id = run_id and can_access_client(r.client_id)));
grant select on workflow_runs, workflow_steps, workflow_artifacts to authenticated;

-- One root request creates one run. An idempotency-key collision with changed
-- inputs is an error, not an excuse to attach new work to an older promise.
create function create_workflow_run(
  p_client_id uuid, p_kind text, p_workflow_version text, p_idempotency_key text,
  p_input_snapshot jsonb, p_deadline_at timestamptz,
  p_campaign_id uuid default null, p_root_request_id text default null,
  p_created_by uuid default null
) returns workflow_runs
language plpgsql security definer set search_path to 'public' as $$
declare v_run workflow_runs;
begin
  if auth.role() <> 'service_role' then raise exception 'AUTH: service role required'; end if;
  if p_client_id is null or not exists (select 1 from clients where id = p_client_id) then
    raise exception 'A real client is required.';
  end if;
  if p_kind not in ('daily_content_package', 'client_launch_package') then
    raise exception 'Unknown workflow kind.';
  end if;
  if nullif(btrim(coalesce(p_workflow_version, '')), '') is null
     or nullif(btrim(coalesce(p_idempotency_key, '')), '') is null
     or p_input_snapshot is null or jsonb_typeof(p_input_snapshot) <> 'object'
     or p_deadline_at is null then
    raise exception 'Workflow version, key, object snapshot and deadline are required.';
  end if;
  if p_campaign_id is not null and not exists (
    select 1 from client_campaigns c where c.id = p_campaign_id and c.client_id = p_client_id
  ) then raise exception 'Campaign does not belong to this client.'; end if;

  insert into workflow_runs (
    client_id, campaign_id, kind, workflow_version, idempotency_key,
    root_request_id, input_snapshot, deadline_at, created_by
  ) values (
    p_client_id, p_campaign_id, p_kind, btrim(p_workflow_version), btrim(p_idempotency_key),
    p_root_request_id, p_input_snapshot, p_deadline_at, p_created_by
  ) on conflict (client_id, kind, idempotency_key) do nothing
  returning * into v_run;
  if not found then
    select * into v_run from workflow_runs
    where client_id = p_client_id and kind = p_kind and idempotency_key = btrim(p_idempotency_key);
    if v_run.workflow_version is distinct from btrim(p_workflow_version)
       or v_run.input_snapshot is distinct from p_input_snapshot
       or v_run.deadline_at is distinct from p_deadline_at
       or v_run.campaign_id is distinct from p_campaign_id
       or v_run.root_request_id is distinct from p_root_request_id then
      raise exception 'idempotency_conflict';
    end if;
  end if;
  return v_run;
end;
$$;

-- Dependencies must already be defined. This makes the graph acyclic by
-- construction and prevents a typo from becoming a permanently queued step.
create function add_workflow_agent_step(
  p_run_id uuid, p_step_key text, p_dependencies text[], p_agent_key text,
  p_input_table text, p_input_id uuid, p_input_params jsonb default '{}'::jsonb,
  p_input_from_step_key text default null
) returns workflow_steps
language plpgsql security definer set search_path to 'public' as $$
declare v_run workflow_runs; v_step workflow_steps; v_dep text;
begin
  if auth.role() <> 'service_role' then raise exception 'AUTH: service role required'; end if;
  select * into v_run from workflow_runs where id = p_run_id for update;
  if not found then raise exception 'No such workflow run.'; end if;
  if p_step_key is null or p_step_key !~ '^[a-z][a-z0-9_]{0,79}$'
     or p_agent_key is null
     or ((p_input_id is not null) = (p_input_from_step_key is not null))
     or nullif(btrim(coalesce(p_input_table, '')), '') is null
     or p_input_params is null or jsonb_typeof(p_input_params) <> 'object'
     or p_input_params ? 'v5_workflow_run_id' or p_input_params ? 'v5_step_key' then
    raise exception 'Invalid workflow step contract.';
  end if;
  if not exists (select 1 from agents where agent_key = p_agent_key) then
    raise exception 'Unknown agent: %', p_agent_key;
  end if;
  select * into v_step from workflow_steps where run_id = p_run_id and step_key = p_step_key;
  if found then
    if v_step.dependencies is distinct from coalesce(p_dependencies, '{}')
       or v_step.agent_key is distinct from p_agent_key
       or v_step.input_table is distinct from btrim(p_input_table)
       or v_step.input_id is distinct from p_input_id
       or v_step.input_from_step_key is distinct from p_input_from_step_key
       or v_step.input_params is distinct from p_input_params then
      raise exception 'idempotency_conflict';
    end if;
    return v_step;
  end if;
  if v_run.sealed_at is not null or v_run.status <> 'pending' then
    raise exception 'Steps cannot be added after the workflow is sealed.';
  end if;
  foreach v_dep in array coalesce(p_dependencies, '{}') loop
    if v_dep = p_step_key or not exists (
      select 1 from workflow_steps where run_id = p_run_id and step_key = v_dep
    ) then raise exception 'Unknown or circular dependency: %', v_dep; end if;
  end loop;
  if p_input_from_step_key is not null and (
    p_input_from_step_key !~ '^[a-z][a-z0-9_]{0,79}$'
    or not p_input_from_step_key = any(coalesce(p_dependencies, '{}'))
  ) then raise exception 'Input source must be a direct dependency.'; end if;
  insert into workflow_steps (
    run_id, step_key, dependencies, agent_key, input_table, input_id,
    input_from_step_key, input_params
  ) values (
    p_run_id, p_step_key, coalesce(p_dependencies, '{}'), p_agent_key,
    btrim(p_input_table), p_input_id, p_input_from_step_key, p_input_params
  ) returning * into v_step;
  return v_step;
end;
$$;

-- Plan the full graph before dispatch. This also prevents an empty or
-- partially planned run from appearing ready for human approval.
create function seal_workflow_run(p_run_id uuid) returns workflow_runs
language plpgsql security definer set search_path to 'public' as $$
declare v_run workflow_runs;
begin
  if auth.role() <> 'service_role' then raise exception 'AUTH: service role required'; end if;
  select * into v_run from workflow_runs where id = p_run_id for update;
  if not found then raise exception 'No such workflow run.'; end if;
  if v_run.sealed_at is not null then return v_run; end if;
  if v_run.status <> 'pending' or v_run.deadline_at <= now()
     or not exists (select 1 from workflow_steps where run_id = p_run_id) then
    raise exception 'A future deadline and at least one planned step are required.';
  end if;
  update workflow_runs set sealed_at = now(), updated_at = now()
    where id = p_run_id returning * into v_run;
  return v_run;
end;
$$;

-- Job completion is a request for output inspection, never proof of quality.
-- The existing worker remains the sole executor of agent_jobs.
create function reconcile_workflow_runs(p_limit integer default 100)
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
          v_job_id := enqueue_agent_job_internal(
            v_step.agent_key, v_run.client_id, v_step.input_table, v_resolved_input,
            v_run.created_by,
            v_step.input_params || jsonb_build_object(
              'v5_workflow_run_id', v_run.id, 'v5_step_key', v_step.step_key),
            'V5 workflow step queued.');
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

create function accept_workflow_step(
  p_step_id uuid, p_artifact_kind text, p_record_id uuid,
  p_version_key text, p_qa_evidence jsonb
) returns workflow_steps
language plpgsql security definer set search_path to 'public' as $$
declare v_step workflow_steps; v_run workflow_runs; v_job agent_jobs;
  v_exists boolean;
begin
  if auth.role() <> 'service_role' then raise exception 'AUTH: service role required'; end if;
  select * into v_step from workflow_steps where id = p_step_id for update;
  if not found then raise exception 'No such workflow step.'; end if;
  select * into v_run from workflow_runs where id = v_step.run_id for update;
  if v_step.status = 'completed' then
    if exists (select 1 from workflow_artifacts a where a.step_id = p_step_id
      and a.artifact_kind = p_artifact_kind and a.record_id = p_record_id
      and a.version_key = p_version_key and a.qa_evidence = p_qa_evidence) then
      return v_step;
    end if;
    raise exception 'idempotency_conflict';
  end if;
  if v_step.status <> 'needs_internal_qa' or v_run.status not in ('running', 'needs_internal_qa') then
    raise exception 'Only a completed job awaiting internal QA can be accepted.';
  end if;
  select * into v_job from agent_jobs where id = v_step.job_id;
  if v_job.status <> 'completed' then raise exception 'Agent job is not complete.'; end if;
  if nullif(btrim(coalesce(p_artifact_kind, '')), '') is null or p_record_id is null
     or nullif(btrim(coalesce(p_version_key, '')), '') is null
     or p_qa_evidence is null or jsonb_typeof(p_qa_evidence) <> 'object'
     or p_qa_evidence->>'result' is distinct from 'pass'
     or jsonb_typeof(p_qa_evidence->'checks') is distinct from 'array'
     or jsonb_array_length(p_qa_evidence->'checks') = 0 then
    raise exception 'Accepted output needs an artefact, version and QA evidence.';
  end if;
  -- An artefact ID is not evidence if it names nothing, or another client's
  -- record. Only these known domain outputs may satisfy a workflow step.
  v_exists := case p_artifact_kind
    when 'agent_record' then exists (select 1 from client_agent_records a
      where a.id = p_record_id and a.client_id = v_run.client_id
        and a.job_id = v_step.job_id and nullif(btrim(a.body), '') is not null)
    when 'idea' then exists (select 1 from client_ideas a
      where a.id = p_record_id and a.client_id = v_run.client_id
        and a.job_id = v_step.job_id and nullif(btrim(a.title), '') is not null)
    when 'brief' then exists (select 1 from client_briefs a
      where a.id = p_record_id and a.client_id = v_run.client_id
        and a.job_id = v_step.job_id and nullif(btrim(a.body), '') is not null)
    when 'asset' then exists (select 1 from client_media_assets a
      where a.id = p_record_id and a.client_id = v_run.client_id
        and (
          (v_step.input_table = 'client_briefs' and a.brief_id = v_step.resolved_input_id
            and a.created_at >= v_job.created_at)
          or (v_step.input_table = 'client_media_assets' and a.id = v_step.resolved_input_id
            and a.updated_at >= v_job.created_at)
        ) and (
          (v_step.agent_key = 'video_build' and exists (
            select 1 from client_media_frames f where f.asset_id = a.id
              and nullif(btrim(f.clip_path), '') is not null))
          or (v_step.agent_key in ('video_edit', 'source_video_edit')
            and nullif(btrim(a.render_path), '') is not null)
          or (v_step.agent_key not in ('video_build', 'video_edit', 'source_video_edit')
            and nullif(btrim(a.storage_path), '') is not null)
        ))
    when 'page' then exists (select 1 from client_pages a
      where a.id = p_record_id and a.client_id = v_run.client_id
        and a.job_id = v_step.job_id and nullif(btrim(a.body), '') is not null)
    when 'sales_agent' then exists (select 1 from client_sales_agents a
      where a.id = p_record_id and a.client_id = v_run.client_id
        and a.job_id = v_step.job_id and a.built_at is not null
        and nullif(btrim(a.system_prompt), '') is not null)
    else false end;
  if not v_exists then raise exception 'Accepted artefact is missing or belongs to another client.'; end if;
  insert into workflow_artifacts (run_id, step_id, artifact_kind, record_id, version_key, qa_evidence)
  values (v_run.id, v_step.id, btrim(p_artifact_kind), p_record_id, btrim(p_version_key), p_qa_evidence)
  on conflict (step_id, artifact_kind, record_id, version_key) do nothing;
  update workflow_steps set status = 'completed', blocker = null,
    completed_at = now(), updated_at = now() where id = v_step.id returning * into v_step;
  if not exists (select 1 from workflow_steps where run_id = v_run.id and status <> 'completed') then
    update workflow_runs set status = 'awaiting_human_approval', blocker = null, updated_at = now()
    where id = v_run.id;
  end if;
  return v_step;
end;
$$;

revoke all on function create_workflow_run(uuid, text, text, text, jsonb, timestamptz, uuid, text, uuid)
  from public, anon, authenticated;
revoke all on function add_workflow_agent_step(uuid, text, text[], text, text, uuid, jsonb, text)
  from public, anon, authenticated;
revoke all on function seal_workflow_run(uuid) from public, anon, authenticated;
revoke all on function reconcile_workflow_runs(integer) from public, anon, authenticated;
revoke all on function accept_workflow_step(uuid, text, uuid, text, jsonb)
  from public, anon, authenticated;
grant execute on function create_workflow_run(uuid, text, text, text, jsonb, timestamptz, uuid, text, uuid)
  to service_role;
grant execute on function add_workflow_agent_step(uuid, text, text[], text, text, uuid, jsonb, text)
  to service_role;
grant execute on function seal_workflow_run(uuid) to service_role;
grant execute on function reconcile_workflow_runs(integer) to service_role;
grant execute on function accept_workflow_step(uuid, text, uuid, text, jsonb) to service_role;

select lock_down_definer_functions();

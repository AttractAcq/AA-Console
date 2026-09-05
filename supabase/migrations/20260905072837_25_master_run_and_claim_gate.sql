-- ============================================================
-- AA Console · 25 · Master run
--
-- A master run enqueues every agent for a client at once and lets the
-- QUEUE resolve the ordering, rather than an orchestrator stepping
-- through them. This is the whole reason the job queue exists: the insert
-- returns in milliseconds and the Railway worker does the work, so there
-- is no long-running request anywhere and nothing to time out.
--
-- The mechanism is a gate on the claim, not a scheduler. claim_agent_job
-- now skips any job whose upstream has not completed for that client, so
-- nine jobs queued simultaneously get picked up in dependency order as
-- each gate opens. No polling loop, no tab that has to stay open.
-- ============================================================

alter table agent_jobs add column if not exists run_id uuid;
create index if not exists agent_jobs_run_idx on agent_jobs (run_id, created_at);

comment on column agent_jobs.run_id is
  'Groups jobs queued together by a master run so progress can be reported as one unit.';

-- ---------- claim now respects the dependency gate ----------
create or replace function claim_agent_job(
  p_lease_owner   text,
  p_lease_seconds integer default 900,
  p_agent_keys    text[] default null
)
returns agent_jobs
language plpgsql
security definer
set search_path = public
as $$
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
    -- A job whose upstream has not finished is not runnable YET. Leaving
    -- it queued rather than failing it is what lets a master run enqueue
    -- everything up front and still execute in the right order.
    and (j.client_id is null or can_run_agent(j.agent_key, j.client_id))
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
$$;

revoke all on function claim_agent_job(text, integer, text[]) from public, anon, authenticated;
grant execute on function claim_agent_job(text, integer, text[]) to service_role;

-- ---------- start a master run ----------
-- Returns immediately. Ordering is the queue's problem, not the caller's.
create or replace function start_master_run(p_client_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_run_id uuid := gen_random_uuid();
  v_count  integer;
begin
  if not can_access_client(p_client_id) then
    raise exception 'Not permitted for this client';
  end if;

  -- Only agents that are runnable at all: registered, not paused, not
  -- archived, and with a record template set or a known list output.
  insert into agent_jobs (agent_key, client_id, run_id, created_by)
  select a.agent_key, p_client_id, v_run_id, auth.uid()
  from agents a
  where a.paused = false
    and a.archived_at is null
    -- brief is excluded on purpose: it needs one approved idea, so it is
    -- triggered per idea rather than swept up in a whole-client run.
    and a.agent_key <> 'brief'
    -- never queue a second copy of something already in flight
    and not exists (
      select 1 from agent_jobs j
       where j.agent_key = a.agent_key
         and j.client_id = p_client_id
         and j.status in ('queued', 'claimed', 'running')
    );

  get diagnostics v_count = row_count;
  if v_count = 0 then
    raise exception 'Nothing to run — every agent is already queued or running for this client.';
  end if;

  return v_run_id;
end;
$$;

revoke all on function start_master_run(uuid) from anon, public;
grant execute on function start_master_run(uuid) to authenticated;

-- ---------- progress for one run ----------
create or replace function master_run_progress(p_run_id uuid)
returns table (
  total     bigint,
  completed bigint,
  failed    bigint,
  running   bigint,
  queued    bigint,
  cost_usd  numeric
)
language sql
stable
security definer
set search_path = public
as $$
  select count(*)                                              as total,
         count(*) filter (where status = 'completed')          as completed,
         count(*) filter (where status = 'failed')             as failed,
         count(*) filter (where status in ('claimed','running')) as running,
         count(*) filter (where status = 'queued')             as queued,
         coalesce(sum(cost_usd), 0)                            as cost_usd
  from agent_jobs
  where run_id = p_run_id
    and (client_id is null or can_access_client(client_id));
$$;

revoke all on function master_run_progress(uuid) from anon, public;
grant execute on function master_run_progress(uuid) to authenticated;;

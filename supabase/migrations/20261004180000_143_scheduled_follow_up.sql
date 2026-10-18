-- A job that is waiting on somebody else is not a job that failed.
--
-- video_build submits six stills to Higgsfield and then has to wait minutes
-- for them. It reported that wait as a retryable failure, which the queue
-- obliged by retrying three times in about a minute. The attempts ran out
-- while the clips were still rendering, the job went terminal, and six paid
-- renders were left with nothing that would ever collect them. The message
-- even said "it will be polled, not submitted again" — but nothing polled.
--
-- Retries are for work that went wrong. Waiting is not that, and making a
-- retry budget stand in for a timer means the budget runs out at whatever
-- speed the queue happens to loop at, which has nothing to do with how long
-- the provider takes.
--
-- So a job can now say when it is next worth looking at, and the claim skips
-- it until then. Null means now, which is every job that exists today.

alter table agent_jobs add column if not exists run_after timestamptz;

comment on column agent_jobs.run_after is
  'Not claimable before this. Null means immediately, which is the default and every existing job. Set when work is waiting on an external provider rather than being retried after a fault.';

-- Claimable jobs are usually a handful; the index keeps the scan off the
-- long tail of completed ones.
create index if not exists agent_jobs_run_after_idx
  on agent_jobs (run_after)
  where run_after is not null and terminal = false;

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
    -- A non-retryable failure is done, whatever its attempt count says.
    and j.terminal = false
    -- Not yet worth looking at. Null is every job that does not wait on
    -- anybody, which is nearly all of them.
    and (j.run_after is null or j.run_after <= now())
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
$function$;

-- How a runner says "come back to this later".
--
-- Deliberately not enqueue_agent_job_internal, which is revoked from
-- service_role and only reachable from inside another SECURITY DEFINER
-- function. The runtime needs to schedule its own continuation, so it gets a
-- narrow function that does only that.
--
-- Deduped on the same agent and input: a second continuation for work that
-- is already waiting is how a poll turns into a storm. Returns the existing
-- job's id in that case, so the caller cannot tell the difference and does
-- not need to.
create or replace function schedule_agent_follow_up(
  p_agent_key     text,
  p_client_id     uuid,
  p_input_table   text,
  p_input_id      uuid,
  p_after_seconds integer,
  p_description   text default 'Scheduled follow-up'
)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_delay integer := greatest(10, least(coalesce(p_after_seconds, 60), 3600));
  v_due   timestamptz := now() + make_interval(secs => v_delay);
  v_job   uuid;
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
     and j.terminal = false
     and j.status in ('queued', 'claimed', 'running')
   order by j.created_at desc
   limit 1;
  if found then
    return v_job;
  end if;

  insert into agent_jobs (agent_key, client_id, input_table, input_id, params, run_after)
  values (p_agent_key, p_client_id, p_input_table, p_input_id, '{}'::jsonb, v_due)
  returning id into v_job;

  insert into agent_job_events (job_id, description, payload)
  values (v_job, p_description, jsonb_build_object('run_after', v_due, 'after_seconds', v_delay));

  return v_job;
end;
$$;

revoke all on function schedule_agent_follow_up(text, uuid, text, uuid, integer, text)
  from public, anon, authenticated;
grant execute on function schedule_agent_follow_up(text, uuid, text, uuid, integer, text)
  to service_role;

comment on function schedule_agent_follow_up(text, uuid, text, uuid, integer, text) is
  'Queues a continuation of the same work, claimable no earlier than p_after_seconds from now. Deduped on agent and input so waiting cannot become a storm. service_role only: this is a runner scheduling itself.';

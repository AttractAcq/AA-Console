-- Stop overloading `attempts` to mean two different things.
--
-- A non-retryable failure was made terminal by setting attempts to
-- max_attempts, because claim_agent_job only re-picks failed jobs under the
-- cap. That works, but it destroys the truth: a job that failed once and
-- deliberately gave up reports "3 attempts", and the console says "failed
-- after 3 attempts". A missing API key then reads as a flaky, thrice-retried
-- fault rather than the deterministic one it is.
--
-- Terminality gets its own column; attempts stays honest.

alter table agent_jobs
  add column terminal boolean not null default false;

comment on column agent_jobs.terminal is
  'The failure was non-retryable, so the job is finished regardless of attempts. Lets attempts stay truthful.';

-- Existing rows: a failure already at the cap was terminal under the old rule.
update agent_jobs
   set terminal = true
 where status = 'failed' and attempts >= max_attempts;

-- The function below is the existing definition with one clause added:
--   and j.terminal = false
-- Everything else — the service-role guard, the paused/archived checks, the
-- can_run_agent gate that lets a master run enqueue everything up front and
-- still execute in order — is preserved verbatim.
create or replace function claim_agent_job(
  p_lease_owner   text,
  p_lease_seconds integer default 900,
  p_agent_keys    text[] default null
)
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
$function$;;

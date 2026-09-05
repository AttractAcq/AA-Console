-- ============================================================
-- AA Console · 24 · Archiving agents
--
-- The console gained an archive action that reads and writes
-- agents.archived_at, but the column was never created — every query
-- selecting it fails against PostgREST, so the Agents list and the whole
-- Actions tab are broken until this runs.
--
-- Archiving is distinct from pausing: paused means "not right now",
-- archived means "not part of this agency's roster any more". Archived
-- agents drop out of the default list but keep their job history, which
-- is why this is a nullable timestamp rather than a delete.
-- ============================================================

alter table agents add column if not exists archived_at timestamptz;

-- The default list asks for non-archived agents ordered by name.
create index if not exists agents_active_idx
  on agents (name)
  where archived_at is null;

-- ---------- enforce the invariant in the database ----------
-- The UI sets paused = true when archiving, so the existing paused check
-- already covers the normal path. But "an archived agent never runs" is a
-- property of the system, not of one client remembering to set two fields
-- — anything archived directly in SQL must be excluded too.
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

comment on column agents.archived_at is
  'Set when an agent is retired from the roster. Archived agents are hidden from the default list and never have work claimed, independently of paused.';;

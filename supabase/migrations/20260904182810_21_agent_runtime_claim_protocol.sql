-- ============================================================
-- AA Console · 21 · Runtime claim protocol
--
-- Ports the lease-safe claim pattern that has run 146 jobs in the v5
-- runtime. Crash safety comes from the lease, not from a reconciler: if a
-- worker dies mid-job the lease simply expires and the next claim picks
-- the job back up.
-- ============================================================

-- Without an owner, two workers can claim the same row and neither can
-- prove it still holds it. Every state transition asserts on this.
alter table agent_jobs add column if not exists lease_owner text;

create index if not exists agent_jobs_lease_idx
  on agent_jobs (status, lease_until)
  where status in ('claimed', 'running');

-- ---------- claim ----------
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
    -- a paused agent's queued work waits rather than running; this is what
    -- makes the Pause button mean something to the worker
    and a.paused = false
    and (
      j.status = 'queued'
      or (j.status = 'failed' and j.attempts < j.max_attempts)
      -- reclaim anything whose worker died holding it
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

-- ---------- renew ----------
-- Research runs outlive any sane lease, so the worker extends it on a
-- timer. Returns false when the lease has been lost, which tells the
-- worker to stop rather than keep writing.
create or replace function renew_agent_job_lease(
  p_job_id        uuid,
  p_lease_owner   text,
  p_lease_seconds integer default 900
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  if auth.role() <> 'service_role' then
    raise exception 'AUTH: service role required';
  end if;
  if p_lease_seconds not between 30 and 3600 then
    raise exception 'VALIDATION: lease seconds must be between 30 and 3600';
  end if;

  update agent_jobs
     set lease_until = now() + make_interval(secs => p_lease_seconds)
   where id = p_job_id
     and lease_owner = p_lease_owner
     and status in ('claimed', 'running');

  get diagnostics v_count = row_count;
  return v_count = 1;
end;
$$;

revoke all on function claim_agent_job(text, integer, text[]) from public, anon, authenticated;
revoke all on function renew_agent_job_lease(uuid, text, integer) from public, anon, authenticated;
grant execute on function claim_agent_job(text, integer, text[]) to service_role;
grant execute on function renew_agent_job_lease(uuid, text, integer) to service_role;

-- ============================================================
-- Observability
-- ============================================================

-- "Alive but disabled" is a distinct state from "crashed" and from "never
-- deployed". The runtime writes here every 30s regardless of whether its
-- worker loops are enabled.
create table agent_runtime_heartbeats (
  id          uuid primary key default gen_random_uuid(),
  worker_id   text not null,
  status      text not null default 'healthy',
  version     text,
  queue_depth integer,
  active_jobs integer,
  metadata    jsonb not null default '{}'::jsonb,
  reported_at timestamptz not null default now()
);
create index agent_runtime_heartbeats_recent_idx
  on agent_runtime_heartbeats (reported_at desc);

-- Written by withTool() on every call: succeeded, failed, or denied by
-- capability. An audit trail that only records successes is not one.
create table agent_tool_calls (
  id               uuid primary key default gen_random_uuid(),
  job_id           uuid not null references agent_jobs(id) on delete cascade,
  client_id        uuid references clients(id) on delete cascade,
  tool_name        text not null,
  permission_class text not null default 'read',
  input_summary    text,
  output_summary   text,
  status           text not null default 'succeeded',
  error_message    text,
  started_at       timestamptz,
  completed_at     timestamptz,
  created_at       timestamptz not null default now()
);
create index agent_tool_calls_job_idx on agent_tool_calls (job_id, created_at);

alter table agent_runtime_heartbeats enable row level security;
alter table agent_tool_calls         enable row level security;

-- Admin-only reads; all writes are service-role, which bypasses RLS.
create policy heartbeats_admin_read on agent_runtime_heartbeats
  for select to authenticated using (is_admin());
create policy tool_calls_admin_read on agent_tool_calls
  for select to authenticated using (is_admin());

-- ---------- runtime health view ----------
create view agent_runtime_status as
select
  h.worker_id,
  h.status,
  h.version,
  h.queue_depth,
  h.active_jobs,
  h.metadata,
  h.reported_at,
  (now() - h.reported_at) as age,
  -- three missed beats is the point at which "slow" becomes "gone"
  (h.reported_at > now() - interval '90 seconds') as is_live
from agent_runtime_heartbeats h
where h.reported_at = (
  select max(h2.reported_at) from agent_runtime_heartbeats h2 where h2.worker_id = h.worker_id
);

alter view agent_runtime_status set (security_invoker = on);

comment on function claim_agent_job(text, integer, text[]) is
  'Service-only, lease-safe claim of the next runnable agent job. Skips agents that are paused.';
comment on table agent_runtime_heartbeats is
  'Self-reported runtime liveness. Written every 30s even when worker loops are disabled.';;

-- Holding a job, and letting it go again.
--
-- 163 added the status. This is what uses it.
--
-- THE PART THAT IS EASY TO GET WRONG
--
-- A paused job is still a job that exists for a slot, so the tick must count
-- it as in flight. engine_jobs_in_flight and slot_has_job_in_flight both
-- read `status in ('queued','claimed','running')`; without 'paused' in that
-- list, a slot whose job was held would look idle, the tick would queue a
-- second job for it every hour, and each of those would be refused by the
-- cap and failed -- turning one held job into twenty-four failures a day
-- and, the moment the cap lifted, a pile of duplicates.
--
-- claim_agent_job filters on `status = 'queued'` and so needs no change: a
-- paused job is simply not claimed.

-- ---------------------------------------------------------------------------
-- Holding one
-- ---------------------------------------------------------------------------

create or replace function public.pause_agent_job(p_job_id uuid, p_reason text)
returns agent_jobs
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_job agent_jobs;
begin
  if coalesce(auth.role(), '') not in ('service_role', '') then
    raise exception 'Jobs are held by the runtime.' using errcode = 'P0001';
  end if;
  if coalesce(btrim(p_reason), '') = '' then
    raise exception 'Say why it is held: this is what a person reads, and what tells them when it will resume.'
      using errcode = 'P0001';
  end if;

  select * into v_job from agent_jobs where id = p_job_id for update;
  if not found then
    raise exception 'No such job: %.', p_job_id using errcode = 'P0001';
  end if;
  if v_job.status in ('completed', 'cancelled') then
    raise exception 'Job % is %, and finished work is not held.', p_job_id, v_job.status
      using errcode = 'P0001';
  end if;

  update agent_jobs
     set status = 'paused',
         error = p_reason,
         -- The lease goes, so the reaper does not later count this as a
         -- runtime that died.
         lease_owner = null,
         lease_until = null,
         started_at = null,
         completed_at = null,
         terminal = false
   where id = p_job_id;
  -- attempts is deliberately not incremented. Being held is not an attempt,
  -- and counting it would use up a job's retries while it waited.

  select * into v_job from agent_jobs where id = p_job_id;
  return v_job;
end;
$$;

comment on function public.pause_agent_job(uuid, text) is
  'Hold a job for a reason that will pass on its own. Does not count as an attempt, and does not touch the slot: the work is still there.';

revoke all on function public.pause_agent_job(uuid, text) from public, anon;
grant execute on function public.pause_agent_job(uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- Letting it go again
-- ---------------------------------------------------------------------------

-- Re-checks the reason rather than trusting the one recorded. A job held for
-- a cap and an agent that has since been paused must stay held, and the
-- stored reason cannot know that.
create or replace function public.resume_paused_jobs()
returns integer
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  r record;
  v_state record;
  v_count integer := 0;
begin
  if coalesce(auth.role(), '') not in ('service_role', '') then
    raise exception 'Held jobs are resumed by the runtime.' using errcode = 'P0001';
  end if;

  for r in
    select j.id, j.client_id, j.agent_key
      from agent_jobs j
      join agents a on a.agent_key = j.agent_key
     where j.status = 'paused'
       and a.paused = false
       and a.archived_at is null
     order by j.created_at
  loop
    -- The cap, as the database computes it, for the month it is now. A job
    -- held in March is free in April without anybody raising anything.
    if r.client_id is not null then
      select * into v_state from client_budget_state(r.client_id);
      if v_state.capped is true
         and v_state.cap_usd is not null
         and coalesce(v_state.spent_usd, 0) >= v_state.cap_usd then
        continue;
      end if;
    end if;

    update agent_jobs
       set status = 'queued',
           error = null,
           run_after = null
     where id = r.id and status = 'paused';
    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

comment on function public.resume_paused_jobs() is
  'Put back in the queue every held job whose reason has passed: the agent is running again, and the client is inside this month''s cap. Re-checks the reason rather than trusting the one recorded.';

revoke all on function public.resume_paused_jobs() from public, anon;
grant execute on function public.resume_paused_jobs() to service_role;

-- ---------------------------------------------------------------------------
-- The tick must count a held job as in flight
-- ---------------------------------------------------------------------------

-- See the header. Without 'paused' here, one held job becomes a new job
-- every hour, each refused and failed, and a pile of duplicates the moment
-- the cap lifts.
create or replace function public.engine_jobs_in_flight(p_client_id uuid)
returns integer
language sql
stable
set search_path to 'public'
as $$
  select count(*)::integer
  from agent_jobs j
  where j.client_id = p_client_id
    and j.params ? 'slot_id'
    and j.status in ('queued', 'paused', 'claimed', 'running');
$$;

comment on function public.engine_jobs_in_flight(uuid) is
  'Engine jobs this client currently has queued, held or running. Counted by the slot_id in params, so only the engine''s own work counts against its cap. A held job counts: it is work that exists and will resume.';

create or replace function public.slot_has_job_in_flight(p_slot_id uuid)
returns boolean
language sql
stable
set search_path to 'public'
as $$
  select exists (
    select 1 from agent_jobs j
    where j.params->>'slot_id' = p_slot_id::text
      and j.status in ('queued', 'paused', 'claimed', 'running')
  );
$$;

comment on function public.slot_has_job_in_flight(uuid) is
  'Whether this slot already has something working on it, held work included. Without the held case the tick would queue a second job for it every hour.';

-- ---------------------------------------------------------------------------
-- What is being held, and why
-- ---------------------------------------------------------------------------

create or replace view held_jobs with (security_invoker = true) as
select
  j.id as job_id,
  j.client_id,
  c.name as client_name,
  j.agent_key,
  a.name as agent_name,
  j.error as held_because,
  j.created_at,
  now() - j.created_at as waiting_for,
  j.params->>'slot_id' as slot_id,
  -- Whether the thing that held it has passed. The resume runs hourly, so a
  -- true here that stays true is a resume that is not running.
  (a.paused = false and a.archived_at is null
    and (j.client_id is null
         or not coalesce((select bs.capped and bs.cap_usd is not null
                                 and coalesce(bs.spent_usd, 0) >= bs.cap_usd
                            from client_budget_state(j.client_id) bs), false)))
    as would_resume_now
from agent_jobs j
join agents a on a.agent_key = j.agent_key
left join clients c on c.id = j.client_id
where j.status = 'paused';

comment on view held_jobs is
  'Every job being held, why, and whether the reason has passed. A row where would_resume_now stays true is a resume that is not running.';

grant select on held_jobs to authenticated;

-- ---------------------------------------------------------------------------
-- Hourly, and so a month roll resumes on its own
-- ---------------------------------------------------------------------------

-- Ten past, so it runs after the engine tick at seven past rather than
-- racing it.
select cron.unschedule('resume-paused-jobs') where exists (
  select 1 from cron.job where jobname = 'resume-paused-jobs');

select cron.schedule('resume-paused-jobs', '10 * * * *', $cron$ select public.resume_paused_jobs(); $cron$);

select public.lock_down_definer_functions();

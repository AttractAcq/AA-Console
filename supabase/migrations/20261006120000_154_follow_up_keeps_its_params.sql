-- A scheduled follow-up keeps the params of the job that scheduled it.
--
-- schedule_agent_follow_up (143) inserts params = '{}'. That was harmless
-- when the only thing in params was provider bookkeeping. It stopped being
-- harmless the moment the engine started putting slot_id there.
--
-- The tick asks "is anything already working on this slot" with
-- slot_has_job_in_flight, which matches params->>'slot_id'. A follow-up with
-- empty params is invisible to that question. So: video_build submits six
-- clips, says "still rendering", schedules a follow-up and completes; an hour
-- later the tick sees a slot at 'building' with — as far as it can tell —
-- nothing working on it, and queues a second video_build. Six more paid
-- renders for a post that was already being made.
--
-- That is the same failure that stranded six Higgsfield clips earlier in this
-- project, arriving by a different route: the first time, a wait was mistaken
-- for a retryable failure; this time a wait would be invisible to the thing
-- deciding whether to start again.
--
-- Carrying the params through fixes it at the source rather than teaching the
-- tick about follow-ups, because every future question about "what is this
-- job for" should get the same answer whether the job was queued directly or
-- scheduled.

-- Dropped first, not replaced. Adding a defaulted parameter makes an
-- overload rather than a new definition, and then every six-argument call --
-- which is all of them -- is ambiguous between the two. schedule_asset in
-- migration 144 had to be dropped for the same reason.
drop function if exists public.schedule_agent_follow_up(text, uuid, text, uuid, integer, text);

create or replace function public.schedule_agent_follow_up(
  p_agent_key text,
  p_client_id uuid,
  p_input_table text,
  p_input_id uuid,
  p_after_seconds integer,
  p_description text default 'Scheduled follow-up'::text,
  -- Defaulted, so every existing caller keeps working unchanged and gets the
  -- old behaviour exactly.
  p_params jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $function$
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
  values (p_agent_key, p_client_id, p_input_table, p_input_id,
          coalesce(p_params, '{}'::jsonb), v_due)
  returning id into v_job;

  insert into agent_job_events (job_id, description, payload)
  values (v_job, p_description, jsonb_build_object('run_after', v_due, 'after_seconds', v_delay));

  return v_job;
end;
$function$;

comment on function public.schedule_agent_follow_up is
  'Queue a job to run later. Carries params through, so a follow-up for a slot is still visible as work on that slot.';

revoke all on function public.schedule_agent_follow_up(
  text, uuid, text, uuid, integer, text, jsonb) from public;
grant execute on function public.schedule_agent_follow_up(
  text, uuid, text, uuid, integer, text, jsonb) to service_role;

-- The hourly tick. The first part of the engine that spends money.
--
-- M3.4. Every hour: for each client whose engine is on and whose month is
-- under its cap, fill the horizon, then queue the next job for each slot that
-- is ready and has nothing already running.
--
-- Everything else in M3 so far has been inert -- tables, a state machine, and
-- arithmetic that writes rows. This is the piece that reaches the job queue,
-- so it is built to be stopped in four independent ways, any one of which is
-- sufficient:
--
--   1. engine_controls.enabled -- one global switch, off by default and off
--      on the row this migration creates. The cron schedule below is live
--      from the moment this applies, and does nothing at all until it is
--      turned on. That is deliberate: a schedule that has never run is not
--      evidence that it works.
--   2. client_engine_settings.enabled -- per client, off by default (146).
--   3. client_engine_budgets -- a client with no cap for the month is
--      skipped, and so is one that has spent it. No cap means no spending,
--      not unlimited spending.
--   4. client_engine_settings.max_jobs_in_flight -- a cap on how much of the
--      queue one client may occupy at once.
--
-- One client's failure must not stop the others, so each client is handled in
-- its own exception block and a failure is recorded rather than raised.
--
-- The budget is read directly here rather than through client_budget_state,
-- which is guarded by `auth.role() = 'service_role' or can_access_client()`.
-- pg_cron runs with no auth context at all, so that guard returns no rows and
-- the tick would read every client as uncapped. Precisely the wrong way round.

-- ---------------------------------------------------------------------------
-- The global switch
-- ---------------------------------------------------------------------------

create table if not exists engine_controls (
  -- One row, enforced. A second row would be a second opinion about whether
  -- the engine is running.
  id boolean primary key default true,
  enabled boolean not null default false,
  -- Why it is off, for whoever finds it off and wonders.
  note text,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null,
  constraint engine_controls_single_row check (id)
);

insert into engine_controls (id, enabled, note)
values (true, false, 'Off until the engine has been watched running on staging.')
on conflict (id) do nothing;

comment on table engine_controls is
  'The one global switch for the engine, off by default. Independent of the per-client switch: both must be on for anything to be queued.';

alter table engine_controls enable row level security;

drop policy if exists ec_read on engine_controls;
create policy ec_read on engine_controls for select to authenticated using (true);

drop policy if exists ec_admin on engine_controls;
create policy ec_admin on engine_controls for all to authenticated
  using (is_admin()) with check (is_admin());

grant select on engine_controls to authenticated;

create or replace function public.set_engine_running(p_enabled boolean, p_note text default null)
returns engine_controls
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_row engine_controls;
begin
  if not is_admin() then
    raise exception 'Only an admin starts or stops the engine.';
  end if;
  update engine_controls
     set enabled = p_enabled, note = p_note, updated_at = now(), updated_by = auth.uid()
   where id
  returning * into v_row;
  return v_row;
end;
$$;

comment on function public.set_engine_running(boolean, text) is
  'The global stop. Admin only. Turning this off stops every client at once without changing any client''s own setting.';

revoke all on function public.set_engine_running(boolean, text) from public;
grant execute on function public.set_engine_running(boolean, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Which agent does the work for a slot at each stage
-- ---------------------------------------------------------------------------

-- Data, like slot_transitions, so the pipeline can be read and rendered
-- rather than transcribed. A stage with no row here is a stage the tick does
-- not act on, which is how copywriting and qa behave until M3.8 and M3.9
-- register themselves: slots rest there visibly instead of vanishing.
create table if not exists slot_pipeline (
  stage slot_stage not null,
  -- Null matches any format. A row with a format wins over one without.
  format content_format,
  agent_key text not null references agents(agent_key) on delete cascade,
  -- Move the slot here before queueing. Null means it is already in the stage
  -- the work belongs to, having been put there by the agent before it.
  enter_stage slot_stage,
  note text
);

-- Not a primary key: a primary key forbids nulls, and "this row applies to
-- any format" is exactly a null format. nulls not distinct keeps the rule
-- that a stage may have at most one format-agnostic row.
create unique index if not exists slot_pipeline_key
  on slot_pipeline (stage, format) nulls not distinct;

comment on table slot_pipeline is
  'Which agent the tick queues for a slot at each stage, and the stage to move it into first. A stage absent from here is one the tick leaves alone.';

insert into slot_pipeline (stage, format, agent_key, enter_stage, note) values
  ('planned',       null,   'ideation',       'ideating', 'Ideas for the slot''s pillar and format.'),
  ('idea_selected', null,   'brief',          'briefing', 'Turn the chosen idea into a brief.'),
  ('building',      null,   'creative_build', null,       'Make the asset.'),
  ('building',      'reel', 'video_build',    null,       'A reel is built by the reel pipeline.')
on conflict (stage, format) do nothing;

-- ---------------------------------------------------------------------------
-- What each tick did
-- ---------------------------------------------------------------------------

-- Principle five of the build plan: nothing silent. A queue that fills with
-- no record of why is what distribution_due was written to fix, and this is
-- a much better place to not repeat that.
create table if not exists engine_tick_runs (
  id uuid primary key default gen_random_uuid(),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  clients_considered integer not null default 0,
  clients_skipped integer not null default 0,
  slots_planned integer not null default 0,
  jobs_queued integer not null default 0,
  -- One line per client the tick decided not to act on, and why.
  notes jsonb not null default '[]'::jsonb
);

comment on table engine_tick_runs is
  'One row per tick: what it considered, what it skipped and why, what it planned and queued.';

create index if not exists engine_tick_runs_started_idx on engine_tick_runs (started_at desc);

alter table engine_tick_runs enable row level security;

drop policy if exists etr_read on engine_tick_runs;
create policy etr_read on engine_tick_runs for select to authenticated using (is_admin());

grant select on engine_tick_runs to authenticated;

-- ---------------------------------------------------------------------------
-- How much of the queue a client is already using
-- ---------------------------------------------------------------------------

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
    and j.status in ('queued', 'claimed', 'running');
$$;

comment on function public.engine_jobs_in_flight(uuid) is
  'Engine jobs this client currently has queued or running. Counted by the slot_id in params, so only the engine''s own work counts against its cap.';

-- Whether this particular slot already has something working on it. Without
-- this the tick would queue a second job for the same slot every hour until
-- the first one finished.
create or replace function public.slot_has_job_in_flight(p_slot_id uuid)
returns boolean
language sql
stable
set search_path to 'public'
as $$
  select exists (
    select 1 from agent_jobs j
    where j.params->>'slot_id' = p_slot_id::text
      and j.status in ('queued', 'claimed', 'running')
  );
$$;

-- ---------------------------------------------------------------------------
-- The tick
-- ---------------------------------------------------------------------------

create or replace function public.engine_tick(p_now timestamptz default now())
returns engine_tick_runs
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_run engine_tick_runs;
  v_notes jsonb := '[]'::jsonb;
  v_considered integer := 0;
  v_skipped integer := 0;
  v_planned integer := 0;
  v_queued integer := 0;
  v_running boolean;
  v_month date := date_trunc('month', p_now)::date;
  v_cap numeric;
  v_spent numeric;
  v_in_flight integer;
  v_plan record;
  v_job uuid;
  v_work record;
  c record;
  s record;
begin
  insert into engine_tick_runs default values returning * into v_run;

  select enabled into v_running from engine_controls where id;
  if not coalesce(v_running, false) then
    update engine_tick_runs
       set finished_at = now(),
           notes = jsonb_build_array(jsonb_build_object('reason', 'The engine is switched off globally.'))
     where id = v_run.id
    returning * into v_run;
    return v_run;
  end if;

  for c in
    -- Aliased ces, not s: s is a record variable declared above, and
    -- PL/pgSQL resolves a qualified name against its own variables before
    -- the query's aliases. The collision reads as "record s is not assigned
    -- yet", which points nowhere near the actual line.
    select ces.client_id, ces.max_jobs_in_flight
    from client_engine_settings ces
    where ces.enabled
    order by ces.client_id
  loop
    v_considered := v_considered + 1;

    -- Each client in its own block: one client's broken configuration must
    -- not stop the rest of the tick.
    begin
      -- Budget. No cap for the month means no spending, not unlimited
      -- spending: a client nobody has given a budget has not been cleared
      -- to spend one.
      select b.cap_usd into v_cap
        from client_engine_budgets b
       where b.client_id = c.client_id and b.month = v_month;

      if v_cap is null then
        v_skipped := v_skipped + 1;
        v_notes := v_notes || jsonb_build_object(
          'client_id', c.client_id, 'reason', 'No spend cap set for this month.');
        continue;
      end if;

      v_spent := coalesce(agent_spend_for_client(c.client_id, v_month), 0);
      if v_spent >= v_cap then
        v_skipped := v_skipped + 1;
        v_notes := v_notes || jsonb_build_object(
          'client_id', c.client_id, 'reason', 'Over the monthly cap.',
          'cap_usd', v_cap, 'spent_usd', v_spent);
        continue;
      end if;

      -- Fill the horizon. Cheap, idempotent, and writes no jobs.
      select * into v_plan from plan_slots(c.client_id, p_now);
      v_planned := v_planned + coalesce(v_plan.created, 0);

      v_in_flight := engine_jobs_in_flight(c.client_id);

      for s in
        select sl.id, sl.stage, sl.format, sl.client_id
        from content_slots sl
        where sl.client_id = c.client_id
          and sl.stage not in ('awaiting_approval', 'scheduled', 'published', 'failed', 'rejected')
        -- Soonest first: the post that goes out next is the one that needs
        -- making next.
        order by sl.scheduled_at, sl.id
      loop
        exit when v_in_flight >= c.max_jobs_in_flight;

        -- The format-specific row wins over the format-agnostic one.
        select * into v_work
          from slot_pipeline p
         where p.stage = s.stage and (p.format = s.format or p.format is null)
         order by (p.format is null)
         limit 1;

        -- No agent for this stage yet: the slot rests here and says so on
        -- the board, rather than being silently dropped.
        continue when not found;
        continue when slot_has_job_in_flight(s.id);

        if v_work.enter_stage is not null then
          perform advance_slot(
            s.id, v_work.enter_stage, 'engine',
            format('Queued %s.', v_work.agent_key), v_work.agent_key);
        end if;

        v_job := enqueue_agent_job_internal(
          v_work.agent_key,
          s.client_id,
          'content_slots',
          s.id,
          null,
          jsonb_build_object('slot_id', s.id, 'source', 'engine'),
          format('Engine: %s for a %s slot.', v_work.agent_key, s.format));

        v_queued := v_queued + 1;
        v_in_flight := v_in_flight + 1;
      end loop;

    exception when others then
      v_skipped := v_skipped + 1;
      v_notes := v_notes || jsonb_build_object(
        'client_id', c.client_id, 'reason', 'The tick failed for this client.', 'error', sqlerrm);
    end;
  end loop;

  update engine_tick_runs
     set finished_at = now(),
         clients_considered = v_considered,
         clients_skipped = v_skipped,
         slots_planned = v_planned,
         jobs_queued = v_queued,
         notes = v_notes
   where id = v_run.id
  returning * into v_run;

  return v_run;
end;
$$;

comment on function public.engine_tick(timestamptz) is
  'One pass of the engine: plan the horizon and queue the next job for every ready slot, for every client that is switched on and under its cap. Does nothing at all while engine_controls.enabled is false.';

revoke all on function public.engine_tick(timestamptz) from public;
-- Only the service role and cron run this. It is not something a signed-in
-- person should be able to trigger by hand from the browser.
grant execute on function public.engine_tick(timestamptz) to service_role;

-- ---------------------------------------------------------------------------
-- The schedule
-- ---------------------------------------------------------------------------

-- Scheduled now, doing nothing until the global switch is turned on. A cron
-- entry that has never fired is not evidence that it works, and the hour it
-- is first needed is the wrong hour to discover a typo in the schedule.
select cron.unschedule('engine-tick') where exists (
  select 1 from cron.job where jobname = 'engine-tick');

select cron.schedule('engine-tick', '7 * * * *', $cron$ select public.engine_tick(); $cron$);

-- ---------------------------------------------------------------------------
-- Watching it
-- ---------------------------------------------------------------------------

create or replace view engine_activity with (security_invoker = true) as
select
  r.id,
  r.started_at,
  r.finished_at - r.started_at as took,
  r.clients_considered,
  r.clients_skipped,
  r.slots_planned,
  r.jobs_queued,
  r.notes
from engine_tick_runs r
order by r.started_at desc;

comment on view engine_activity is
  'The last ticks, newest first, with what each one did and every client it skipped.';

grant select on engine_activity to authenticated;

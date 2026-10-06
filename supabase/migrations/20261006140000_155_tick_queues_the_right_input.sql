-- The tick points each agent at the thing that agent expects.
--
-- Until now it queued everything with input_table = 'content_slots' and the
-- slot's id, which is what the tick knows. That works for the agents written
-- against the engine -- ideation, idea_select, copywriter all read the slot
-- from params -- and breaks every agent that existed first:
--
--   brief reads client_ideas by input_id, so it was handed a slot id and
--   reported "That idea no longer exists."
--   video_build refuses anything whose input_table is not client_briefs, so
--   it failed on the first line.
--   creative_build loads its brief the same way.
--
-- The fix is not to teach three working agents about slots. Their contracts
-- are right: a brief agent takes an idea, a builder takes a brief. The tick
-- is the thing that knows both the slot and every id hanging off it, so the
-- tick is where the translation belongs.
--
-- slot_pipeline therefore says, per stage, which table the agent wants and
-- which column of the slot holds the id. slot_id stays in params either way,
-- so the hand-off back is unchanged and an agent that wants the slot can
-- still have it.

alter table slot_pipeline
  add column if not exists input_table text,
  add column if not exists input_column text;

comment on column slot_pipeline.input_table is
  'The table this agent expects to be pointed at. Null means the slot itself, for agents written against the engine.';
comment on column slot_pipeline.input_column is
  'Which column of content_slots holds the id to pass. Null means the slot''s own id.';

-- Only the columns an agent could sensibly be pointed at, so a typo here
-- cannot make the tick read something arbitrary off the slot.
alter table slot_pipeline drop constraint if exists slot_pipeline_input_column;
alter table slot_pipeline add constraint slot_pipeline_input_column
  check (input_column is null or input_column in ('idea_id', 'brief_id', 'asset_id'));

update slot_pipeline set input_table = 'client_ideas',  input_column = 'idea_id'
 where stage = 'idea_selected';
update slot_pipeline set input_table = 'client_briefs', input_column = 'brief_id'
 where stage = 'building';

-- ---------------------------------------------------------------------------
-- The tick, with the translation
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
  v_input_table text;
  v_input_id uuid;
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
    select ces.client_id, ces.max_jobs_in_flight
    from client_engine_settings ces
    where ces.enabled
    order by ces.client_id
  loop
    v_considered := v_considered + 1;

    begin
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

      select * into v_plan from plan_slots(c.client_id, p_now);
      v_planned := v_planned + coalesce(v_plan.created, 0);

      v_in_flight := engine_jobs_in_flight(c.client_id);

      for s in
        select sl.id, sl.stage, sl.format, sl.client_id, sl.idea_id, sl.brief_id, sl.asset_id
        from content_slots sl
        where sl.client_id = c.client_id
          and sl.stage not in ('awaiting_approval', 'scheduled', 'published', 'failed', 'rejected')
        order by sl.scheduled_at, sl.id
      loop
        exit when v_in_flight >= c.max_jobs_in_flight;

        select * into v_work
          from slot_pipeline p
         where p.stage = s.stage and (p.format = s.format or p.format is null)
         order by (p.format is null)
         limit 1;

        continue when not found;
        continue when slot_has_job_in_flight(s.id);

        -- What this agent expects to be handed.
        v_input_table := coalesce(v_work.input_table, 'content_slots');
        v_input_id := case v_work.input_column
          when 'idea_id'  then s.idea_id
          when 'brief_id' then s.brief_id
          when 'asset_id' then s.asset_id
          else s.id
        end;

        -- The slot says it is ready for this stage but the thing the stage
        -- works on is not there. Queueing anyway would hand the agent a null
        -- and get back a failure that blames the agent.
        if v_input_id is null then
          v_notes := v_notes || jsonb_build_object(
            'client_id', c.client_id, 'slot_id', s.id,
            'reason', format('Slot is at %s but has no %s.', s.stage, v_work.input_column));
          continue;
        end if;

        if v_work.enter_stage is not null then
          perform advance_slot(
            s.id, v_work.enter_stage, 'engine',
            format('Queued %s.', v_work.agent_key), v_work.agent_key);
        end if;

        v_job := enqueue_agent_job_internal(
          v_work.agent_key,
          s.client_id,
          v_input_table,
          v_input_id,
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
  'One pass of the engine: plan the horizon and queue the next job for every ready slot, pointing each agent at the input it expects. Does nothing while engine_controls.enabled is false.';

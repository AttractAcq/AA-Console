-- B066-adjacent / 282: the engine's own configuration, and a readiness line
-- that does not lie.
--
-- The autonomous loop is already built and already running. `engine_tick()`
-- fires hourly on cron, plans slots from the client's platforms, pillars and
-- posting windows, then walks every live slot through `slot_pipeline` --
-- ideation, idea_select, brief, creative_build or video_build, video_edit,
-- copywriter, qa -- queueing the right agent for each stage and stopping at
-- `awaiting_approval`, which is the distribution boundary. Nine stages, all
-- mapped, all implemented.
--
-- Every tick for the last several hours recorded the same note:
--
--   "The engine is switched off globally."
--
-- So nothing was broken. The loop was faithful and had nothing it was
-- allowed to do. It has three gates, and two of them had no writer anywhere
-- in the system -- not a function, not a policy, not a screen.
--
-- WHAT HAD NO WAY IN
--
-- `client_engine_budgets.cap_usd` for the current month. `engine_tick` skips
-- any client with no cap for the month it is running in, and says so. It is
-- also the only blocker `engine_readiness` was reporting, which made it the
-- one thing an operator was told to fix and could not. Nothing wrote this
-- table: it appears in the generated types and in tests, and nowhere else.
--
-- `clients.timezone`. It decides which local day and hour a planned slot
-- lands on, and 281's booking windows are read in the client's zone too. AA
-- has carried `Europe/London` while operating on UTC+2, so every slot this
-- engine planned would have been two hours out. No function or screen set it.
--
-- WHY THE READINESS LINE COULD SAY "RUNNING" WHILE NOTHING RAN
--
-- `engine_readiness` checked configuration, the client switch and the cap,
-- and never the global switch. With the cap set and the client switched on it
-- would read "Running" while `engine_controls.enabled` was false and the tick
-- refused every hour. An operator would have had no way to tell from the
-- screen that the thing it called running was stopped.
--
-- It also never showed whether the pipeline can advance without a person.
-- `approve_idea_by_policy` raises "This client has not switched on policy
-- approval of ideas" when `auto_approve_ideas` is off, so a slot reaches
-- `ideating`, the selector fails, and the slot parks at the second of nine
-- stages. The same holds for briefs. A client can therefore be "Running" and
-- still need a person at stage two, which is the opposite of what the word
-- implies. Both flags are now on the row, so the screen can say so.
--
-- WHAT THIS DOES NOT DO
--
-- It sets nothing and switches nothing on. It adds the two writers that were
-- missing and makes the readiness row tell the whole truth. The global
-- switch, the client switch and the policy-approval flags keep their existing
-- writers, which require a signed-in person, because each of them is a
-- decision that should carry a name.

-- ---------------------------------------------------------------------------
-- The monthly spend cap
-- ---------------------------------------------------------------------------

create or replace function public.set_client_engine_budget_v6(
  p_client_id uuid,
  p_month date,
  p_cap_usd numeric,
  p_note text default null
) returns public.client_engine_budgets
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare
  v_row public.client_engine_budgets;
  v_month date := date_trunc('month', coalesce(p_month, current_date))::date;
begin
  if not public.can_access_client(p_client_id) then
    raise exception 'Not permitted for this client';
  end if;

  if p_cap_usd is null or p_cap_usd <= 0 then
    raise exception 'A spend cap has to be a positive amount. A cap of zero stops the engine rather than configuring it; switch the client off instead.';
  end if;

  -- The engine spends against this figure without asking again, so a typed
  -- extra zero is the realistic mistake and it is worth refusing rather than
  -- discovering in a provider bill.
  if p_cap_usd > 10000 then
    raise exception 'A monthly cap above 10000 USD needs a deliberate change to this limit. Received %.', p_cap_usd;
  end if;

  -- A cap for a month already gone cannot restrain anything: the engine only
  -- ever reads the month it is ticking in.
  if v_month < date_trunc('month', current_date)::date then
    raise exception 'That month has already passed. A cap can only be set for the current month or a later one.';
  end if;

  insert into public.client_engine_budgets as b (client_id, month, cap_usd, note)
  values (p_client_id, v_month, p_cap_usd, nullif(btrim(coalesce(p_note, '')), ''))
  on conflict (client_id, month) do update
     set cap_usd = excluded.cap_usd,
         note = coalesce(excluded.note, b.note),
         updated_at = now()
  returning b.* into v_row;

  return v_row;
end $$;

comment on function public.set_client_engine_budget_v6(uuid, date, numeric, text) is
  'Sets the monthly AI spend cap engine_tick reads before it plans anything. Without a cap for the month it is ticking in, the engine skips the client and says so.';

-- ---------------------------------------------------------------------------
-- The client's own timezone
-- ---------------------------------------------------------------------------

create or replace function public.set_client_timezone_v6(
  p_client_id uuid,
  p_timezone text
) returns public.clients
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare
  v_row public.clients;
  v_zone text := btrim(coalesce(p_timezone, ''));
begin
  if not public.can_access_client(p_client_id) then
    raise exception 'Not permitted for this client';
  end if;

  -- The same check 281 makes for booking: a zone the server does not know
  -- would put every planned slot and every offered call at the wrong local
  -- time, and it would surface as posts going out overnight rather than as
  -- an error here.
  if v_zone = '' or not exists (
       select 1 from pg_catalog.pg_timezone_names where name = v_zone) then
    raise exception 'Unknown timezone: %. Use an IANA name such as Africa/Johannesburg.', p_timezone;
  end if;

  update public.clients set timezone = v_zone where id = p_client_id
  returning * into v_row;
  if not found then
    raise exception 'No such client.';
  end if;

  return v_row;
end $$;

comment on function public.set_client_timezone_v6(uuid, text) is
  'Sets the zone every planned slot, posting window and booking window is read in. Validated against the server''s own zone list.';

-- ---------------------------------------------------------------------------
-- A readiness row that accounts for every gate
-- ---------------------------------------------------------------------------

-- Columns are added at the end so this stays a replace rather than a drop:
-- the browser reads this view and a drop would take it away mid-session.
-- security_invoker stays on: without it the view runs as its owner and the
-- caller's row-level security on clients and settings stops applying.
-- create or replace does not carry the option over, so it is restated.
create or replace view public.engine_readiness
  with (security_invoker = true) as
 select c.id as client_id,
    c.name as client_name,
    c.timezone,
    coalesce(s.enabled, false) as enabled,
    s.plan_horizon_days,
    s.approval_mode,
    coalesce(p.platforms, 0::bigint) as active_platforms,
    coalesce(p.posts_per_week, 0::bigint) as posts_per_week,
    coalesce(w.windows, 0::bigint) as posting_windows,
    coalesce(pl.pillars, 0::bigint) as active_pillars,
    b.cap_usd as month_cap_usd,
        case
            when s.client_id is null then 'Not configured'::text
            when coalesce(p.platforms, 0::bigint) = 0 then 'No platform with a cadence'::text
            when coalesce(w.windows, 0::bigint) = 0 then 'No posting windows'::text
            when coalesce(pl.pillars, 0::bigint) = 0 then 'No active content pillars'::text
            when b.cap_usd is null then 'No spend cap set'::text
            when not s.enabled then 'Ready, switched off'::text
            -- Before "Running", because this one is not the client's fault
            -- and no amount of client configuration clears it.
            when not coalesce((select ec.enabled from public.engine_controls ec where ec.id), false)
              then 'Ready and switched on, but the engine is off globally'::text
            -- Running, and a person is still needed at the second of nine
            -- stages. Said plainly rather than hidden behind "Running".
            when not coalesce(s.auto_approve_ideas, false)
              then 'Running, but a person must choose each idea'::text
            when not coalesce(s.auto_approve_briefs, false)
              then 'Running, but a person must approve each brief'::text
            else 'Running'::text
        end as readiness,
    coalesce((select ec.enabled from public.engine_controls ec where ec.id), false) as engine_running,
    (coalesce(s.auto_approve_ideas, false) and coalesce(s.auto_approve_briefs, false)) as advances_without_a_person
   from public.clients c
     left join public.client_engine_settings s on s.client_id = c.id
     left join ( select client_engine_platforms.client_id,
            count(*) as platforms,
            sum(client_engine_platforms.posts_per_week) as posts_per_week
           from public.client_engine_platforms
          where client_engine_platforms.active and client_engine_platforms.posts_per_week > 0
          group by client_engine_platforms.client_id) p on p.client_id = c.id
     left join ( select client_engine_windows.client_id,
            count(*) as windows
           from public.client_engine_windows
          group by client_engine_windows.client_id) w on w.client_id = c.id
     left join ( select client_content_pillars.client_id,
            count(*) as pillars
           from public.client_content_pillars
          where client_content_pillars.active
          group by client_content_pillars.client_id) pl on pl.client_id = c.id
     left join public.client_engine_budgets b
       on b.client_id = c.id and b.month = date_trunc('month'::text, now())::date;

comment on view public.engine_readiness is
  'Whether this client''s content engine can run, accounting for every gate engine_tick reads: configuration, the monthly cap, the client switch, the global switch, and whether the pipeline can advance past idea and brief without a person.';

-- ---------------------------------------------------------------------------
-- Exposure
-- ---------------------------------------------------------------------------

revoke all on function public.set_client_engine_budget_v6(uuid, date, numeric, text) from public;
revoke all on function public.set_client_timezone_v6(uuid, text) from public;

-- Configuring a client is a signed-in person's job, and can_access_client
-- decides which client. No sweep sets a spend cap or a timezone.
grant execute on function public.set_client_engine_budget_v6(uuid, date, numeric, text) to authenticated;
grant execute on function public.set_client_timezone_v6(uuid, text) to authenticated;

grant select on public.engine_readiness to authenticated;

select lock_down_definer_functions();

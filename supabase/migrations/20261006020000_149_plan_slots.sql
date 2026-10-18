-- Filling the calendar. Arithmetic, not a model.
--
-- M3.3. plan_slots walks the client's horizon day by day in their own
-- timezone, finds the posting windows on each day, takes as many as the
-- cadence asks for in each week, and plans a slot in each one it takes.
--
-- Deterministic on purpose, and that word is doing real work here. The same
-- inputs produce the same calendar, every time, so an hourly tick can call
-- this repeatedly without the plan wandering. Nothing random, nothing that
-- asks a model, nothing that depends on the order rows come back in: every
-- query that feeds a decision is explicitly ordered.
--
-- Running it twice creates nothing the second time. That is not bookkeeping
-- inside this function -- it is the unique index on (client, platform,
-- instant) from migration 147, and create_content_slot returning the slot
-- that is already there. A planner that kept its own record of what it had
-- planned would be a second source of truth about the calendar.
--
-- Three rules worth knowing before reading the code:
--
--   Cadence is capped by windows. A client asking for five posts a week with
--   three windows gets three. The alternative is stacking two posts into one
--   window, which is not what a window means. engine_readiness and the panel
--   are where that mismatch should be made visible; silently inventing a
--   fourth slot at an hour nobody chose is worse than planning three.
--
--   A window that already has a post is not free. That includes posts a
--   person scheduled by hand: the engine fills gaps, it does not compete for
--   the slot a human already took.
--
--   Pillars and formats are assigned by position, not by chance. Each gets a
--   hundred-entry sequence weighted by its share and interleaved, and each
--   new slot takes the next entry. Over a horizon the proportions come out
--   at the target; over three slots they do not, which is arithmetic rather
--   than a bug.

-- The weighted, interleaved sequence a mix turns into.
--
-- Each key is spread evenly across the whole sequence rather than repeated in
-- a block, so that *any prefix* approximates the target shares -- which is
-- what matters, because a horizon consumes far fewer than a hundred slots.
--
-- The first version of this ordered by the repeat counter, which alternates
-- perfectly until the smaller share runs out and then emits the surplus in a
-- block at the end. Over the full cycle the proportions were right; over the
-- first forty entries 60/40 came out as exactly 50/50, which is the only part
-- anyone would ever see. Placing the jth of c occurrences at (j - 0.5) / c
-- spreads each key across the line instead, so the proportion holds wherever
-- you stop reading.
create or replace function public.weighted_sequence(p_weights jsonb)
returns text[]
language sql
immutable
set search_path to 'public'
as $$
  with entries as (
    select key, greatest((value)::numeric, 0) as weight
    from jsonb_each_text(p_weights) as e(key, value)
    where (value ~ '^[0-9]+(\.[0-9]+)?$')
  ),
  total as (select nullif(sum(weight), 0) as t from entries),
  counted as (
    select e.key, greatest(1, round(100 * e.weight / t.t)::int) as c
    from entries e cross join total t
    where t.t is not null and e.weight > 0
  ),
  spread as (
    select c.key, (generate_series(1, c.c) - 0.5) / c.c as pos
    from counted c
  )
  select coalesce(array_agg(key order by pos, key), array[]::text[]) from spread;
$$;

comment on function public.weighted_sequence(jsonb) is
  'A mix like {"a": 50, "b": 50} as a repeating, interleaved sequence of about a hundred entries. Deterministic: same weights, same sequence.';

-- ---------------------------------------------------------------------------
-- The planner
-- ---------------------------------------------------------------------------

create or replace function public.plan_slots(
  p_client_id uuid,
  -- Injectable so a test can plan a known week rather than whatever week it
  -- happens to run in, and so a dry run can look at a future horizon.
  p_now timestamptz default now()
)
returns table (created integer, skipped integer, capped boolean)
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_settings client_engine_settings;
  v_tz text;
  v_from date;
  v_to date;
  v_created integer := 0;
  v_skipped integer := 0;
  v_capped boolean := false;
  v_pillars text[];
  v_formats text[];
  v_ordinal bigint;
  v_pillar uuid;
  v_format content_format;
  r record;
begin
  select * into v_settings from client_engine_settings where client_id = p_client_id;
  if not found or not v_settings.enabled then
    -- The planner creates work, and work costs money. A client whose engine
    -- is off has said no to that, and a preview is not worth a back door.
    raise exception 'The engine is not on for this client, so there is nothing to plan.'
      using errcode = 'P0001';
  end if;

  v_tz := client_timezone(p_client_id);
  v_from := (p_now at time zone v_tz)::date;
  v_to := v_from + v_settings.plan_horizon_days;

  v_pillars := (
    select weighted_sequence(coalesce(jsonb_object_agg(p.id::text, greatest(p.target_share, 0)), '{}'::jsonb))
    from client_content_pillars p
    where p.client_id = p_client_id and p.active and p.target_share > 0
  );
  v_formats := weighted_sequence(v_settings.format_mix);

  if coalesce(array_length(v_pillars, 1), 0) = 0 then
    raise exception 'This client has no active pillar with a share, so a slot would have nothing to be about.'
      using errcode = 'P0001';
  end if;
  if coalesce(array_length(v_formats, 1), 0) = 0 then
    raise exception 'This client''s format mix is empty.' using errcode = 'P0001';
  end if;

  -- Where in the sequence to carry on from. Counting what is already planned
  -- means a second horizon continues the mix rather than restarting it.
  select count(*) into v_ordinal from content_slots where client_id = p_client_id;

  for r in
    -- Every window in the horizon, as an instant, with its position in its
    -- own week for that platform. Ordered throughout: this is what makes the
    -- result the same every time.
    with days as (
      select d::date as day, extract(isodow from d)::smallint as weekday
      from generate_series(v_from, v_to - 1, interval '1 day') as d
    ),
    cadence as (
      select platform, posts_per_week
      from client_engine_platforms
      where client_id = p_client_id and active and posts_per_week > 0
    ),
    candidates as (
      select
        c.platform,
        c.posts_per_week,
        (d.day + w.starts_at) at time zone v_tz as at,
        d.day,
        -- Monday of the week this day belongs to, so cadence is counted per
        -- week rather than per horizon.
        date_trunc('week', d.day::timestamp)::date as week_start,
        w.id as window_id
      from days d
      join client_engine_windows w
        on w.client_id = p_client_id and w.weekday = d.weekday
      join cadence c
        on w.platform is null or w.platform = c.platform
    ),
    ranked as (
      select
        *,
        row_number() over (
          partition by platform, week_start order by at, window_id
        ) as nth_in_week,
        count(*) over (partition by platform, week_start) as windows_in_week
      from candidates
    )
    select * from ranked
    where nth_in_week <= posts_per_week
    order by at, platform
  loop
    -- Cadence asked for more than the week has room for. Worth reporting
    -- rather than quietly planning fewer posts than were asked for.
    if r.windows_in_week < r.posts_per_week then
      v_capped := true;
    end if;

    -- A window a person already filled is not free.
    if exists (
      select 1 from scheduled_posts sp
      where sp.client_id = p_client_id
        and sp.scheduled_at = r.at
        and (sp.platform is null or sp.platform = r.platform)
    ) then
      v_skipped := v_skipped + 1;
      continue;
    end if;

    -- Already planned. Asked before creating rather than inferred afterwards:
    -- the first version of this compared the new row's created_at against
    -- p_now, which conflates the clock the plan is written against with the
    -- clock the row was written at. With p_now injected they are months
    -- apart and every slot counted as skipped.
    if exists (
      select 1 from content_slots s
      where s.client_id = p_client_id and s.platform = r.platform and s.scheduled_at = r.at
    ) then
      v_skipped := v_skipped + 1;
      continue;
    end if;

    v_pillar := v_pillars[(v_ordinal % array_length(v_pillars, 1)) + 1]::uuid;
    v_format := v_formats[(v_ordinal % array_length(v_formats, 1)) + 1]::content_format;

    -- create_content_slot is still idempotent, so a second planner running at
    -- the same moment loses the race harmlessly rather than raising.
    perform create_content_slot(p_client_id, r.platform, r.at, v_pillar, v_format);
    v_created := v_created + 1;
    v_ordinal := v_ordinal + 1;
  end loop;

  return query select v_created, v_skipped, v_capped;
end;
$$;

comment on function public.plan_slots(uuid, timestamptz) is
  'Fill a client''s horizon with slots from their cadence, windows and mixes. Deterministic and idempotent: running it twice creates nothing the second time. Refuses a client whose engine is off.';

revoke all on function public.plan_slots(uuid, timestamptz) from public;
grant execute on function public.plan_slots(uuid, timestamptz) to authenticated;

-- ---------------------------------------------------------------------------
-- What the plan looks like before it is made
-- ---------------------------------------------------------------------------

-- The same arithmetic, returning what it would do rather than doing it, so
-- the panel can show a week before anybody switches anything on. Reads
-- nothing and writes nothing.
create or replace function public.preview_slots(
  p_client_id uuid,
  p_days integer default 7,
  p_now timestamptz default now()
)
returns table (at timestamptz, local_time text, platform post_platform, taken boolean)
language sql
stable
set search_path to 'public'
as $$
  with tz as (select client_timezone(p_client_id) as zone),
  days as (
    select d::date as day, extract(isodow from d)::smallint as weekday
    from tz, generate_series(
      (p_now at time zone tz.zone)::date,
      (p_now at time zone tz.zone)::date + greatest(p_days, 1) - 1,
      interval '1 day') as d
  ),
  cadence as (
    select platform, posts_per_week from client_engine_platforms
    where client_id = p_client_id and active and posts_per_week > 0
  ),
  candidates as (
    select c.platform, c.posts_per_week,
           (d.day + w.starts_at) at time zone tz.zone as at,
           date_trunc('week', d.day::timestamp)::date as week_start,
           w.id as window_id
    from tz, days d
    join client_engine_windows w on w.client_id = p_client_id and w.weekday = d.weekday
    join cadence c on w.platform is null or w.platform = c.platform
  ),
  ranked as (
    select *, row_number() over (partition by platform, week_start order by at, window_id) as nth
    from candidates
  )
  select
    r.at,
    to_char(r.at at time zone (select zone from tz), 'Dy DD Mon HH24:MI') as local_time,
    r.platform,
    exists (select 1 from content_slots s
            where s.client_id = p_client_id and s.platform = r.platform and s.scheduled_at = r.at)
      or exists (select 1 from scheduled_posts sp
                 where sp.client_id = p_client_id and sp.scheduled_at = r.at) as taken
  from ranked r
  where r.nth <= r.posts_per_week
  order by r.at, r.platform;
$$;

comment on function public.preview_slots(uuid, integer, timestamptz) is
  'What plan_slots would do, without doing it. Same arithmetic, read only, and works for a client whose engine is off.';

grant execute on function public.preview_slots(uuid, integer, timestamptz) to authenticated;

-- The switch, and what the engine does once it is on.
--
-- M3.1. Nothing here runs anything: this is the configuration the planner
-- (M3.3) and the tick (M3.4) will read, landed first and on its own because
-- the single most important property of the whole engine is that it is off
-- until somebody turns it on, and that property is worth reviewing by itself.
--
-- Three deliberate choices, none of them what the build plan literally says:
--
-- 1. There is no pillar_mix here. client_content_pillars.target_share already
--    is the pillar mix: it has a UI, it has validation (three to six active
--    pillars, shares summing to 95-105) and it is what a person already edits.
--    A second copy in this table would be a second answer to the same
--    question, and the planner would have to pick one.
--
-- 2. Cadence and posting windows are tables, not jsonb columns. The planner
--    reads them on every tick to decide where a slot goes; a weekday and a
--    time range are a row, and making the planner parse JSON in SQL to find
--    out whether Tuesday morning is free would be choosing the harder query
--    for no gain.
--
-- 3. format_mix stays jsonb. It is weights over an enum with four values,
--    read whole, never joined on, and never queried by one key.
--
-- enabled defaults false, and there is no path in this migration that creates
-- a row already switched on.

create table if not exists client_engine_settings (
  -- One row per client. The client is the key: there is no version history
  -- here, and a second settings row would be a second engine.
  client_id uuid primary key references clients(id) on delete cascade,

  -- The switch. Everything else is inert until this is true.
  enabled boolean not null default false,

  -- How far ahead the planner fills. Two weeks is enough to see a shape and
  -- short enough that changing the mix shows up quickly.
  plan_horizon_days integer not null default 14,

  -- Policy approvals (M3.7). These let the engine move an idea or a brief on
  -- without a person. Neither of them touches human_approved_at, which stays
  -- the one human commit.
  auto_approve_ideas boolean not null default false,
  auto_approve_briefs boolean not null default false,

  -- Below this, QA (M3.9) regenerates rather than offering it for approval.
  min_qa_score integer not null default 70,

  -- Whether a person approves each post or a week at a time.
  approval_mode text not null default 'per_post',

  -- Weights over content_format. Read whole, never joined on.
  format_mix jsonb not null default '{"single": 70, "carousel": 20, "reel": 10}'::jsonb,

  -- A ceiling on how much work the engine may have in the air for this client
  -- at once. The budget (migration 142) stops the spending; this stops one
  -- client's backlog occupying the whole queue.
  max_jobs_in_flight integer not null default 3,

  enabled_at timestamptz,
  enabled_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint ces_horizon check (plan_horizon_days between 1 and 90),
  constraint ces_qa_score check (min_qa_score between 0 and 100),
  constraint ces_approval_mode check (approval_mode in ('per_post', 'weekly_batch')),
  constraint ces_jobs_in_flight check (max_jobs_in_flight between 1 and 20),
  constraint ces_format_mix_object check (jsonb_typeof(format_mix) = 'object')
);

comment on table client_engine_settings is
  'What the engine does for one client, and whether it runs at all. Absent row means never configured, which is as off as enabled = false. The pillar mix is not here: it is client_content_pillars.target_share.';
comment on column client_engine_settings.enabled is
  'The switch. False by default and on every new row. Nothing the engine does happens for a client without this.';
comment on column client_engine_settings.format_mix is
  'Weights over content_format, as {"single": 70, ...}. Need not sum to 100; the planner normalises.';
comment on column client_engine_settings.max_jobs_in_flight is
  'How many engine jobs this client may have running at once. The budget caps spend; this caps queue share.';

-- ---------------------------------------------------------------------------
-- Cadence: which platforms, how often
-- ---------------------------------------------------------------------------

create table if not exists client_engine_platforms (
  client_id uuid not null references clients(id) on delete cascade,
  platform post_platform not null,
  posts_per_week integer not null default 3,
  -- Off without losing the number, so turning a platform back on does not
  -- mean remembering what its cadence was.
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (client_id, platform),
  constraint cep_cadence check (posts_per_week between 0 and 28)
);

comment on table client_engine_platforms is
  'Which platforms the engine posts to for a client, and how many posts a week each gets.';

-- ---------------------------------------------------------------------------
-- Windows: when in the week a post may land
-- ---------------------------------------------------------------------------

create table if not exists client_engine_windows (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  -- Null means the window applies to every platform, which is the usual case.
  platform post_platform,
  -- ISO weekday: 1 is Monday, 7 is Sunday. isodow, not dow, so the week
  -- starts where the people using this think it starts.
  weekday smallint not null,
  -- Local to the client's timezone, from migration 144. Never UTC: a posting
  -- window is a fact about their audience's day.
  starts_at time not null,
  ends_at time not null,
  created_at timestamptz not null default now(),
  constraint cew_weekday check (weekday between 1 and 7),
  constraint cew_order check (starts_at < ends_at)
);

comment on table client_engine_windows is
  'When in the week the engine may place a post, in the client''s own timezone. ISO weekday: 1 Monday to 7 Sunday. A null platform means any.';
comment on column client_engine_windows.starts_at is
  'Local time in the client''s timezone (clients.timezone, migration 144), never UTC.';

create index if not exists cew_client_idx on client_engine_windows (client_id, weekday);

-- ---------------------------------------------------------------------------
-- Keeping updated_at honest
-- ---------------------------------------------------------------------------

create or replace function public.touch_engine_settings()
returns trigger
language plpgsql
set search_path to 'public'
as $$
begin
  new.updated_at := now();
  -- When the switch goes on, record who and when. Turning it off clears the
  -- pair rather than leaving a stale "enabled by" on a client that is off.
  if tg_table_name = 'client_engine_settings' then
    if new.enabled and not coalesce(old.enabled, false) then
      new.enabled_at := now();
      new.enabled_by := auth.uid();
    elsif not new.enabled then
      new.enabled_at := null;
      new.enabled_by := null;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists ces_touch on client_engine_settings;
create trigger ces_touch before update on client_engine_settings
for each row execute function public.touch_engine_settings();

drop trigger if exists cep_touch on client_engine_platforms;
create trigger cep_touch before update on client_engine_platforms
for each row execute function public.touch_engine_settings();

-- ---------------------------------------------------------------------------
-- The question everything else asks
-- ---------------------------------------------------------------------------

-- A missing row is not an error and is not on. The engine has to be able to
-- ask about a client nobody has ever configured and get "no".
create or replace function public.engine_is_enabled(p_client_id uuid)
returns boolean
language sql
stable
set search_path to 'public'
as $$
  select coalesce((select s.enabled from client_engine_settings s where s.client_id = p_client_id), false);
$$;

comment on function public.engine_is_enabled(uuid) is
  'Whether the engine runs for this client. False for a client with no settings row, which is every client until someone configures one.';

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

alter table client_engine_settings enable row level security;
alter table client_engine_platforms enable row level security;
alter table client_engine_windows enable row level security;

-- Writes are admin only, unlike post_copy. This table decides what gets made
-- and therefore what gets spent; "can see this client" is the wrong bar for
-- turning on a machine that bills.
drop policy if exists ces_admin_all on client_engine_settings;
create policy ces_admin_all on client_engine_settings
  for all to authenticated using (is_admin()) with check (is_admin());

drop policy if exists ces_scoped_read on client_engine_settings;
create policy ces_scoped_read on client_engine_settings
  for select to authenticated using (can_access_client(client_id));

drop policy if exists cep_admin_all on client_engine_platforms;
create policy cep_admin_all on client_engine_platforms
  for all to authenticated using (is_admin()) with check (is_admin());

drop policy if exists cep_scoped_read on client_engine_platforms;
create policy cep_scoped_read on client_engine_platforms
  for select to authenticated using (can_access_client(client_id));

drop policy if exists cew_admin_all on client_engine_windows;
create policy cew_admin_all on client_engine_windows
  for all to authenticated using (is_admin()) with check (is_admin());

drop policy if exists cew_scoped_read on client_engine_windows;
create policy cew_scoped_read on client_engine_windows
  for select to authenticated using (can_access_client(client_id));

grant select on client_engine_settings, client_engine_platforms, client_engine_windows to authenticated;

-- ---------------------------------------------------------------------------
-- Configuring a client
-- ---------------------------------------------------------------------------

-- Admin only, and deliberately cannot switch the engine on: that is its own
-- call below, so "I changed the cadence" and "I started spending this
-- client's money" are never the same click.
create or replace function public.set_engine_settings(
  p_client_id uuid,
  p_plan_horizon_days integer default null,
  p_auto_approve_ideas boolean default null,
  p_auto_approve_briefs boolean default null,
  p_min_qa_score integer default null,
  p_approval_mode text default null,
  p_format_mix jsonb default null,
  p_max_jobs_in_flight integer default null
)
returns client_engine_settings
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_row client_engine_settings;
begin
  if not is_admin() then
    raise exception 'Only an admin configures the engine.';
  end if;
  if not exists (select 1 from clients where id = p_client_id) then
    raise exception 'That client does not exist.';
  end if;

  insert into client_engine_settings (client_id) values (p_client_id)
  on conflict (client_id) do nothing;

  update client_engine_settings set
    plan_horizon_days = coalesce(p_plan_horizon_days, plan_horizon_days),
    auto_approve_ideas = coalesce(p_auto_approve_ideas, auto_approve_ideas),
    auto_approve_briefs = coalesce(p_auto_approve_briefs, auto_approve_briefs),
    min_qa_score = coalesce(p_min_qa_score, min_qa_score),
    approval_mode = coalesce(p_approval_mode, approval_mode),
    format_mix = coalesce(p_format_mix, format_mix),
    max_jobs_in_flight = coalesce(p_max_jobs_in_flight, max_jobs_in_flight)
  where client_id = p_client_id
  returning * into v_row;

  return v_row;
end;
$$;

comment on function public.set_engine_settings is
  'Configure the engine for a client. Admin only. Creates the row off, and cannot switch it on: use set_engine_enabled.';

-- The switch is its own function because it is its own decision. It refuses
-- to turn on a client that has nothing to post or nowhere to put it, because
-- an engine that is on and silent looks identical to one that is broken.
create or replace function public.set_engine_enabled(p_client_id uuid, p_enabled boolean)
returns client_engine_settings
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_row client_engine_settings;
  v_platforms integer;
  v_windows integer;
  v_pillars integer;
begin
  if not is_admin() then
    raise exception 'Only an admin switches the engine on or off.';
  end if;

  insert into client_engine_settings (client_id) values (p_client_id)
  on conflict (client_id) do nothing;

  if p_enabled then
    select count(*) into v_platforms
      from client_engine_platforms
      where client_id = p_client_id and active and posts_per_week > 0;
    if v_platforms = 0 then
      raise exception 'This client has no active platform with a cadence. The engine would plan nothing.';
    end if;

    select count(*) into v_windows from client_engine_windows where client_id = p_client_id;
    if v_windows = 0 then
      raise exception 'This client has no posting windows. The engine would have nowhere to put a post.';
    end if;

    select count(*) into v_pillars
      from client_content_pillars where client_id = p_client_id and active;
    if v_pillars = 0 then
      raise exception 'This client has no active content pillars. The engine would have nothing to write about.';
    end if;
  end if;

  update client_engine_settings set enabled = p_enabled
  where client_id = p_client_id
  returning * into v_row;
  return v_row;
end;
$$;

comment on function public.set_engine_enabled is
  'Switch the engine on or off for a client. Admin only. Refuses to switch on a client with no cadence, no window or no pillars.';

create or replace function public.set_engine_platform(
  p_client_id uuid,
  p_platform post_platform,
  p_posts_per_week integer,
  p_active boolean default true
)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if not is_admin() then
    raise exception 'Only an admin configures the engine.';
  end if;
  insert into client_engine_platforms (client_id, platform, posts_per_week, active)
  values (p_client_id, p_platform, p_posts_per_week, p_active)
  on conflict (client_id, platform) do update
    set posts_per_week = excluded.posts_per_week, active = excluded.active;
end;
$$;

create or replace function public.add_engine_window(
  p_client_id uuid,
  p_weekday smallint,
  p_starts_at time,
  p_ends_at time,
  p_platform post_platform default null
)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_id uuid;
begin
  if not is_admin() then
    raise exception 'Only an admin configures the engine.';
  end if;
  insert into client_engine_windows (client_id, weekday, starts_at, ends_at, platform)
  values (p_client_id, p_weekday, p_starts_at, p_ends_at, p_platform)
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.remove_engine_window(p_window_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if not is_admin() then
    raise exception 'Only an admin configures the engine.';
  end if;
  delete from client_engine_windows where id = p_window_id;
end;
$$;

revoke all on function public.set_engine_settings(uuid, integer, boolean, boolean, integer, text, jsonb, integer) from public;
revoke all on function public.set_engine_enabled(uuid, boolean) from public;
revoke all on function public.set_engine_platform(uuid, post_platform, integer, boolean) from public;
revoke all on function public.add_engine_window(uuid, smallint, time, time, post_platform) from public;
revoke all on function public.remove_engine_window(uuid) from public;

grant execute on function public.set_engine_settings(uuid, integer, boolean, boolean, integer, text, jsonb, integer) to authenticated;
grant execute on function public.set_engine_enabled(uuid, boolean) to authenticated;
grant execute on function public.set_engine_platform(uuid, post_platform, integer, boolean) to authenticated;
grant execute on function public.add_engine_window(uuid, smallint, time, time, post_platform) to authenticated;
grant execute on function public.remove_engine_window(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- What is actually running
-- ---------------------------------------------------------------------------

-- One row per client the engine could run for, with the reasons it cannot.
-- A panel that only says "off" leaves someone hunting for which of four
-- things is missing.
create or replace view engine_readiness as
select
  c.id as client_id,
  c.name as client_name,
  c.timezone,
  coalesce(s.enabled, false) as enabled,
  s.plan_horizon_days,
  s.approval_mode,
  coalesce(p.platforms, 0) as active_platforms,
  coalesce(p.posts_per_week, 0) as posts_per_week,
  coalesce(w.windows, 0) as posting_windows,
  coalesce(pl.pillars, 0) as active_pillars,
  b.cap_usd as month_cap_usd,
  case
    when s.client_id is null then 'Not configured'
    when coalesce(p.platforms, 0) = 0 then 'No platform with a cadence'
    when coalesce(w.windows, 0) = 0 then 'No posting windows'
    when coalesce(pl.pillars, 0) = 0 then 'No active content pillars'
    when b.cap_usd is null then 'No spend cap set'
    when not s.enabled then 'Ready, switched off'
    else 'Running'
  end as readiness
from clients c
left join client_engine_settings s on s.client_id = c.id
left join (
  select client_id, count(*) as platforms, sum(posts_per_week) as posts_per_week
  from client_engine_platforms where active and posts_per_week > 0 group by client_id
) p on p.client_id = c.id
left join (
  select client_id, count(*) as windows from client_engine_windows group by client_id
) w on w.client_id = c.id
left join (
  select client_id, count(*) as pillars from client_content_pillars where active group by client_id
) pl on pl.client_id = c.id
left join client_engine_budgets b
  on b.client_id = c.id and b.month = date_trunc('month', now())::date;

comment on view engine_readiness is
  'Every client, whether the engine runs for them, and the first reason it does not. Ordered so the reason named is the one to fix next.';

grant select on engine_readiness to authenticated;

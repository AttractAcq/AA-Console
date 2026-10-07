-- Asking for a window of history, which nothing could do.
--
-- enqueue_metrics_ingest_jobs takes a p_days and nothing ever passes it
-- anything but the default. So the only window that has ever been pulled is
-- the trailing seven days, every morning, for every client at once. A client
-- connected in October has no September, and there was no way to go and get
-- it short of a SQL prompt.
--
-- The Integrations panel says, in a comment next to the schedule switch:
--
--   "This gates the schedule only -- the ingest can still be run by hand,
--    which is what you want for a one-off backfill without arming a
--    recurring job."
--
-- It cannot. enqueue_metrics_ingest_jobs requires ingest_enabled, so the one
-- case that comment describes -- pull history without arming the daily job
-- -- is the case it refuses. That split is real and worth keeping; this is
-- the half of it that was missing.
--
-- WHAT THIS COSTS
--
-- A backfill is a paid API pull against the client's own quota, and a year
-- of two surfaces is not a small request. So the window is capped, the cap
-- is stated in the error rather than silently clamped, and a backfill that
-- is already running for the same window is not queued twice.

-- ---------------------------------------------------------------------------
-- What history is already here
-- ---------------------------------------------------------------------------

-- Without this the UI is a date picker over a guess. A person needs to see
-- which days are missing before asking for them, or they will re-pull a
-- month that is already complete and pay for it.
create or replace view metrics_coverage with (security_invoker = true) as
select
  m.client_id,
  m.surface::text as surface,
  min(m.metric_date) as first_day,
  max(m.metric_date) as last_day,
  count(distinct m.metric_date)::integer as days_with_data,
  -- Days inside the covered span that have nothing in them. A gap in the
  -- middle is a failed pull; a short span is simply a young integration,
  -- and the two want different actions.
  (max(m.metric_date) - min(m.metric_date) + 1 - count(distinct m.metric_date))::integer as days_missing_inside,
  max(m.fetched_at) as last_fetched_at
from metrics_daily m
group by m.client_id, m.surface;

comment on view metrics_coverage is
  'Which days of metrics each client already has, per surface, and how many days inside that span are empty. Read before asking for a backfill, so a month that is already complete is not paid for twice.';

grant select on metrics_coverage to authenticated;

-- ---------------------------------------------------------------------------
-- Asking
-- ---------------------------------------------------------------------------

-- The longest window one request may ask for. Meta's insights reach back
-- about three years, so this is not the API's limit -- it is a limit on how
-- much a single click can spend. A longer history is several requests, which
-- is the right amount of friction for the amount of money.
create or replace function public.max_backfill_days()
returns integer language sql immutable set search_path to 'public'
as $$ select 400 $$;

create or replace function public.request_metrics_backfill(
  p_client_id uuid,
  p_since date,
  p_until date,
  -- Null means both surfaces this system knows how to pull.
  p_surface text default null
)
returns setof uuid
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  r record;
  v_job uuid;
  v_queued integer := 0;
begin
  if not can_access_client(p_client_id) then
    raise exception 'Not permitted for this client';
  end if;

  if p_since is null or p_until is null then
    raise exception 'A backfill needs both ends of the window.' using errcode = 'P0001';
  end if;
  if p_since > p_until then
    raise exception 'The window starts after it ends: % to %.', p_since, p_until using errcode = 'P0001';
  end if;
  if p_until > current_date then
    raise exception 'That window ends in the future. The last day there can be data for is %.', current_date
      using errcode = 'P0001';
  end if;
  if (p_until - p_since) + 1 > max_backfill_days() then
    -- Stated rather than clamped. A request silently cut to 400 days looks
    -- like a complete backfill and is not one, and the person would find
    -- out months later from a chart with a hole in it.
    raise exception 'That is % days. One backfill may ask for at most %: split it into several.',
      (p_until - p_since) + 1, max_backfill_days() using errcode = 'P0001';
  end if;
  if p_surface is not null and p_surface not in ('paid', 'organic') then
    raise exception 'Unknown surface "%". It is paid, organic, or nothing for both.', p_surface
      using errcode = 'P0001';
  end if;

  for r in
    select ci.client_id, s.surface, ci.provider
      from client_integrations ci
      join (values ('meta', 'paid'), ('instagram', 'organic')) as s(provider, surface)
        on s.provider = ci.provider
     where ci.client_id = p_client_id
       -- Deliberately NOT ci.ingest_enabled. That switch arms the daily
       -- schedule; this is the one-off the panel's own comment describes,
       -- and requiring it would mean a client has to turn on a recurring
       -- job to fetch last month once.
       and ci.status in ('connected', 'active', 'expiring')
       and ci.credential_secret_id is not null
       and (p_surface is null or s.surface = p_surface)
  loop
    -- Not the same window twice. The daily job's own guard is "any job in
    -- flight for this surface", which would block a backfill behind the
    -- morning pull; this one is per window, so asking for September while
    -- today's job runs is allowed and asking for September twice is not.
    if exists (
      select 1 from agent_jobs j
       where j.agent_key = 'metrics_ingest'
         and j.client_id = p_client_id
         and j.params->>'surface' = r.surface
         and (j.params->>'since')::date = p_since
         and (j.params->>'until')::date = p_until
         and j.status in ('queued', 'paused', 'claimed', 'running')
    ) then
      continue;
    end if;

    insert into agent_jobs (agent_key, client_id, created_by, params)
    values ('metrics_ingest', p_client_id, auth.uid(),
            jsonb_build_object('surface', r.surface, 'since', p_since, 'until', p_until,
                               'backfill', true))
    returning id into v_job;

    v_queued := v_queued + 1;
    return next v_job;
  end loop;

  if v_queued = 0 then
    -- Naming which of the two it is, because they want different actions:
    -- connect a credential, or wait.
    if not exists (
      select 1 from client_integrations ci
       where ci.client_id = p_client_id
         and ci.status in ('connected', 'active', 'expiring')
         and ci.credential_secret_id is not null
         and (p_surface is null
              or (p_surface = 'paid' and ci.provider = 'meta')
              or (p_surface = 'organic' and ci.provider = 'instagram'))
    ) then
      raise exception 'This client has no usable integration to pull % from.',
        coalesce(p_surface, 'either surface') using errcode = 'P0001';
    end if;
    raise exception 'That exact window is already being pulled.' using errcode = 'P0001';
  end if;

  return;
end;
$$;

comment on function public.request_metrics_backfill(uuid, date, date, text) is
  'Queue a metrics pull for one client over a chosen window, for one surface or both. Ignores the daily schedule switch on purpose: that arms the recurring job, this is the one-off. Refuses a window already being pulled, and states the length cap rather than clamping to it.';

revoke all on function public.request_metrics_backfill(uuid, date, date, text) from public, anon;
revoke all on function public.max_backfill_days() from public, anon;
grant execute on function public.request_metrics_backfill(uuid, date, date, text) to authenticated, service_role;
grant execute on function public.max_backfill_days() to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- What is being pulled
-- ---------------------------------------------------------------------------

create or replace view metrics_pulls with (security_invoker = true) as
select
  j.id as job_id,
  j.client_id,
  j.params->>'surface' as surface,
  (j.params->>'since')::date as since,
  (j.params->>'until')::date as until,
  coalesce((j.params->>'backfill')::boolean, false) as asked_for_by_hand,
  j.status::text as status,
  j.error,
  j.created_at,
  j.completed_at
from agent_jobs j
where j.agent_key = 'metrics_ingest'
  and j.params ? 'since'
order by j.created_at desc;

comment on view metrics_pulls is
  'Every metrics pull and the window it asked for, newest first, with whether a person asked for it or the schedule did.';

grant select on metrics_pulls to authenticated;

select public.lock_down_definer_functions();

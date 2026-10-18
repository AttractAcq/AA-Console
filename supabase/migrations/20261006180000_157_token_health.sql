-- Is this client's token still good?
--
-- M1.2. Nothing in this system could move an integration out of 'error'
-- except a person re-entering a credential. Migration 124 added that path
-- deliberately — "a fresh credential earns a fresh attempt" — and it is the
-- right path when the token really is dead. It is the wrong one when the
-- token was never the problem.
--
-- On 6 October an Instagram integration failed on a metric name Meta had
-- deprecated. The agent did the correct thing and marked it 'error'. The
-- metric name was fixed and deployed twenty minutes later. The integration
-- stayed excluded from the scheduler, because nothing in the system could
-- say the token had been fine the whole time, and ingestion would have
-- stayed off until somebody noticed and re-pasted a credential that was
-- never wrong.
--
-- So: a daily check that asks Meta, and is allowed to clear an error it can
-- see is gone.

alter table client_integrations
  add column if not exists token_expires_at timestamptz,
  add column if not exists health_detail text;

comment on column client_integrations.token_expires_at is
  'When the token stops working, from Meta''s debug_token. The nearer of the token''s own expiry and its data-access expiry. Null means it does not expire or has not been checked.';
comment on column client_integrations.health_detail is
  'The last thing the health check had to say, in words for the Integrations panel. Set even when healthy, so "checked and fine" is distinguishable from "never checked".';

-- ---------------------------------------------------------------------------
-- The allow-list, extended deliberately
-- ---------------------------------------------------------------------------

-- Migration 124 made this an allow-list rather than "not error", so that a
-- future state could not become eligible merely by being new. 'expiring' is
-- that future state arriving, and it is eligible: a token a week from
-- expiry still works, and stopping a week early because it is *going* to
-- stop is the warning causing the outage it warns about.
create or replace function enqueue_metrics_ingest_jobs(p_days integer default 7)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_count integer;
  v_since date := current_date - greatest(coalesce(p_days, 7), 1);
  v_until date := current_date;
begin
  insert into agent_jobs (agent_key, client_id, params)
  select 'metrics_ingest',
         ci.client_id,
         jsonb_build_object('surface', s.surface, 'since', v_since, 'until', v_until)
    from client_integrations ci
    join (values ('meta', 'paid'), ('instagram', 'organic')) as s(provider, surface)
      on s.provider = ci.provider
   where ci.status in ('connected', 'active', 'expiring')
     and ci.ingest_enabled = true
     and ci.credential_secret_id is not null
     and not exists (
       select 1 from agent_jobs j
        where j.agent_key = 'metrics_ingest'
          and j.client_id = ci.client_id
          and j.params->>'surface' = s.surface
          and j.status in ('queued', 'claimed', 'running')
     );

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

comment on function enqueue_metrics_ingest_jobs(integer) is
  'Queues the daily metrics pull for every connected, active or expiring integration with ingest switched on. An expiring token still works; an errored one does not.';

-- ---------------------------------------------------------------------------
-- The agent and its schedule
-- ---------------------------------------------------------------------------

insert into agents (agent_key, name, initials, domain, description, requires_upstream, requires_input)
values (
  'token_health', 'Token Health', 'TH', 'operations',
  'Asks Meta daily whether each stored token still works, and is the only thing that can clear an error state without a person re-entering a credential.',
  array[]::text[], false)
on conflict (agent_key) do nothing;

create or replace function public.enqueue_token_health_job()
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_job uuid;
begin
  -- One job for every integration, not one per client: the check is a
  -- handful of HTTP calls and a hundred jobs to make a hundred requests
  -- would be a hundred claims, leases and rows to read.
  if exists (
    select 1 from agent_jobs
     where agent_key = 'token_health' and status in ('queued', 'claimed', 'running')
  ) then
    return null;
  end if;

  insert into agent_jobs (agent_key, params)
  values ('token_health', '{}'::jsonb)
  returning id into v_job;
  return v_job;
end;
$$;

comment on function public.enqueue_token_health_job() is
  'Queues one token health check across every integration, unless one is already in flight.';

revoke all on function public.enqueue_token_health_job() from public;
grant execute on function public.enqueue_token_health_job() to authenticated, service_role;

-- Before the metrics pull at 03:15, so an integration rescued overnight is
-- eligible the same morning rather than the next one.
select cron.unschedule('token-health-daily') where exists (
  select 1 from cron.job where jobname = 'token-health-daily');

select cron.schedule('token-health-daily', '45 2 * * *', $cron$ select public.enqueue_token_health_job(); $cron$);

-- ---------------------------------------------------------------------------
-- Seeing it
-- ---------------------------------------------------------------------------

create or replace view integration_health with (security_invoker = true) as
select
  i.client_id,
  c.name as client_name,
  i.provider,
  i.status,
  i.ingest_enabled,
  i.token_expires_at,
  i.health_detail,
  i.last_checked_at,
  i.status in ('connected', 'active', 'expiring') as usable,
  case
    when i.last_checked_at is null then 'Never checked'
    when i.status = 'error' then 'Not working'
    when i.status = 'expiring' then 'Expiring soon'
    else 'Working'
  end as headline
from client_integrations i
left join clients c on c.id = i.client_id;

comment on view integration_health is
  'Every integration, whether it can be used, and the last thing the health check had to say. What the Integrations panel reads.';

grant select on integration_health to authenticated;

-- Per-client control over the daily pull, and the schedule that drives it.
--
-- The flag gates the SCHEDULE, not the capability: an operator can still
-- run metrics_ingest by hand or through the Master AI with this off. That
-- is the useful split — a one-off backfill should not require arming a
-- recurring job.
--
-- Default false is deliberate. Connecting a credential should not silently
-- start billing API calls forever; someone has to say yes.

alter table client_integrations
  add column ingest_enabled boolean not null default false;

comment on column client_integrations.ingest_enabled is
  'Whether the daily scheduled pull runs for this client. Off by default. Does not affect manual runs.';

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
    cross join (values ('paid'), ('organic')) as s(surface)
   where ci.provider = 'meta'
     and ci.status = 'active'
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

revoke all on function enqueue_metrics_ingest_jobs(integer) from public, anon, authenticated;
grant execute on function enqueue_metrics_ingest_jobs(integer) to service_role;

-- ---------------------------------------------------------------------------
-- The schedule. Guarded so this migration still replays on an environment
-- where pg_cron is not available.
-- ---------------------------------------------------------------------------

create extension if not exists pg_cron;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    -- 03:15 UTC daily: late enough that the previous day has closed
    -- everywhere we operate. Re-scheduling the same job name replaces it
    -- rather than stacking a duplicate.
    perform cron.schedule(
      'metrics-ingest-daily',
      '15 3 * * *',
      $cron$select public.enqueue_metrics_ingest_jobs(7)$cron$
    );
  end if;
end $$;;

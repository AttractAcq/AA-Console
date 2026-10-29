-- B001: facts the runtime needs for a read-only deployment inventory.
-- This function is executable only by the service role. It returns neither
-- cron commands nor migration SQL, credentials, connection strings, or rows.
-- Release ordering: Google Ads migration 260 must be applied before this 261.

-- The old status view ran a correlated max(reported_at) per heartbeat row.
-- At production volume that timed out even though the latest beat was fresh.
-- One ordered pass picks the latest row for each worker, with id breaking ties.
create index if not exists agent_runtime_heartbeats_worker_latest_idx
  on public.agent_runtime_heartbeats (worker_id, reported_at desc, id desc);

create or replace view public.agent_runtime_status as
select h.worker_id, h.status, h.version, h.queue_depth, h.active_jobs,
       h.metadata, h.reported_at,
       (now() - h.reported_at) as age,
       (h.reported_at > now() - interval '90 seconds') as is_live
from (
  select distinct on (worker_id)
    worker_id, status, version, queue_depth, active_jobs, metadata, reported_at
  from public.agent_runtime_heartbeats
  order by worker_id, reported_at desc, id desc
) h;
alter view public.agent_runtime_status set (security_invoker = on);

create or replace function public.system_readiness_catalog()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_migration_head text;
  v_migration_count bigint;
  v_cron_jobs jsonb;
begin
  if pg_catalog.to_regclass('supabase_migrations.schema_migrations') is not null then
    execute 'select max(version)::text, count(*) from supabase_migrations.schema_migrations'
      into v_migration_head, v_migration_count;
  end if;

  if pg_catalog.to_regclass('cron.job') is not null then
    execute $query$
      select coalesce(
        jsonb_agg(
          jsonb_build_object('name', coalesce(jobname, 'unnamed#' || jobid::text),
                             'schedule', schedule, 'active', active)
          order by coalesce(jobname, 'unnamed#' || jobid::text)
        ), '[]'::jsonb
      )
      from cron.job
    $query$ into v_cron_jobs;
  end if;

  return pg_catalog.jsonb_build_object(
    'migrationHead', v_migration_head,
    'migrationCount', v_migration_count,
    'objects', pg_catalog.jsonb_build_object(
      'tables', (
        select count(*) from pg_catalog.pg_class c
        join pg_catalog.pg_namespace n on n.oid = c.relnamespace
        where n.nspname in ('public', 'mcp_internal') and c.relkind in ('r', 'p')
      ),
      'views', (
        select count(*) from pg_catalog.pg_class c
        join pg_catalog.pg_namespace n on n.oid = c.relnamespace
        where n.nspname in ('public', 'mcp_internal') and c.relkind in ('v', 'm')
      ),
      'functions', (
        select count(*) from pg_catalog.pg_proc p
        join pg_catalog.pg_namespace n on n.oid = p.pronamespace
        where n.nspname in ('public', 'mcp_internal')
      ),
      'policies', (
        select count(*) from pg_catalog.pg_policy p
        join pg_catalog.pg_class c on c.oid = p.polrelid
        join pg_catalog.pg_namespace n on n.oid = c.relnamespace
        where n.nspname in ('public', 'mcp_internal')
      )
    ),
    'cronJobs', v_cron_jobs
  );
end;
$$;

revoke all on function public.system_readiness_catalog() from public, anon, authenticated;
grant execute on function public.system_readiness_catalog() to service_role;
comment on function public.system_readiness_catalog() is
  'Service-only, read-only schema and cron inventory for admin system readiness. Cron commands and secret values are excluded.';

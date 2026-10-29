-- Keep the liveness table bounded. It is not the action/audit ledger; old
-- process heartbeats should not make the admin health view unusable.
-- Each call removes at most 5,000 rows older than seven days. The existing
-- reported_at index supports the oldest-first selection.
create or replace function public.prune_agent_runtime_heartbeats()
returns integer
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_deleted integer;
begin
  with victims as (
    select h.id
      from public.agent_runtime_heartbeats h
     where h.reported_at < pg_catalog.now() - interval '7 days'
     order by h.reported_at, h.id
     limit 5000
     for update skip locked
  )
  delete from public.agent_runtime_heartbeats h
   using victims v
   where h.id = v.id;

  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$function$;

revoke all on function public.prune_agent_runtime_heartbeats() from public, anon, authenticated;
grant execute on function public.prune_agent_runtime_heartbeats() to service_role;
comment on function public.prune_agent_runtime_heartbeats() is
  'Deletes at most 5,000 runtime liveness heartbeats older than seven days per call. Does not touch action audit records.';

select cron.unschedule('prune-runtime-heartbeats')
where exists (select 1 from cron.job where jobname = 'prune-runtime-heartbeats');
select cron.schedule('prune-runtime-heartbeats', '*/15 * * * *',
  $cron$select public.prune_agent_runtime_heartbeats();$cron$);

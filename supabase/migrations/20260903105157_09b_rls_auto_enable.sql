-- The RLS safety net, recovered from production.
--
-- This existed only in the live database: created outside the migration
-- history, so nothing in git described it and a fresh environment would not
-- have had it. The replay onto staging failed at migration 10, which revokes
-- execute on a function no migration ever created — which is how it was
-- found.
--
-- It matters more than a failed revoke. `ensure_rls` fires on every DDL and
-- turns row level security on for any new table in `public`. Part of the
-- "every table has RLS" property this project keeps verifying is therefore
-- automatic, and without this a new table in a fresh environment would
-- silently ship without it.
--
-- Written idempotently: production already has both, and applying this there
-- must be a no-op.

create or replace function public.rls_auto_enable()
returns event_trigger
language plpgsql
security definer
set search_path to 'pg_catalog'
as $function$
DECLARE
  cmd record;
BEGIN
  FOR cmd IN
    SELECT *
    FROM pg_event_trigger_ddl_commands()
    WHERE command_tag IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
      AND object_type IN ('table','partitioned table')
  LOOP
     IF cmd.schema_name IS NOT NULL AND cmd.schema_name IN ('public') AND cmd.schema_name NOT IN ('pg_catalog','information_schema') AND cmd.schema_name NOT LIKE 'pg_toast%' AND cmd.schema_name NOT LIKE 'pg_temp%' THEN
      BEGIN
        EXECUTE format('alter table if exists %s enable row level security', cmd.object_identity);
        RAISE LOG 'rls_auto_enable: enabled RLS on %', cmd.object_identity;
      EXCEPTION
        WHEN OTHERS THEN
          RAISE LOG 'rls_auto_enable: failed to enable RLS on %', cmd.object_identity;
      END;
     ELSE
        RAISE LOG 'rls_auto_enable: skip % (either system schema or not in enforced list: %.)', cmd.object_identity, cmd.schema_name;
     END IF;
  END LOOP;
END;
$function$;

-- CREATE EVENT TRIGGER has no IF NOT EXISTS, so it is guarded.
do $$
begin
  if not exists (select 1 from pg_event_trigger where evtname = 'ensure_rls') then
    create event trigger ensure_rls
      on ddl_command_end
      execute function public.rls_auto_enable();
  end if;
end $$;

-- Production's grants, reproduced exactly. Migration 10 revokes this from
-- `authenticated`, which is a no-op: functions grant EXECUTE to PUBLIC by
-- default and authenticated inherits it. Revoking from PUBLIC is what
-- actually closes it, and without this line staging ended up with the
-- function callable by anon while production had it locked to service_role.
revoke execute on function public.rls_auto_enable() from public, anon, authenticated;
grant execute on function public.rls_auto_enable() to service_role;

comment on function public.rls_auto_enable() is
  'Event-trigger function behind ensure_rls: enables RLS on every new table in public. Recovered into the migration history after a staging replay found it missing.';

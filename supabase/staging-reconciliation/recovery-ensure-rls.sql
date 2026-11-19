-- Disposable-hosted restore supplement for staging ensure_rls.
-- Source capture: 2026-11-17T12:52:19.675Z, ref vmmertwoboqiazcsougw.
-- Never apply to live staging. No ownership workaround is permitted.
BEGIN;
SET LOCAL lock_timeout='5s';
DO $event$
DECLARE present record;
BEGIN
  IF current_user<>'postgres' THEN RAISE EXCEPTION 'postgres role required'; END IF;
  IF to_regprocedure('public.rls_auto_enable()') IS NULL THEN RAISE EXCEPTION 'handler missing'; END IF;
  SELECT evtevent,evttags,evtenabled,pg_get_userbyid(evtowner) AS owner,evtfoid::regprocedure::text AS handler
    INTO present FROM pg_event_trigger WHERE evtname='ensure_rls';
  IF FOUND THEN
    IF present.evtevent<>'ddl_command_end' OR present.evttags IS NOT NULL OR present.evtenabled<>'O'
       OR present.owner<>'postgres' OR present.handler NOT IN ('rls_auto_enable()','public.rls_auto_enable()') THEN
      RAISE EXCEPTION 'Existing ensure_rls differs from checkpoint';
    END IF;
  ELSE
    CREATE EVENT TRIGGER ensure_rls ON ddl_command_end EXECUTE FUNCTION public.rls_auto_enable();
  END IF;
END
$event$;
COMMIT;

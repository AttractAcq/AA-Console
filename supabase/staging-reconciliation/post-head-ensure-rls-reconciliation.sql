-- Staging-only candidate after the reviewed 551 migration head.
-- Narrow the pre-existing, unfiltered ensure_rls event trigger to the
-- production event-tag set. Apply only after a hosted recovery gate and review.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
DO $reconcile$
DECLARE
  current_event record;
BEGIN
  IF current_user <> 'postgres' THEN
    RAISE EXCEPTION 'ensure_rls reconciliation requires postgres';
  END IF;
  SELECT e.evtevent,e.evttags,e.evtenabled,
         pg_get_userbyid(e.evtowner) AS owner,
         e.evtfoid::regprocedure::text AS handler
    INTO current_event
    FROM pg_event_trigger e WHERE e.evtname='ensure_rls';
  IF NOT FOUND OR current_event.evtevent <> 'ddl_command_end'
     OR current_event.evttags IS NOT NULL
     OR current_event.evtenabled <> 'O'
     OR current_event.owner <> 'postgres'
     OR current_event.handler NOT IN ('rls_auto_enable()','public.rls_auto_enable()') THEN
    RAISE EXCEPTION 'ensure_rls before-state differs from reviewed staging';
  END IF;
  DROP EVENT TRIGGER ensure_rls;
  CREATE EVENT TRIGGER ensure_rls ON ddl_command_end
    WHEN TAG IN ('CREATE TABLE','CREATE TABLE AS','SELECT INTO')
    EXECUTE FUNCTION public.rls_auto_enable();
  IF NOT EXISTS (
    SELECT 1 FROM pg_event_trigger e
     WHERE e.evtname='ensure_rls' AND e.evtevent='ddl_command_end'
       AND e.evtenabled='O'
       AND e.evttags=ARRAY['CREATE TABLE','CREATE TABLE AS','SELECT INTO']::text[]
       AND pg_get_userbyid(e.evtowner)='postgres'
  ) THEN RAISE EXCEPTION 'ensure_rls after-state differs'; END IF;
END
$reconcile$;
COMMIT;

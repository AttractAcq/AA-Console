-- The exposure view called six gated functions ungated.
--
-- `security_definer_exposure` (161) ends with a column that decides whether a
-- function checks its own caller, by looking for the names of the gates this
-- codebase uses. Its contract is that any row with
-- `body_checks_the_caller = false` is either a documented primitive or a
-- finding — which only holds if the pattern knows every gate.
--
-- It did not. 161 taught it `may_advance_slot` and then 166 introduced
-- `may_touch_assignment` without going back, so on production today:
--
--   advance_assignment       gates on may_touch_assignment
--   accept_assignment        calls advance_assignment, which gates
--   decline_assignment       likewise
--   deliver_assignment       likewise
--   assignment_follows_review  a trigger, and calls advance_assignment
--   mcp_queue_distribution   gates on require_active_bot and
--                            require_bot_client_grant
--
-- all read as "relying entirely on its grants". Six false positives in a
-- list of twenty is enough to teach whoever reads it that rows are noise,
-- which is the one thing this view cannot afford.
--
-- So the pattern moves out of the view body and into a function, for the
-- same reason `usable_integration_statuses` exists: a rule that has to be
-- updated in step with the code should be somewhere a person can find it,
-- not buried in a `create view`. Adding a new gate means adding it here, and
-- the comment says so.

create or replace function public.caller_gate_markers()
returns text
language sql
immutable
set search_path to 'public'
as $$
  select
    -- Direct checks.
    'can_access_client|is_admin\(|auth\.role\(\)|current_role_of|accessible_client_ids'
    -- Named predicates. Add one here when you add one to the codebase.
    || '|may_advance_slot|may_touch_assignment'
    -- Functions that gate on the caller themselves, so calling one is a
    -- gate. Both refuse a caller who cannot reach the client.
    || '|advance_slot|advance_assignment'
    -- The MCP's equivalent: a bot id plus a per-client grant.
    || '|require_active_bot|require_bot_client_grant'
$$;

comment on function public.caller_gate_markers() is
  'The regex security_definer_exposure uses to decide whether a SECURITY DEFINER function checks its own caller. Extend it when you add a new gate, or the view will report the functions using it as ungated.';

create or replace view security_definer_exposure with (security_invoker = true) as
select
  n.nspname as schema,
  p.proname as function,
  pg_get_function_identity_arguments(p.oid) as arguments,
  has_function_privilege('anon', p.oid, 'execute') as anon_can_execute,
  has_function_privilege('authenticated', p.oid, 'execute') as signed_in_can_execute,
  (p.prosrc ~* caller_gate_markers()) as body_checks_the_caller
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname in ('public', 'mcp_internal')
  and p.prosecdef
  and (has_function_privilege('anon', p.oid, 'execute')
       or has_function_privilege('authenticated', p.oid, 'execute'))
order by anon_can_execute desc, body_checks_the_caller, n.nspname, p.proname;

comment on view security_definer_exposure is
  'Every SECURITY DEFINER function anon or a signed-in user can execute, and whether its own body checks the caller. Any row with anon_can_execute true is a finding. A row with body_checks_the_caller false is relying entirely on its grants -- compare it against the fifteen migration 162 explains before treating it as one.';

revoke all on security_definer_exposure from anon;
grant select on security_definer_exposure to authenticated;

revoke all on function public.caller_gate_markers() from public, anon;
grant execute on function public.caller_gate_markers() to authenticated, service_role;

select public.lock_down_definer_functions();

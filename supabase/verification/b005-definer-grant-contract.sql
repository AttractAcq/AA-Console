-- B005 replay-only authority contract. This file runs against a disposable
-- database after every clean and upgrade replay; it changes no live schema.
-- Function EXECUTE is checked as the named role, including inherited PUBLIC
-- grants, rather than looking only for an explicit ACL entry.
do $b005_definer_grants$
declare
  exposed_function regprocedure;
  item text;
begin
  select p.oid::regprocedure into exposed_function
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('public', 'mcp_internal')
     and p.prosecdef
     and has_function_privilege('anon', p.oid, 'EXECUTE')
   order by p.oid::regprocedure::text
   limit 1;
  if exposed_function is not null then
    raise exception 'Anonymous SECURITY DEFINER execution is exposed: %',
      exposed_function;
  end if;

  -- A creative assignment or ordinary signed-in account must not invoke
  -- these low-level sales predicates or start a global outbound worker.
  foreach item in array array[
    'public.may_manage_client_leads(uuid)',
    'public.enqueue_sequence_sweep()'
  ] loop
    if to_regprocedure(item) is null then
      raise exception 'B005 internal sales function missing: %', item;
    end if;
    if has_function_privilege('anon', item, 'EXECUTE')
       or has_function_privilege('authenticated', item, 'EXECUTE')
       or not has_function_privilege('service_role', item, 'EXECUTE') then
      raise exception 'B005 internal sales function grants drifted: %', item;
    end if;
  end loop;

  -- Row policies need these scoped predicates under a signed-in caller.
  -- A missing grant breaks legitimate same-client and explicit sales-seat
  -- reads; an anonymous grant expands the caller surface unnecessarily.
  foreach item in array array[
    'public.can_read_client_sales_data(uuid)',
    'public.can_read_workflow_lead_attribution(uuid)'
  ] loop
    if to_regprocedure(item) is null then
      raise exception 'B005 scoped sales predicate missing: %', item;
    end if;
    if has_function_privilege('anon', item, 'EXECUTE')
       or not has_function_privilege('authenticated', item, 'EXECUTE')
       or not has_function_privilege('service_role', item, 'EXECUTE') then
      raise exception 'B005 scoped sales predicate grants drifted: %', item;
    end if;
  end loop;
end
$b005_definer_grants$;

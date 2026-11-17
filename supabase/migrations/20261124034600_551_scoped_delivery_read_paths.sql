-- Restore signed-in approval and outcome reads without exposing execution tables.
begin;

-- The exact-state function delegates its authorization check to
-- approval_source_state_v6 before it reads any campaign action details.
grant execute on function public.campaign_action_exact_source_state_v6(uuid)
  to authenticated, service_role;

-- The underlying outcome view stays security_invoker. This narrow definer
-- entry point checks the caller and scope before reading restricted attempts.
create function public.list_client_external_outcomes_v6(p_client_id uuid default null)
returns setof public.client_external_outcomes_v6
language plpgsql stable security definer
set search_path = pg_catalog, public set timezone = 'UTC' as $$
begin
  if auth.role() is distinct from 'authenticated' or auth.uid() is null then
    raise exception 'A signed-in user is required.' using errcode = '42501';
  end if;
  if p_client_id is null then
    if not coalesce(public.is_admin(), false) then
      raise exception 'Agency outcome access is restricted to admins.' using errcode = '42501';
    end if;
  elsif not coalesce(public.can_access_client(p_client_id), false) then
    raise exception 'Client outcome access denied.' using errcode = '42501';
  end if;
  return query select o.* from public.client_external_outcomes_v6 o
    where p_client_id is null or o.client_id = p_client_id;
end $$;

revoke all on function public.list_client_external_outcomes_v6(uuid)
  from public, anon, service_role;
grant execute on function public.list_client_external_outcomes_v6(uuid)
  to authenticated;
select public.lock_down_definer_functions();
commit;

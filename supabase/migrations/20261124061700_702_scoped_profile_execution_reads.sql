-- Signed-in profile and Inbox readers need scoped receipts. Keep the raw
-- provider attempt and reconciliation tables private.
begin;

create function public.list_google_profile_execution_overview_v6(p_client_id uuid)
returns setof public.google_profile_execution_overview_v6
language plpgsql stable security definer
set search_path = pg_catalog, public set timezone = 'UTC' as $$
begin
  if auth.role() is distinct from 'authenticated' or auth.uid() is null
    or p_client_id is null
    or not coalesce(public.can_access_client(p_client_id), false) then
    raise exception 'Client profile execution access denied.' using errcode = '42501';
  end if;
  return query select o.* from public.google_profile_execution_overview_v6 o
    where o.client_id = p_client_id;
end $$;

create function public.list_meta_profile_execution_overview_v6(p_client_id uuid)
returns setof public.meta_profile_execution_overview_v6
language plpgsql stable security definer
set search_path = pg_catalog, public set timezone = 'UTC' as $$
begin
  if auth.role() is distinct from 'authenticated' or auth.uid() is null
    or p_client_id is null
    or not coalesce(public.can_access_client(p_client_id), false) then
    raise exception 'Client profile execution access denied.' using errcode = '42501';
  end if;
  return query select o.* from public.meta_profile_execution_overview_v6 o
    where o.client_id = p_client_id;
end $$;

create function public.list_google_reply_execution_overview_v6(p_client_id uuid)
returns setof public.google_reply_execution_overview_v6
language plpgsql stable security definer
set search_path = pg_catalog, public set timezone = 'UTC' as $$
begin
  if auth.role() is distinct from 'authenticated' or auth.uid() is null
    or p_client_id is null
    or not coalesce(public.can_access_client(p_client_id), false) then
    raise exception 'Client reply execution access denied.' using errcode = '42501';
  end if;
  return query select o.* from public.google_reply_execution_overview_v6 o
    where o.client_id = p_client_id;
end $$;

revoke all on function public.list_google_profile_execution_overview_v6(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.list_meta_profile_execution_overview_v6(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.list_google_reply_execution_overview_v6(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.list_google_profile_execution_overview_v6(uuid)
  to authenticated;
grant execute on function public.list_meta_profile_execution_overview_v6(uuid)
  to authenticated;
grant execute on function public.list_google_reply_execution_overview_v6(uuid)
  to authenticated;
select public.lock_down_definer_functions();
commit;

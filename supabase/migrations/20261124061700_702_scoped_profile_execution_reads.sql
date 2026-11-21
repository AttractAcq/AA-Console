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

create function public.list_campaign_budget_readback_overview_v6(p_client_id uuid)
returns setof public.campaign_budget_readback_overview_v6
language plpgsql stable security definer
set search_path = pg_catalog, public set timezone = 'UTC' as $$
begin
  if auth.role() is distinct from 'authenticated' or auth.uid() is null
    or p_client_id is null
    or not coalesce(public.can_access_client(p_client_id), false) then
    raise exception 'Client budget readback access denied.' using errcode = '42501';
  end if;
  return query select o.* from public.campaign_budget_readback_overview_v6 o
    where o.client_id = p_client_id;
end $$;

create function public.list_campaign_page_readback_overview_v6(p_client_id uuid)
returns setof public.campaign_page_readback_overview_v6
language plpgsql stable security definer
set search_path = pg_catalog, public set timezone = 'UTC' as $$
begin
  if auth.role() is distinct from 'authenticated' or auth.uid() is null
    or p_client_id is null
    or not coalesce(public.can_access_client(p_client_id), false) then
    raise exception 'Client page readback access denied.' using errcode = '42501';
  end if;
  return query select o.* from public.campaign_page_readback_overview_v6 o
    where o.client_id = p_client_id;
end $$;

create function public.list_proof_approval_execution_evidence_v6(p_client_id uuid)
returns setof public.proof_approval_execution_evidence_v6
language plpgsql stable security definer
set search_path = pg_catalog, public set timezone = 'UTC' as $$
begin
  if auth.role() is distinct from 'authenticated' or auth.uid() is null
    or p_client_id is null
    or not coalesce(public.can_access_client(p_client_id), false) then
    raise exception 'Client proof execution access denied.' using errcode = '42501';
  end if;
  return query select o.* from public.proof_approval_execution_evidence_v6 o
    where o.client_id = p_client_id;
end $$;

-- Gateway tool receipts can include agency-wide approvals. The owning view
-- is admin-only; keep the same boundary and restrict the requested ID set.
create function public.list_gateway_tool_execution_overview_v6(p_approval_ids text[])
returns setof public.gateway_tool_execution_overview_v6
language plpgsql stable security definer
set search_path = pg_catalog, public set timezone = 'UTC' as $$
begin
  if auth.role() is distinct from 'authenticated' or auth.uid() is null
    or not coalesce(public.is_admin(), false)
    or p_approval_ids is null or cardinality(p_approval_ids) not between 1 and 50 then
    raise exception 'Agency gateway execution access denied.' using errcode = '42501';
  end if;
  return query select o.* from public.gateway_tool_execution_overview_v6 o
    where o.approval_id::text = any(p_approval_ids);
end $$;

revoke all on function public.list_google_profile_execution_overview_v6(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.list_meta_profile_execution_overview_v6(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.list_google_reply_execution_overview_v6(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.list_campaign_budget_readback_overview_v6(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.list_campaign_page_readback_overview_v6(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.list_proof_approval_execution_evidence_v6(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.list_gateway_tool_execution_overview_v6(text[])
  from public, anon, authenticated, service_role;
grant execute on function public.list_google_profile_execution_overview_v6(uuid)
  to authenticated;
grant execute on function public.list_meta_profile_execution_overview_v6(uuid)
  to authenticated;
grant execute on function public.list_google_reply_execution_overview_v6(uuid)
  to authenticated;
grant execute on function public.list_campaign_budget_readback_overview_v6(uuid)
  to authenticated;
grant execute on function public.list_campaign_page_readback_overview_v6(uuid)
  to authenticated;
grant execute on function public.list_proof_approval_execution_evidence_v6(uuid)
  to authenticated;
grant execute on function public.list_gateway_tool_execution_overview_v6(text[])
  to authenticated;
select public.lock_down_definer_functions();
commit;

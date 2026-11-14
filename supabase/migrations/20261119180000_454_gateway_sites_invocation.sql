-- A central gateway execution claim may make several provider HTTP calls, but
-- it may enter the Sites adapter only once. Uncertain starts stay reserved.
begin;
alter table public.gateway_tool_execution_receipts_v6
 add column sites_invocation_id text,
 add column sites_invoked_at timestamptz,
 add constraint gateway_sites_invocation_pair_v6 check (
  (sites_invocation_id is null and sites_invoked_at is null)
  or (sites_invocation_id is not null and sites_invoked_at is not null));
create unique index gateway_sites_invocation_id_v6
 on public.gateway_tool_execution_receipts_v6(sites_invocation_id)
 where sites_invocation_id is not null;

create function public.begin_gateway_sites_invocation_v6(
 p_approval_id uuid,p_execution_key uuid,p_client_id uuid,p_bot_id text,
 p_tool text,p_target text,p_provider_org text,p_invocation_id text)
returns boolean language plpgsql volatile security definer
set search_path=pg_catalog,public set timezone='UTC' as $$
declare started uuid;
begin
 perform mcp_internal.require_service_role();
 if p_invocation_id is null or p_invocation_id !~
  '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' then
  raise exception 'A valid Sites invocation ID is required.' using errcode='22023'; end if;
 perform public.assert_gateway_sites_prewrite_v6(p_approval_id,p_execution_key,
  p_client_id,p_bot_id,p_tool,p_target,p_provider_org);
 update public.gateway_tool_execution_receipts_v6
  set sites_invocation_id=p_invocation_id,sites_invoked_at=clock_timestamp()
  where approval_id=p_approval_id and execution_key=p_execution_key
   and status='claimed' and sites_invocation_id is null
  returning approval_id into started;
 return started is not null;
end $$;
revoke all on function public.begin_gateway_sites_invocation_v6(
 uuid,uuid,uuid,text,text,text,text,text) from public,anon,authenticated,service_role;
grant execute on function public.begin_gateway_sites_invocation_v6(
 uuid,uuid,uuid,text,text,text,text,text) to service_role;
create or replace view public.gateway_tool_execution_overview_v6
 with (security_barrier=true) as
 select q.id as approval_id,q.client_id,q.canonical_request_id,
  coalesce(e.status,'not_started') as execution_status,
  e.claimed_at,e.finished_at,e.result_hash,
  e.sites_invocation_id,e.sites_invoked_at
 from public.gateway_tool_reviews_v6 q
 left join public.gateway_tool_execution_receipts_v6 e on e.approval_id=q.id
 where coalesce(public.is_admin(),false);
select public.lock_down_definer_functions();
commit;

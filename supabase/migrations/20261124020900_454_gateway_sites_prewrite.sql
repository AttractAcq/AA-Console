-- The Sites MCP adapter may touch GitHub only for the exact centrally claimed
-- gateway action. Admin Site routes retain their separate page approval path.
begin;
create function public.assert_gateway_sites_prewrite_v6(
 p_approval_id uuid,p_execution_key uuid,p_client_id uuid,p_bot_id text,
 p_tool text,p_target text,p_provider_org text)
returns void language plpgsql volatile security definer
set search_path=pg_catalog,public set timezone='UTC' as $$
declare q public.gateway_tool_reviews_v6%rowtype;
 receipt public.gateway_tool_execution_receipts_v6%rowtype;
begin
 perform mcp_internal.require_service_role();
 if p_approval_id is null or p_execution_key is null or p_client_id is null
  or p_bot_id is null or p_tool not in ('sites.provision','sites.publish_page')
  or nullif(btrim(coalesce(p_target,'')),'') is null
  or nullif(btrim(coalesce(p_provider_org,'')),'') is null then
  raise exception 'Exact gateway Sites action is required.' using errcode='22023'; end if;
 select * into q from public.gateway_tool_reviews_v6 where id=p_approval_id;
 select * into receipt from public.gateway_tool_execution_receipts_v6
  where approval_id=p_approval_id;
 if q.id is null or q.client_id is distinct from p_client_id
  or q.bot_id is distinct from p_bot_id or q.tool is distinct from p_tool
  or q.payload->>'client_id' is distinct from p_client_id::text
  or q.payload->>(case when p_tool='sites.provision' then 'repo' else 'page_id' end)
     is distinct from p_target
  or q.payload->>'provider_org' is distinct from p_provider_org
  or receipt.approval_id is null or receipt.status<>'claimed'
  or receipt.execution_key is distinct from p_execution_key
  or receipt.canonical_request_id is distinct from q.canonical_request_id
  or public.gateway_tool_review_source_state_v6(q.canonical_request_id)<>'source_decided'
  then raise exception 'Current claimed exact gateway Sites approval is required.'
   using errcode='42501'; end if;
end $$;
revoke all on function public.assert_gateway_sites_prewrite_v6(uuid,uuid,uuid,text,text,text,text)
 from public,anon,authenticated,service_role;
grant execute on function public.assert_gateway_sites_prewrite_v6(uuid,uuid,uuid,text,text,text,text)
 to service_role;
select public.lock_down_definer_functions();
commit;

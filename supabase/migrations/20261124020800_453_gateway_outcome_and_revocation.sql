-- Show the gateway's central execution state to Console admins, and allow a
-- human to revoke a previously approved exact tool card before later use.
begin;
create view public.gateway_tool_execution_overview_v6 with (security_barrier=true) as
 select q.id as approval_id,q.client_id,q.canonical_request_id,
  coalesce(e.status,'not_started') as execution_status,
  e.claimed_at,e.finished_at,e.result_hash
 from public.gateway_tool_reviews_v6 q
 left join public.gateway_tool_execution_receipts_v6 e on e.approval_id=q.id
 where coalesce(public.is_admin(),false);
revoke all on public.gateway_tool_execution_overview_v6 from public,anon,authenticated,service_role;
grant select on public.gateway_tool_execution_overview_v6 to authenticated;

create function public.revoke_gateway_tool_review_v6(p_approval_id uuid,
 p_request_id uuid,p_reason text)
returns uuid language plpgsql volatile security definer set search_path=pg_catalog,public set timezone='UTC' as $$
declare q public.gateway_tool_reviews_v6%rowtype; r public.approval_requests_v6%rowtype;
begin
 if auth.role()<>'authenticated' or auth.uid() is null or public.current_role_of() is null
  or not coalesce(public.is_admin(),false) or coalesce(auth.jwt()->>'aal','')<>'aal2' then
  raise exception 'A provisioned AAL2 admin must revoke a gateway tool.' using errcode='42501'; end if;
 if nullif(btrim(coalesce(p_reason,'')),'') is null then
  raise exception 'A revocation reason is required.' using errcode='22023'; end if;
 select * into q from public.gateway_tool_reviews_v6 where id=p_approval_id for update;
 select * into r from public.approval_requests_v6 where id=p_request_id for update;
 if q.id is null or q.canonical_request_id is distinct from p_request_id
  or r.client_id is distinct from q.client_id or r.source_system<>'aa_console'
  or r.source_kind<>'gateway_tool' or r.source_id is distinct from q.id::text
  or r.artifact_hash is distinct from q.source_hash then
  raise exception 'Gateway review identity changed.' using errcode='23514'; end if;
 return public.record_approval_decision_v6(p_request_id,'revoked',q.source_hash,
  'gateway_tool_revoked:'||q.id::text||':'||gen_random_uuid()::text,p_reason);
end $$;
revoke all on function public.revoke_gateway_tool_review_v6(uuid,uuid,text) from public,anon,service_role;
grant execute on function public.revoke_gateway_tool_review_v6(uuid,uuid,text) to authenticated;
select public.lock_down_definer_functions();
commit;

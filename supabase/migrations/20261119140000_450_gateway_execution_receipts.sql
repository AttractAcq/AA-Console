-- One canonical execution claim per gateway approval. An uncertain attempt
-- stays claimed until reconciled; a second gateway process cannot replay it.
begin;
create table public.gateway_tool_execution_receipts_v6 (
 approval_id uuid primary key references public.gateway_tool_reviews_v6(id) on delete restrict,
 canonical_request_id uuid not null references public.approval_requests_v6(id) on delete restrict,
 execution_key uuid not null unique,
 status text not null check(status in ('claimed','completed','accepted','failed','indeterminate','rejected','not_implemented')),
 result_hash text check(result_hash ~ '^[0-9a-f]{64}$'),
 claimed_at timestamptz not null default now(),
 finished_at timestamptz,
 check((status='claimed' and result_hash is null and finished_at is null)
  or (status<>'claimed' and result_hash is not null and finished_at is not null))
);
alter table public.gateway_tool_execution_receipts_v6 enable row level security;
revoke all on public.gateway_tool_execution_receipts_v6 from public,anon,authenticated,service_role;

create function public.claim_gateway_tool_execution_v6(p_approval_id uuid,p_token_id uuid,
 p_payload_hash text,p_execution_key uuid)
returns jsonb language plpgsql volatile security definer set search_path=pg_catalog,public set timezone='UTC' as $$
declare q public.gateway_tool_reviews_v6%rowtype; receipt public.gateway_tool_execution_receipts_v6%rowtype;
begin
 perform mcp_internal.require_service_role();
 if p_approval_id is null or p_token_id is null or p_execution_key is null
  or p_payload_hash !~ '^[0-9a-f]{64}$' then
  raise exception 'Valid exact gateway execution identity is required.' using errcode='22023'; end if;
 select * into q from public.gateway_tool_reviews_v6 where id=p_approval_id for update;
 if q.id is null or q.token_id is distinct from p_token_id
  or q.payload_hash is distinct from p_payload_hash
  or public.gateway_tool_review_source_state_v6(q.canonical_request_id)<>'source_decided'
  then return jsonb_build_object('claimed',false,'state','not_approved'); end if;
 insert into public.gateway_tool_execution_receipts_v6
  (approval_id,canonical_request_id,execution_key,status)
 values(q.id,q.canonical_request_id,p_execution_key,'claimed')
 on conflict (approval_id) do nothing returning * into receipt;
 if receipt.approval_id is not null then
  return jsonb_build_object('claimed',true,'state','claimed'); end if;
 select * into receipt from public.gateway_tool_execution_receipts_v6 where approval_id=q.id;
 return jsonb_build_object('claimed',false,'state',receipt.status);
end $$;

create function public.finish_gateway_tool_execution_v6(p_approval_id uuid,
 p_execution_key uuid,p_status text,p_result_hash text)
returns jsonb language plpgsql volatile security definer set search_path=pg_catalog,public set timezone='UTC' as $$
declare receipt public.gateway_tool_execution_receipts_v6%rowtype;
begin
 perform mcp_internal.require_service_role();
 if p_approval_id is null or p_execution_key is null
  or p_status not in ('completed','accepted','failed','indeterminate','rejected','not_implemented')
  or p_result_hash !~ '^[0-9a-f]{64}$' then
  raise exception 'Valid gateway execution outcome is required.' using errcode='22023'; end if;
 select * into receipt from public.gateway_tool_execution_receipts_v6
  where approval_id=p_approval_id for update;
 if receipt.approval_id is null or receipt.execution_key is distinct from p_execution_key
  then raise exception 'Gateway execution claim is missing.' using errcode='23514'; end if;
 if receipt.status='claimed' then
  update public.gateway_tool_execution_receipts_v6
   set status=p_status,result_hash=p_result_hash,finished_at=clock_timestamp()
   where approval_id=p_approval_id returning * into receipt;
 elsif receipt.status is distinct from p_status or receipt.result_hash is distinct from p_result_hash then
  raise exception 'Gateway execution outcome is already final.' using errcode='23505'; end if;
 return jsonb_build_object('status',receipt.status,'execution_key',receipt.execution_key,
  'result_hash',receipt.result_hash,'finished_at',receipt.finished_at);
end $$;

create function public.gateway_tool_execution_state_v6(p_approval_id uuid)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare q public.gateway_tool_reviews_v6%rowtype; receipt public.gateway_tool_execution_receipts_v6%rowtype;
begin
 if auth.role() is distinct from 'service_role' and
  (auth.role() is distinct from 'authenticated' or not coalesce(public.is_admin(),false))
  then raise exception 'Admin or service access is required.' using errcode='42501'; end if;
 select * into q from public.gateway_tool_reviews_v6 where id=p_approval_id;
 if q.id is null then return jsonb_build_object('state','unverified'); end if;
 select * into receipt from public.gateway_tool_execution_receipts_v6 where approval_id=q.id;
 return jsonb_build_object('state',coalesce(receipt.status,'not_started'),
  'claimed_at',receipt.claimed_at,'finished_at',receipt.finished_at,
  'result_hash',receipt.result_hash);
end $$;

revoke all on function public.claim_gateway_tool_execution_v6(uuid,uuid,text,uuid) from public,anon,authenticated,service_role;
grant execute on function public.claim_gateway_tool_execution_v6(uuid,uuid,text,uuid) to service_role;
revoke all on function public.finish_gateway_tool_execution_v6(uuid,uuid,text,text) from public,anon,authenticated,service_role;
grant execute on function public.finish_gateway_tool_execution_v6(uuid,uuid,text,text) to service_role;
revoke all on function public.gateway_tool_execution_state_v6(uuid) from public,anon,authenticated,service_role;
grant execute on function public.gateway_tool_execution_state_v6(uuid) to authenticated,service_role;
select public.lock_down_definer_functions();
commit;

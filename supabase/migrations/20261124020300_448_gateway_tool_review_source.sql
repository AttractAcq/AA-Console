-- A gateway tool approval is a Console decision on one immutable bot action.
-- SQLite remains a local execution journal; it is never decision authority.
begin;
create table public.gateway_tool_reviews_v6 (
 id uuid primary key,
 client_id uuid not null references public.clients(id) on delete restrict,
 bot_id text not null references mcp_internal.mcp_bots(bot_id),
 token_id uuid not null references mcp_internal.mcp_bot_tokens(token_id),
 tool text not null check(tool ~ '^[a-z0-9_]+(\.[a-z0-9_]+)+$'),
 risk text not null check(risk in ('LOW','MEDIUM','HIGH','CRITICAL')),
 summary text not null check(length(btrim(summary)) between 1 and 2000),
 payload jsonb not null check(jsonb_typeof(payload)='object' and payload<>'{}'::jsonb),
 payload_hash text not null check(payload_hash ~ '^[0-9a-f]{64}$'),
 request_token uuid not null default gen_random_uuid(),
 source_hash text not null default repeat('0',64) check(source_hash ~ '^[0-9a-f]{64}$'),
 expires_at timestamptz not null,
 canonical_request_id uuid unique references public.approval_requests_v6(id),
 created_at timestamptz not null default now()
);
alter table public.gateway_tool_reviews_v6 enable row level security;
revoke all on public.gateway_tool_reviews_v6 from public,anon,authenticated,service_role;

create function public.gateway_tool_review_preview_v6(q public.gateway_tool_reviews_v6)
returns jsonb language sql stable security definer set search_path=pg_catalog,public as $$
 select jsonb_build_object(
  'gateway_approval_id',q.id,'client_id',q.client_id,'bot_id',q.bot_id,
  'token_id',q.token_id,'tool',q.tool,'risk',q.risk,'summary',q.summary,
  'structured_payload',q.payload,'payload_hash',q.payload_hash,
  'request_token',q.request_token,
  'consequence',case when q.tool='workflow.create_approval'
   then 'Informational gateway ticket only; no AA action'
   else 'Permit this exact gateway tool attempt after a separate execution request' end);
$$;
create function public.gateway_tool_review_hash_v6(q public.gateway_tool_reviews_v6)
returns text language sql stable security definer set search_path=pg_catalog,public as $$
 select encode(sha256(convert_to(public.gateway_tool_review_preview_v6(q)::text,'UTF8')),'hex');
$$;
create function public.gateway_tool_review_scope_v6(q public.gateway_tool_reviews_v6)
returns jsonb language sql stable security definer set search_path=pg_catalog,public as $$
 select jsonb_build_object('client_id',q.client_id,'gateway_approval_id',q.id,
  'bot_id',q.bot_id,'token_id',q.token_id,'tool',q.tool,
  'payload_hash',q.payload_hash,'content_hash',q.source_hash,
  'request_token',q.request_token,'effect','allow_one_gateway_tool_execution');
$$;

create function public.gateway_tool_review_source_state_v6(p_request_id uuid)
returns text language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare r public.approval_requests_v6%rowtype; q public.gateway_tool_reviews_v6%rowtype;
 latest text; h text;
begin
 select * into r from public.approval_requests_v6 where id=p_request_id;
 if r.id is null or r.source_system<>'aa_console' or r.source_kind<>'gateway_tool'
  or r.source_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  then return 'unverified'; end if;
 if auth.role() is distinct from 'service_role' and
  (auth.role() is distinct from 'authenticated' or
   not public.can_review_approval_request_v6(r.client_id,r.owner_role))
  then return 'unverified'; end if;
 select * into q from public.gateway_tool_reviews_v6
  where id=r.source_id::uuid and canonical_request_id=r.id and client_id=r.client_id;
 if q.id is null then return 'cancelled'; end if;
 h:=public.gateway_tool_review_hash_v6(q);
 if q.source_hash is distinct from h or r.artifact_hash is distinct from h
  or r.source_version is distinct from (h||':'||q.request_token::text)
  or r.preview is distinct from public.gateway_tool_review_preview_v6(q)
  or r.scope is distinct from public.gateway_tool_review_scope_v6(q)
  or r.expires_at is distinct from q.expires_at
  or r.destination is distinct from ('gateway:'||q.bot_id||':'||q.tool)
  or r.owner_role is distinct from 'admin' then return 'superseded'; end if;
 if q.expires_at<=clock_timestamp() then return 'source_held'; end if;
 if not exists(select 1 from mcp_internal.mcp_bots b where b.bot_id=q.bot_id and b.status='active')
  or not exists(select 1 from public.mcp_bot_clients bc
    where bc.bot_id=q.bot_id and bc.client_id=q.client_id)
  or not exists(select 1 from mcp_internal.mcp_bot_permissions p
    where p.bot_id=q.bot_id and mcp_internal.permission_matches(p.permission_pattern,q.tool))
  or not exists(select 1 from mcp_internal.mcp_bot_tokens t
    where t.token_id=q.token_id and t.bot_id=q.bot_id and t.revoked_at is null
     and (t.expires_at is null or t.expires_at>clock_timestamp()))
  then return 'source_held'; end if;
 select d.decision into latest from public.approval_decision_events_v6 d
  where d.request_id=r.id order by d.event_order desc limit 1;
 if latest='approved' then return 'source_decided'; end if;
 if latest='rejected' or latest='revoked' then return 'revoked'; end if;
 return 'pending';
end $$;

create function public.register_gateway_tool_review_v6(p_packet jsonb)
returns jsonb language plpgsql volatile security definer set search_path=pg_catalog,public set timezone='UTC' as $$
declare q public.gateway_tool_reviews_v6%rowtype; packet_hash text; h text;
 requested_id uuid; requested_client uuid; requested_token uuid;
 requested_bot text; requested_tool text; requested_risk text;
 requested_summary text; requested_payload jsonb; requested_expiry timestamptz;
begin
 perform mcp_internal.require_service_role();
 if p_packet is null or jsonb_typeof(p_packet)<>'object' or exists(
  select 1 from jsonb_object_keys(p_packet) k where k not in
   ('approval_id','client_id','bot_id','token_id','tool','risk','summary','payload','expires_at'))
  then raise exception 'Invalid gateway approval packet.' using errcode='22023'; end if;
 requested_id:=nullif(p_packet->>'approval_id','')::uuid;
 requested_client:=nullif(p_packet->>'client_id','')::uuid;
 requested_token:=nullif(p_packet->>'token_id','')::uuid;
 requested_bot:=nullif(p_packet->>'bot_id','');
 requested_tool:=nullif(p_packet->>'tool','');
 requested_risk:=nullif(p_packet->>'risk','');
 requested_summary:=nullif(btrim(p_packet->>'summary'),'');
 requested_payload:=p_packet->'payload';
 requested_expiry:=nullif(p_packet->>'expires_at','')::timestamptz;
 if requested_id is null or requested_client is null or requested_token is null
  or requested_bot is null or requested_tool is null or requested_risk is null
  or requested_summary is null or length(requested_summary)>2000
  or requested_payload is null or jsonb_typeof(requested_payload)<>'object'
  or requested_payload='{}'::jsonb
  or requested_payload->>'client_id' is distinct from requested_client::text
  or requested_expiry is null or requested_expiry<=clock_timestamp()
  or requested_expiry>clock_timestamp()+interval '24 hours' then
  raise exception 'Gateway approval scope or expiry is invalid.' using errcode='22023'; end if;
 perform mcp_internal.require_bot_client_grant(requested_bot,requested_client);
 if not mcp_internal.bot_has_permission(requested_bot,requested_tool)
  then raise exception 'Bot lacks this tool permission.' using errcode='42501'; end if;
 if not exists(select 1 from mcp_internal.mcp_bot_tokens t
  where t.token_id=requested_token and t.bot_id=requested_bot and t.revoked_at is null
   and (t.expires_at is null or t.expires_at>clock_timestamp())) then
  raise exception 'Current bot token is required.' using errcode='42501'; end if;
 packet_hash:=encode(sha256(convert_to(requested_payload::text,'UTF8')),'hex');
 select * into q from public.gateway_tool_reviews_v6 where id=requested_id for update;
 if q.id is not null then
  if q.client_id is distinct from requested_client or q.bot_id is distinct from requested_bot
   or q.token_id is distinct from requested_token or q.tool is distinct from requested_tool
   or q.risk is distinct from requested_risk or q.summary is distinct from requested_summary
   or q.payload is distinct from requested_payload or q.payload_hash is distinct from packet_hash
   or q.expires_at is distinct from requested_expiry then
   raise exception 'Gateway approval ID has different frozen evidence.' using errcode='23505'; end if;
  return jsonb_build_object('canonical_request_id',q.canonical_request_id,
   'payload_hash',q.payload_hash);
 end if;
 insert into public.gateway_tool_reviews_v6
  (id,client_id,bot_id,token_id,tool,risk,summary,payload,payload_hash,expires_at)
 values(requested_id,requested_client,requested_bot,requested_token,requested_tool,
  requested_risk,requested_summary,requested_payload,packet_hash,requested_expiry)
 returning * into q;
 h:=public.gateway_tool_review_hash_v6(q);
 update public.gateway_tool_reviews_v6 set source_hash=h where id=q.id returning * into q;
 q.canonical_request_id:=public.register_approval_request_v6(jsonb_build_object(
  'client_id',q.client_id,'source_system','aa_console','source_kind','gateway_tool',
  'source_id',q.id::text,'source_version',h||':'||q.request_token::text,
  'title','Gateway tool: '||q.tool,'artifact_hash',h,
  'preview',public.gateway_tool_review_preview_v6(q),
  'destination','gateway:'||q.bot_id||':'||q.tool,
  'scope',public.gateway_tool_review_scope_v6(q),'owner_role','admin',
  'expires_at',q.expires_at,'requester_kind','agent','requester_ref',q.bot_id,
  'owning_path','/clients/'||q.client_id::text||'/delivery/approval-inbox?tab=unified'));
 update public.gateway_tool_reviews_v6 set canonical_request_id=q.canonical_request_id
  where id=q.id;
 return jsonb_build_object('canonical_request_id',q.canonical_request_id,
  'payload_hash',q.payload_hash);
end $$;

create function public.decide_gateway_tool_review_v6(p_approval_id uuid,p_request_id uuid,
 p_approved boolean,p_reason text default null)
returns uuid language plpgsql volatile security definer set search_path=pg_catalog,public set timezone='UTC' as $$
declare q public.gateway_tool_reviews_v6%rowtype;
begin
 if auth.role()<>'authenticated' or auth.uid() is null or public.current_role_of() is null
  or not coalesce(public.is_admin(),false) or coalesce(auth.jwt()->>'aal','')<>'aal2' then
  raise exception 'A provisioned AAL2 admin must decide a gateway tool.' using errcode='42501'; end if;
 select * into q from public.gateway_tool_reviews_v6 where id=p_approval_id for update;
 if q.id is null or q.canonical_request_id is distinct from p_request_id
  or public.gateway_tool_review_source_state_v6(p_request_id)<>'pending'
  or not exists(select 1 from public.approval_inbox_v6 i
   where i.id=p_request_id and i.status='pending' and i.preview_blocker is null) then
  raise exception 'Review the current gateway tool card in Inbox.' using errcode='23514'; end if;
 if not p_approved and nullif(btrim(coalesce(p_reason,'')),'') is null then
  raise exception 'A rejection reason is required.' using errcode='22023'; end if;
 return public.record_approval_decision_v6(p_request_id,
  case when p_approved then 'approved' else 'rejected' end,q.source_hash,
  'gateway_tool:'||q.id::text||':'||q.request_token::text,p_reason);
end $$;

create function public.attest_gateway_tool_review_v6(p_approval_id uuid,
 p_token_id uuid,p_payload_hash text)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare q public.gateway_tool_reviews_v6%rowtype; state text;
begin
 perform mcp_internal.require_service_role();
 select * into q from public.gateway_tool_reviews_v6 where id=p_approval_id;
 if q.id is null or q.token_id is distinct from p_token_id
  or q.payload_hash is distinct from p_payload_hash
  or q.canonical_request_id is null then
  return jsonb_build_object('approved',false,'state','unverified'); end if;
 state:=public.gateway_tool_review_source_state_v6(q.canonical_request_id);
 return jsonb_build_object('approved',state='source_decided',
  'state',state,'canonical_request_id',q.canonical_request_id);
end $$;

create function public.invalidate_gateway_tool_review_v6()
returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
declare changed_bot text; changed_token uuid; changed_client uuid;
begin
 if tg_op='DELETE' then
  changed_bot:=old.bot_id;
  if tg_table_name='mcp_bot_tokens' then changed_token:=old.token_id; end if;
  if tg_table_name='mcp_bot_clients' then changed_client:=old.client_id; end if;
 else
  changed_bot:=new.bot_id;
  if tg_table_name='mcp_bot_tokens' then changed_token:=new.token_id; end if;
  if tg_table_name='mcp_bot_clients' then changed_client:=new.client_id; end if;
 end if;
 if tg_table_name='mcp_bots' then
  update public.gateway_tool_reviews_v6 set request_token=gen_random_uuid()
   where bot_id=changed_bot;
 elsif tg_table_name='mcp_bot_tokens' then
  update public.gateway_tool_reviews_v6 set request_token=gen_random_uuid()
   where token_id=changed_token;
 elsif tg_table_name='mcp_bot_permissions' then
  update public.gateway_tool_reviews_v6 set request_token=gen_random_uuid()
   where bot_id=changed_bot;
 elsif tg_table_name='mcp_bot_clients' then
  update public.gateway_tool_reviews_v6 set request_token=gen_random_uuid()
   where bot_id=changed_bot and client_id=changed_client;
 end if;
 if tg_op='DELETE' then return old; end if;
 return new;
end $$;
create trigger gateway_tool_bot_invalidation_v6 after update on mcp_internal.mcp_bots
 for each row execute function public.invalidate_gateway_tool_review_v6();
create trigger gateway_tool_token_invalidation_v6 after update on mcp_internal.mcp_bot_tokens
 for each row execute function public.invalidate_gateway_tool_review_v6();
create trigger gateway_tool_permission_invalidation_v6 after insert or update or delete on mcp_internal.mcp_bot_permissions
 for each row execute function public.invalidate_gateway_tool_review_v6();
create trigger gateway_tool_client_invalidation_v6 after insert or update or delete on public.mcp_bot_clients
 for each row execute function public.invalidate_gateway_tool_review_v6();

revoke all on function public.gateway_tool_review_preview_v6(public.gateway_tool_reviews_v6) from public,anon,authenticated,service_role;
revoke all on function public.gateway_tool_review_hash_v6(public.gateway_tool_reviews_v6) from public,anon,authenticated,service_role;
revoke all on function public.gateway_tool_review_scope_v6(public.gateway_tool_reviews_v6) from public,anon,authenticated,service_role;
revoke all on function public.gateway_tool_review_source_state_v6(uuid) from public,anon,authenticated,service_role;
grant execute on function public.gateway_tool_review_source_state_v6(uuid) to authenticated,service_role;
revoke all on function public.register_gateway_tool_review_v6(jsonb) from public,anon,authenticated,service_role;
grant execute on function public.register_gateway_tool_review_v6(jsonb) to service_role;
revoke all on function public.decide_gateway_tool_review_v6(uuid,uuid,boolean,text) from public,anon,service_role;
grant execute on function public.decide_gateway_tool_review_v6(uuid,uuid,boolean,text) to authenticated;
revoke all on function public.attest_gateway_tool_review_v6(uuid,uuid,text) from public,anon,authenticated,service_role;
grant execute on function public.attest_gateway_tool_review_v6(uuid,uuid,text) to service_role;
revoke all on function public.invalidate_gateway_tool_review_v6() from public,anon,authenticated,service_role;
select public.lock_down_definer_functions();
commit;

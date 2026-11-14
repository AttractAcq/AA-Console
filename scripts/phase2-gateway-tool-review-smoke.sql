-- Rollback-only canonical gateway tool request and decision boundary.
begin;
insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
values('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
 '00000000-0000-0000-0000-000000000000','authenticated','authenticated',
 'gateway-admin@example.invalid','',now(),now());
insert into public.profiles(id,role,email)
values('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','admin','gateway-admin@example.invalid');
insert into public.clients(id,name,initials)
values('dddddddd-dddd-4ddd-8ddd-dddddddddddd','Gateway fixture','GF');
insert into public.mcp_bot_clients(bot_id,client_id)
values('bot_production','dddddddd-dddd-4ddd-8ddd-dddddddddddd');
insert into mcp_internal.mcp_bot_tokens(token_id,bot_id,token_hash)
values('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','bot_production',decode(repeat('a',64),'hex'));
select set_config('request.jwt.claim.role','service_role',true);
do $checks$
declare aid uuid:='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
 cid uuid:='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
 tid uuid:='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
 packet jsonb; rid uuid; ph text;
 execution_key uuid:='66666666-6666-4666-8666-666666666666';
begin
 packet:=jsonb_build_object('approval_id',aid,'client_id',cid,'bot_id','bot_production',
  'token_id',tid,'tool','workflow.create_approval','risk','MEDIUM',
  'summary','Review production plan','payload',
   jsonb_build_object('client_id',cid,'summary','Review production plan',
    'idempotency_key','gateway-review-1'),
  'expires_at',now()+interval '12 hours');
 rid:=(public.register_gateway_tool_review_v6(packet)->>'canonical_request_id')::uuid;
 if rid is null or (public.register_gateway_tool_review_v6(packet)->>'canonical_request_id')::uuid<>rid
  or (select status from public.approval_inbox_v6 where id=rid)<>'pending'
  then raise exception 'Exact gateway card was not pending and deduplicated'; end if;
 begin
  perform public.register_gateway_tool_review_v6(jsonb_set(packet,'{summary}','"changed"'));
  raise exception 'Gateway ID was reused with different evidence';
 exception when unique_violation then null; end;
 ph:=encode(sha256(convert_to((packet->'payload')::text,'UTF8')),'hex');
 if (public.attest_gateway_tool_review_v6(aid,tid,ph)->>'approved')::boolean
  then raise exception 'Pending gateway request was attested approved'; end if;
 perform set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true);
 perform set_config('request.jwt.claim.role','authenticated',true);
 perform set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal1"}',true);
 begin
  perform public.decide_gateway_tool_review_v6(aid,rid,true);
  raise exception 'AAL1 approved gateway tool';
 exception when insufficient_privilege then null; end;
 perform set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal2"}',true);
 perform public.decide_gateway_tool_review_v6(aid,rid,true);
 if (select status from public.approval_inbox_v6 where id=rid)<>'approved'
  then raise exception 'Canonical gateway review was not approved'; end if;
 perform set_config('request.jwt.claim.role','service_role',true);
 if not (public.attest_gateway_tool_review_v6(aid,tid,ph)->>'approved')::boolean
  or (public.attest_gateway_tool_review_v6(aid,tid,repeat('f',64))->>'approved')::boolean
  then raise exception 'Canonical gateway attestation did not bind payload bytes'; end if;
 if not (public.claim_gateway_tool_execution_v6(aid,tid,ph,execution_key)->>'claimed')::boolean
  or (public.claim_gateway_tool_execution_v6(aid,tid,ph,
   '77777777-7777-4777-8777-777777777777')->>'claimed')::boolean then
  raise exception 'Gateway execution was not claimed exactly once'; end if;
 begin
  perform public.finish_gateway_tool_execution_v6(aid,
   '77777777-7777-4777-8777-777777777777','completed',repeat('b',64));
  raise exception 'Wrong execution key finished the gateway action';
 exception when check_violation then null; end;
 perform public.finish_gateway_tool_execution_v6(aid,execution_key,'completed',repeat('b',64));
 if public.gateway_tool_execution_state_v6(aid)->>'state'<>'completed'
  or (public.claim_gateway_tool_execution_v6(aid,tid,ph,
   '88888888-8888-4888-8888-888888888888')->>'claimed')::boolean then
  raise exception 'Gateway outcome did not remain final'; end if;
 perform set_config('request.jwt.claim.role','authenticated',true);
 perform set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal1"}',true);
 if (select execution_status from public.gateway_tool_execution_overview_v6
  where approval_id=aid)<>'completed' then
  raise exception 'Admin Inbox outcome view did not show the final gateway state'; end if;
 begin
  perform public.revoke_gateway_tool_review_v6(aid,rid,'Withdraw tool access');
  raise exception 'AAL1 revoked the gateway tool';
 exception when insufficient_privilege then null; end;
 perform set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal2"}',true);
 perform public.revoke_gateway_tool_review_v6(aid,rid,'Withdraw tool access');
 if (select status from public.approval_inbox_v6 where id=rid)<>'revoked'
  then raise exception 'Revocation was not visible in the canonical Inbox'; end if;
 perform set_config('request.jwt.claim.role','service_role',true);
 if (public.attest_gateway_tool_review_v6(aid,tid,ph)->>'approved')::boolean
  then raise exception 'Revoked gateway tool still attested approved'; end if;
 update mcp_internal.mcp_bot_tokens set revoked_at=now() where token_id=tid;
 update mcp_internal.mcp_bot_tokens set revoked_at=null where token_id=tid;
 if (public.attest_gateway_tool_review_v6(aid,tid,ph)->>'approved')::boolean
  then raise exception 'Reverted token status revived an old approval'; end if;
end $checks$;
rollback;

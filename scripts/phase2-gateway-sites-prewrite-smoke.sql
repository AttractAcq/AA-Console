-- Rollback-only proof that a Sites provider call needs the exact central claim.
begin;
insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
values('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
 '00000000-0000-0000-0000-000000000000','authenticated','authenticated',
 'sites-gateway-admin@example.invalid','',now(),now());
insert into public.profiles(id,role,email)
values('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','admin','sites-gateway-admin@example.invalid');
insert into public.clients(id,name,initials)
values('dddddddd-dddd-4ddd-8ddd-dddddddddddd','Gateway Sites fixture','GS');
insert into public.mcp_bot_clients(bot_id,client_id)
values('bot_marketing','dddddddd-dddd-4ddd-8ddd-dddddddddddd');
insert into mcp_internal.mcp_bot_tokens(token_id,bot_id,token_hash)
values('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','bot_marketing',decode(repeat('a',64),'hex'));
select set_config('request.jwt.claim.role','service_role',true);
do $checks$
declare aid uuid:='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
 cid uuid:='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
 tid uuid:='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
 key uuid:='66666666-6666-4666-8666-666666666666';
 packet jsonb; rid uuid; ph text;
begin
 packet:=jsonb_build_object('approval_id',aid,'client_id',cid,'bot_id','bot_marketing',
  'token_id',tid,'tool','sites.provision','risk','HIGH',
  'summary','Provision site repository','payload',
   jsonb_build_object('client_id',cid,'repo','harbour','provider_org','example-org',
    'idempotency_key','gateway-sites-test-1'),
  'expires_at',now()+interval '12 hours');
 rid:=(public.register_gateway_tool_review_v6(packet)->>'canonical_request_id')::uuid;
 ph:=encode(sha256(convert_to((packet->'payload')::text,'UTF8')),'hex');
 begin
  perform public.assert_gateway_sites_prewrite_v6(aid,key,cid,'bot_marketing',
   'sites.provision','harbour','example-org');
  raise exception 'Pending Sites card passed prewrite';
 exception when insufficient_privilege then null; end;
 perform set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true);
 perform set_config('request.jwt.claim.role','authenticated',true);
 perform set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal2"}',true);
 perform public.decide_gateway_tool_review_v6(aid,rid,true);
 perform set_config('request.jwt.claim.role','service_role',true);
 begin
  perform public.assert_gateway_sites_prewrite_v6(aid,key,cid,'bot_marketing',
   'sites.provision','harbour','example-org');
  raise exception 'Unclaimed Sites card passed prewrite';
 exception when insufficient_privilege then null; end;
 if not (public.claim_gateway_tool_execution_v6(aid,tid,ph,key)->>'claimed')::boolean
  then raise exception 'Exact Sites claim failed'; end if;
 if not public.begin_gateway_sites_invocation_v6(aid,key,cid,'bot_marketing',
  'sites.provision','harbour','example-org','route-1') then
  raise exception 'First Sites invocation did not start'; end if;
 if public.begin_gateway_sites_invocation_v6(aid,key,cid,'bot_marketing',
  'sites.provision','harbour','example-org','route-2') then
  raise exception 'Duplicate Sites invocation started'; end if;
 if (select sites_invocation_id from public.gateway_tool_execution_receipts_v6
  where approval_id=aid)<>'route-1' then
  raise exception 'First Sites invocation identity changed'; end if;
 perform public.assert_gateway_sites_prewrite_v6(aid,key,cid,'bot_marketing',
  'sites.provision','harbour','example-org');
 begin
  perform public.assert_gateway_sites_prewrite_v6(aid,key,cid,'bot_marketing',
   'sites.provision','harbour','other-org');
  raise exception 'Changed GitHub organization passed prewrite';
 exception when insufficient_privilege then null; end;
 begin
  perform public.assert_gateway_sites_prewrite_v6(aid,key,cid,'bot_marketing',
   'sites.provision','other-repo','example-org');
  raise exception 'Wrong repository passed prewrite';
 exception when insufficient_privilege then null; end;
 begin
  perform public.assert_gateway_sites_prewrite_v6(aid,key,cid,'bot_sales_ops',
   'sites.provision','harbour','example-org');
  raise exception 'Wrong Bot passed prewrite';
 exception when insufficient_privilege then null; end;
 begin
  perform public.assert_gateway_sites_prewrite_v6(aid,
   '77777777-7777-4777-8777-777777777777',cid,'bot_marketing',
   'sites.provision','harbour','example-org');
  raise exception 'Wrong execution key passed prewrite';
 exception when insufficient_privilege then null; end;
 perform public.finish_gateway_tool_execution_v6(aid,key,'completed',repeat('b',64));
 begin
  perform public.assert_gateway_sites_prewrite_v6(aid,key,cid,'bot_marketing',
   'sites.provision','harbour','example-org');
  raise exception 'Completed Sites claim passed prewrite again';
 exception when insufficient_privilege then null; end;
end $checks$;
rollback;

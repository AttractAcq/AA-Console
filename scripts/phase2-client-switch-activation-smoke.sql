-- Rollback-only exact governance of per-client automation activation.
begin;
insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','00000000-0000-0000-0000-000000000000',
 'authenticated','authenticated','switch-owner@example.invalid','',now(),now());
insert into public.profiles(id,role,email) values
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','admin','switch-owner@example.invalid');
insert into public.clients(id,name,initials) values
 ('dddddddd-dddd-4ddd-8ddd-dddddddddddd','Switch fixture','SF'),
 ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee','Other switch fixture','OS');
insert into public.client_engine_settings(client_id)
values ('dddddddd-dddd-4ddd-8ddd-dddddddddddd'),
 ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee');
select set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true);
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claims',
 '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal1"}',true);
do $checks$
declare cid uuid:='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
 request_id uuid; review_id uuid; switch_key text;
begin
 begin
  perform public.set_engine_settings(cid,p_auto_approve_ideas=>true);
  raise exception 'Direct switch setter enabled policy selection';
 exception when insufficient_privilege then null; end;
 begin
  update public.client_engine_settings set auto_approve_ideas=true where client_id=cid;
  raise exception 'Direct table update enabled policy selection';
 exception when insufficient_privilege then null; end;
 perform set_config('request.jwt.claim.role','service_role',true);
 begin
  update public.client_engine_settings set publishing_enabled=true where client_id=cid;
  raise exception 'Service-role table update enabled publishing';
 exception when insufficient_privilege then null; end;
 perform set_config('request.jwt.claim.role','authenticated',true);
 request_id:=public.request_client_switch_activation_v6(cid,'auto_approve_ideas');
 select id into review_id from public.client_switch_activation_reviews_v6
  where canonical_request_id=request_id;
 if request_id is null or public.request_client_switch_activation_v6(cid,'auto_approve_ideas')<>request_id
  or (select status from public.approval_inbox_v6 where id=request_id)<>'pending' then
  raise exception 'Activation request was not pending and deduplicated'; end if;
 begin
  perform public.decide_client_switch_activation_v6(review_id,request_id,true);
  raise exception 'AAL1 enabled a switch';
 exception when insufficient_privilege then null; end;
 update public.client_engine_settings set min_qa_score=min_qa_score+1 where client_id=cid;
 update public.client_engine_settings set min_qa_score=min_qa_score-1 where client_id=cid;
 if public.client_switch_activation_source_state_v6(request_id)<>'superseded' then
  raise exception 'Reverted config edit revived old activation review'; end if;
 perform set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal2"}',true);
 begin
  perform public.decide_client_switch_activation_v6(review_id,request_id,true);
  raise exception 'Stale activation review was accepted';
 exception when check_violation then null; end;
 request_id:=public.request_client_switch_activation_v6(cid,'auto_approve_ideas');
 select id into review_id from public.client_switch_activation_reviews_v6
  where canonical_request_id=request_id;
 perform public.decide_client_switch_activation_v6(review_id,request_id,true);
 if (select auto_approve_ideas from public.client_engine_settings where client_id=cid) is not true
  or public.client_switch_activation_source_state_v6(request_id)<>'source_decided'
  or (select status from public.approval_inbox_v6 where id=request_id)<>'approved' then
  raise exception 'Exact activation decision did not enable the switch'; end if;
 perform set_config('aa.activation_review_id',request_id::text,true);
 begin
  update public.client_engine_settings set auto_approve_ideas=true
   where client_id='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  raise exception 'Another client reused the activation review';
 exception when insufficient_privilege then null; end;
 perform set_config('aa.activation_review_id','',true);
 begin
  perform public.decide_client_switch_activation_v6(review_id,request_id,true);
  raise exception 'Duplicate activation decision succeeded';
 exception when check_violation then null; end;
 perform public.set_engine_settings(cid,p_auto_approve_ideas=>false);
 if (select auto_approve_ideas from public.client_engine_settings where client_id=cid) is not false then
  raise exception 'Immediate switch-off failed'; end if;
 begin
  perform public.set_engine_settings(cid,p_auto_approve_ideas=>true);
  raise exception 'Old approval re-enabled the switch';
 exception when insufficient_privilege then null; end;
 request_id:=public.request_client_switch_activation_v6(cid,'auto_approve_briefs');
 select id into review_id from public.client_switch_activation_reviews_v6
  where canonical_request_id=request_id;
 perform public.decide_client_switch_activation_v6(review_id,request_id,false,'Policy should remain manual');
 if (select auto_approve_briefs from public.client_engine_settings where client_id=cid) is not false
  or (select status from public.approval_inbox_v6 where id=request_id)<>'rejected' then
  raise exception 'Rejected activation changed the switch'; end if;
 foreach switch_key in array array['publishing','proof_publishing',
  'outbound_messaging','lead_magnet_delivery'] loop
  request_id:=public.request_client_switch_activation_v6(cid,switch_key);
  select id into review_id from public.client_switch_activation_reviews_v6
   where canonical_request_id=request_id;
  perform public.decide_client_switch_activation_v6(review_id,request_id,true);
  if (select case switch_key
    when 'publishing' then publishing_enabled
    when 'proof_publishing' then proof_publishing_enabled
    when 'outbound_messaging' then outbound_messaging_enabled
    when 'lead_magnet_delivery' then lead_magnet_delivery_enabled
    end from public.client_engine_settings where client_id=cid) is not true then
   raise exception 'Exact review did not enable %',switch_key; end if;
 end loop;
 perform public.set_engine_platform(cid,'instagram',2);
 perform public.add_engine_window(cid,1::smallint,time '09:00',time '11:00');
 insert into public.client_content_pillars
  (client_id,slug,name,premise,belongs,does_not_belong,target_share,active)
 values(cid,'service-questions','Service questions','Answer practical buying questions',
  'Service decisions','Unsupported claims',100,true);
 request_id:=public.request_client_switch_activation_v6(cid,'engine');
 select id into review_id from public.client_switch_activation_reviews_v6
  where canonical_request_id=request_id;
 perform public.decide_client_switch_activation_v6(review_id,request_id,true);
 if (select enabled from public.client_engine_settings where client_id=cid) is not true then
  raise exception 'Exact client Engine activation did not run the original setter'; end if;
end $checks$;
rollback;

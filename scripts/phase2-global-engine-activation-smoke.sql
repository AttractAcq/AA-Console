-- Rollback-only exact approval of the agency-wide content Engine switch.
begin;
insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','00000000-0000-0000-0000-000000000000',
 'authenticated','authenticated','global-engine-admin@example.invalid','',now(),now());
insert into public.profiles(id,role,email) values
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','admin','global-engine-admin@example.invalid');
insert into public.clients(id,name,initials) values
 ('dddddddd-dddd-4ddd-8ddd-dddddddddddd','Global Engine fixture','GE');
insert into public.client_engine_settings(client_id)
values ('dddddddd-dddd-4ddd-8ddd-dddddddddddd');
select set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true);
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claims',
 '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal1"}',true);
do $checks$
declare request_id uuid; review_id uuid;
begin
 begin
  perform public.set_engine_running(true,'Direct enable');
  raise exception 'Direct global Engine enable succeeded';
 exception when insufficient_privilege then null; end;
 perform set_config('request.jwt.claim.role','service_role',true);
 begin
  update public.engine_controls set enabled=true where id;
  raise exception 'Service-role global Engine enable succeeded';
 exception when insufficient_privilege then null; end;
 perform set_config('request.jwt.claim.role','authenticated',true);
 request_id:=public.request_global_engine_activation_v6();
 select id into review_id from public.global_engine_activation_reviews_v6
  where canonical_request_id=request_id;
 if public.request_global_engine_activation_v6()<>request_id
  or (select status from public.approval_inbox_v6 where id=request_id)<>'pending' then
  raise exception 'Global Engine review was not pending and deduplicated'; end if;
 begin
  perform public.decide_global_engine_activation_v6(review_id,request_id,true);
  raise exception 'AAL1 enabled the global Engine';
 exception when insufficient_privilege then null; end;
 update public.client_engine_settings set min_qa_score=min_qa_score+1
  where client_id='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
 update public.client_engine_settings set min_qa_score=min_qa_score-1
  where client_id='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
 if public.global_engine_activation_source_state_v6(request_id)<>'superseded' then
  raise exception 'Reverted client scope revived global review'; end if;
 perform set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal2"}',true);
 begin
  perform public.decide_global_engine_activation_v6(review_id,request_id,true);
  raise exception 'Stale global Engine review enabled the switch';
 exception when check_violation then null; end;
 request_id:=public.request_global_engine_activation_v6();
 select id into review_id from public.global_engine_activation_reviews_v6
  where canonical_request_id=request_id;
 perform public.decide_global_engine_activation_v6(review_id,request_id,true);
 if (select enabled from public.engine_controls where id) is not true
  or public.global_engine_activation_source_state_v6(request_id)<>'source_decided'
  or (select status from public.approval_inbox_v6 where id=request_id)<>'approved' then
  raise exception 'Exact global Engine decision did not enable the switch'; end if;
 begin
  perform public.decide_global_engine_activation_v6(review_id,request_id,true);
  raise exception 'Duplicate global Engine decision succeeded';
 exception when check_violation then null; end;
 perform public.set_engine_running(false,'Immediate emergency stop');
 if (select enabled from public.engine_controls where id) is not false then
  raise exception 'Global Engine did not stop immediately'; end if;
 begin
  perform public.set_engine_running(true,'Old review reuse');
  raise exception 'Old review re-enabled global Engine';
 exception when insufficient_privilege then null; end;
end $checks$;
rollback;

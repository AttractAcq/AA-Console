-- Rollback-only exact proof request delivery and sender-gate fixture.
begin;
insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','00000000-0000-0000-0000-000000000000',
 'authenticated','authenticated','proof-delivery-admin@example.invalid','',now(),now());
insert into public.profiles(id,role,email) values
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','admin','proof-delivery-admin@example.invalid');
insert into public.clients(id,name,initials) values
 ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Delivery fixture','DF');
insert into public.proof_capture_configs(id,client_id,method,name)
values ('cccccccc-cccc-4ccc-8ccc-cccccccccccc','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','automated_requests','Customer request');
insert into public.proof_capture_links(id,client_id,config_id,token_hash,expires_at)
values ('dddddddd-dddd-4ddd-8ddd-dddddddddddd','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
 'cccccccc-cccc-4ccc-8ccc-cccccccccccc','fixture-token-hash',now()+interval '14 days');
insert into public.proof_request_deliveries(id,client_id,config_id,link_id,event_key,
 recipient,channel,subject,message,capture_url)
values ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
 'cccccccc-cccc-4ccc-8ccc-cccccccccccc','dddddddd-dddd-4ddd-8ddd-dddddddddddd',
 'fixture-event','customer@example.invalid','email','Evidence request',
 'Please send evidence','https://example.invalid/capture/private');
select set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true);
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claims',
 '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal1"}',true);
do $checks$
declare delivery uuid := 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
 request_id uuid; review_id uuid; second_id uuid; claimed_id uuid;
begin
 begin
  perform public.decide_proof_delivery(delivery,true);
  raise exception 'Legacy direct approval succeeded';
 exception when insufficient_privilege then null; end;
 update public.proof_request_deliveries set status='approved',
  approved_by='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',approved_at=now() where id=delivery;
 if public.proof_delivery_send_ready_v6(delivery) then
  raise exception 'Legacy status-only approval cleared the sender gate'; end if;
 update public.proof_request_deliveries set status='pending_approval',
  approved_by=null,approved_at=null where id=delivery;
 request_id := public.request_proof_delivery_review_v6(delivery);
 select id into review_id from public.proof_delivery_reviews_v6 where canonical_request_id=request_id;
 if request_id is null or public.request_proof_delivery_review_v6(delivery)<>request_id
  or (select status from public.approval_inbox_v6 where id=request_id)<>'pending'
  then raise exception 'Exact review was not pending and deduplicated'; end if;
 begin
  perform public.decide_proof_delivery_inbox_v6(review_id,request_id,true);
  raise exception 'AAL1 approved proof request';
 exception when insufficient_privilege then null; end;
 update public.proof_request_deliveries set recipient='other@example.invalid' where id=delivery;
 if public.proof_delivery_source_state_v6(request_id)<>'superseded' then
  raise exception 'Recipient change did not supersede request'; end if;
 perform set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal2"}',true);
 begin
  perform public.decide_proof_delivery_inbox_v6(review_id,request_id,true);
  raise exception 'Stale recipient was approved';
 exception when check_violation then null; end;
 second_id := public.request_proof_delivery_review_v6(delivery);
 if second_id=request_id then raise exception 'Changed recipient reused old request'; end if;
 update public.proof_request_deliveries set recipient='customer@example.invalid' where id=delivery;
 if public.proof_delivery_source_state_v6(request_id)<>'superseded' then
  raise exception 'Old proof delivery epoch revived after recipient reverted'; end if;
 update public.proof_request_deliveries set recipient='other@example.invalid' where id=delivery;
 select id into review_id from public.proof_delivery_reviews_v6 where canonical_request_id=second_id;
 perform public.decide_proof_delivery_inbox_v6(review_id,second_id,true);
 if (select status from public.approval_inbox_v6 where id=second_id)<>'approved'
  or not public.proof_delivery_send_ready_v6(delivery) then
  raise exception 'Approved current delivery did not clear sender gate'; end if;
 update public.proof_capture_links set revoked_at=now() where id='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
 if public.proof_delivery_send_ready_v6(delivery) then
  raise exception 'Revoked link cleared sender gate'; end if;
 perform set_config('request.jwt.claim.role','service_role',true);
 perform set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"service_role"}',true);
 select (public.claim_proof_delivery()).id into claimed_id;
 if claimed_id is not null
  or (select status from public.proof_request_deliveries where id=delivery)<>'cancelled'
  then raise exception 'Revoked delivery was claimed for sending (status %, role %, scheduled %)',
   (select status from public.proof_request_deliveries where id=delivery),auth.role(),
   (select scheduled_at from public.proof_request_deliveries where id=delivery); end if;
 perform set_config('request.jwt.claim.role','authenticated',true);
 perform set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal2"}',true);
 if not exists(select 1 from public.proof_approval_execution_evidence_v6 e
  where e.request_id=second_id and e.client_id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
   and e.source_kind='proof_delivery' and e.state='cancelled'
   and e.external_ref is null) then
  raise exception 'Unified proof delivery outcome did not show cancellation'; end if;
end $checks$;
rollback;

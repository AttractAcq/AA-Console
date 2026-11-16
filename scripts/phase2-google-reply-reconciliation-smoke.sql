-- Rollback-only readback of one uncertain Google reply PUT. No provider call.
begin;
insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','00000000-0000-0000-0000-000000000000',
 'authenticated','authenticated','google-reply-reconcile@example.invalid','',now(),now());
insert into public.profiles(id,role,email) values
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','admin','google-reply-reconcile@example.invalid');
insert into public.clients(id,name,initials) values
 ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Google reply readback fixture','GR');
insert into public.client_google_locations(id,client_id,location_ref,title,verification_state)
values ('cccccccc-cccc-4ccc-8ccc-cccccccccccc','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
 'accounts/test_account/locations/test_location','Fixture location','verified');
insert into public.google_reviews(id,client_id,location_id,review_ref,author_name,star_rating,comment)
values ('dddddddd-dddd-4ddd-8ddd-dddddddddddd','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
 'cccccccc-cccc-4ccc-8ccc-cccccccccccc','review_1','Customer',5,'Helpful service');
insert into public.google_review_replies(id,client_id,review_id,body,body_hash)
values ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
 'dddddddd-dddd-4ddd-8ddd-dddddddddddd','Thank you',
 encode(sha256(convert_to('Thank you','UTF8')),'hex'));
select set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true);
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claims',
 '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal2"}',true);
do $test$
declare cid uuid:='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
 reply_id uuid:='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
 integration_id uuid; request_id uuid; review_id uuid;
 claim jsonb; attempt_id uuid; claim_key uuid; job_id uuid; result_value text;
 ref text:='accounts/test_account/locations/test_location/reviews/review_1';
begin
 select id into request_id from public.approval_requests_v6
  where source_kind='google_review_reply' and source_id=reply_id::text;
 perform public.decide_google_review_reply_from_inbox_v6(reply_id,
  (select source_version from public.approval_requests_v6 where id=request_id),
  (select artifact_hash from public.approval_requests_v6 where id=request_id),true,null);
 integration_id:=public.admin_store_integration_credential(cid,'google_business',
  'Fixture Google account','fixture-secret','write');
 request_id:=public.request_integration_grant_v6(integration_id,false);
 select id into review_id from public.integration_grant_reviews_v6
  where canonical_request_id=request_id;
 perform public.decide_integration_grant_v6(review_id,request_id,true);
 perform set_config('request.jwt.claim.role','service_role',true);
 claim:=public.claim_google_reply_execution_v6(reply_id);
 attempt_id:=(claim->>'attempt_id')::uuid;
 claim_key:=(claim->>'claim_key')::uuid;
 if attempt_id is null then raise exception 'No one-shot reply attempt'; end if;
 if not public.begin_google_reply_write_v6(attempt_id,claim_key) then
  raise exception 'Reply attempt did not begin'; end if;
 if not public.finish_google_reply_execution_v6(attempt_id,claim_key,
  'uncertain',null,null,null,'PUT response lost') then
  raise exception 'Reply attempt did not become uncertain'; end if;
 if public.google_reply_reconciliation_target_v6(attempt_id,gen_random_uuid()) is not null then
  raise exception 'Wrong client read uncertain reply'; end if;
 if public.google_reply_reconciliation_target_v6(attempt_id,cid)->>'review_ref'<>'review_1' then
  raise exception 'Exact reply target unavailable'; end if;
 begin
  perform public.record_google_reply_reconciliation_v6(attempt_id,cid,
   'accounts/wrong/locations/test_location/reviews/review_1',claim->>'body_hash',null,'APPROVED');
  raise exception 'Wrong review reference reconciled reply';
 exception when check_violation then null; end;
 result_value:=public.record_google_reply_reconciliation_v6(attempt_id,cid,
  ref,claim->>'body_hash',null,'PENDING');
 if result_value<>'pending'
  or (select status from public.google_review_replies where id=reply_id)<>'approved'
  or (select o.outcome from public.client_external_outcomes_v6 o
   where o.outcome_id=(claim->>'attempt_id')::uuid)<>'pending' then
  raise exception 'Pending moderation falsely posted reply'; end if;
 result_value:=public.record_google_reply_reconciliation_v6(attempt_id,cid,
  ref,claim->>'body_hash',null,'REJECTED');
 if result_value<>'rejected'
  or (select status from public.google_review_replies where id=reply_id)<>'approved' then
  raise exception 'Rejected moderation falsely posted reply'; end if;
 result_value:=public.record_google_reply_reconciliation_v6(attempt_id,cid,
  ref,repeat('0',64),null,'APPROVED');
 if result_value<>'different'
  or (select status from public.google_review_replies where id=reply_id)<>'approved' then
  raise exception 'Different reply bytes falsely posted'; end if;
 perform set_config('request.jwt.claim.role','authenticated',true);
 perform set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal1"}',true);
 begin
  perform public.request_google_reply_reconciliation_v6(attempt_id);
  raise exception 'AAL1 queued reply readback';
 exception when insufficient_privilege then null; end;
 perform set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal2"}',true);
 job_id:=public.request_google_reply_reconciliation_v6(attempt_id);
 if job_id is null or public.request_google_reply_reconciliation_v6(attempt_id)<>job_id
  or not exists(select 1 from public.agent_jobs j where j.id=job_id
   and j.agent_key='google_reply_reconciler'
   and j.input_id=(claim->>'attempt_id')::uuid) then
  raise exception 'One owner-requested read-only job was not queued'; end if;
 perform set_config('request.jwt.claim.role','service_role',true);
 result_value:=public.record_google_reply_reconciliation_v6(attempt_id,cid,
  ref,claim->>'body_hash','2026-11-15T00:00:00Z','APPROVED');
 update public.google_reply_reconciliation_checks_v6 c
  set checked_at='2026-11-15T00:00:00Z'
  where c.attempt_id=(claim->>'attempt_id')::uuid;
 if result_value<>'matched'
  or (select status from public.google_review_replies where id=reply_id)<>'posted'
  or (select status from public.google_reply_execution_attempts_v6
   where id=(claim->>'attempt_id')::uuid)<>'uncertain'
  or (select v.reconciliation_result from public.google_reply_execution_overview_v6 v
   where v.attempt_id=(claim->>'attempt_id')::uuid)<>'matched'
  or (select o.outcome from public.client_external_outcomes_v6 o
   where o.outcome_id=(claim->>'attempt_id')::uuid)<>'confirmed' then
  raise exception 'Later approved match did not resolve reply and alert'; end if;
 if public.claim_google_reply_execution_v6(reply_id) is not null then
  raise exception 'Readback allowed second reply PUT'; end if;
 perform set_config('request.jwt.claim.role','authenticated',true);
 begin
  perform public.request_google_reply_reconciliation_v6(attempt_id);
  raise exception 'Matched reply queued another readback';
 exception when check_violation then null; end;
end $test$;
rollback;

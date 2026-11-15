-- Rollback-only exact Google reply decision and prewrite fixture.
begin;
insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','00000000-0000-0000-0000-000000000000',
 'authenticated','authenticated','google-reply-admin@example.invalid','',now(),now());
insert into public.profiles(id,role,email) values
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','admin','google-reply-admin@example.invalid');
insert into public.clients(id,name,initials) values
 ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Google reply fixture','GR');
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
do $decision$
declare r public.approval_requests_v6%rowtype; v_job uuid;
begin
 select * into r from public.approval_requests_v6
  where source_kind='google_review_reply'
    and source_id='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
 if r.id is null then raise exception 'Exact Google reply card missing'; end if;
 if public.google_reply_prewrite_current_v6('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee') then
  raise exception 'Human role passed service-only prewrite'; end if;
 perform public.decide_google_review_reply_from_inbox_v6(
  'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',r.source_version,r.artifact_hash,true,null);
 perform set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal1"}',true);
 begin
  perform public.request_google_reply_send_v6('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee');
  raise exception 'AAL1 queued a Google reply send';
 exception when insufficient_privilege then null; end;
 perform set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal2"}',true);
 v_job:=public.request_google_reply_send_v6('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee');
 if v_job is null or public.request_google_reply_send_v6('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee')<>v_job
  or not exists(select 1 from public.agent_jobs where id=v_job
    and agent_key='google_reply_sender' and input_id='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee')
  then raise exception 'Exact Google reply did not queue one owned job'; end if;
end $decision$;
select set_config('request.jwt.claim.role','service_role',true);
do $checks$
declare a jsonb; v_id uuid; v_key uuid; v_recorded boolean; v_duplicate boolean; v_status text;
begin
 if not public.google_reply_prewrite_current_v6('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee') then
  raise exception 'Current exact reply decision was not eligible'; end if;
 a:=public.claim_google_reply_execution_v6('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee');
 if a is null or a->>'exact_body'<>'Thank you'
  or public.claim_google_reply_execution_v6('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee') is not null then
  raise exception 'Google reply did not reserve exactly one attempt'; end if;
 v_id:=(a->>'attempt_id')::uuid; v_key:=(a->>'claim_key')::uuid;
 if public.begin_google_reply_write_v6(v_id,gen_random_uuid())
  or not public.begin_google_reply_write_v6(v_id,v_key)
  or public.begin_google_reply_write_v6(v_id,v_key) then
  raise exception 'Google reply write did not begin exactly once'; end if;
 begin
  update public.google_review_replies set status='posted',posted_at=clock_timestamp(),
   external_ref='accounts/test_account/locations/test_location/reviews/review_1'
   where id='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  raise exception 'Started but unconfirmed Google reply marked posted';
 exception when insufficient_privilege then null; end;
 begin
  perform public.finish_google_reply_execution_v6(v_id,v_key,'confirmed',repeat('0',64));
  raise exception 'Incorrect provider bytes confirmed a Google reply';
 exception when check_violation then null; end;
 begin
  perform public.finish_google_reply_execution_v6(v_id,v_key,'refused',null,null,null,'After write');
  raise exception 'Started Google write was falsely recorded as refused';
 exception when check_violation then null; end;
 v_recorded:=public.finish_google_reply_execution_v6(v_id,v_key,'confirmed',a->>'body_hash',
  '2026-11-15T00:00:00Z','PUBLISHED');
 v_duplicate:=public.finish_google_reply_execution_v6(v_id,v_key,'confirmed',a->>'body_hash');
 select status into v_status from public.google_reply_execution_attempts_v6 where id=v_id;
 if not v_recorded or v_duplicate or v_status<>'confirmed' then
  raise exception 'Exact Google readback failed: first %, second %, status %',
    v_recorded,v_duplicate,v_status; end if;
 if (select status from public.google_review_replies
   where id='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee')<>'posted'
  or (select external_ref from public.google_review_replies
   where id='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee')
   is distinct from 'accounts/test_account/locations/test_location/reviews/review_1' then
  raise exception 'Confirmed Google reply readback did not update exact source'; end if;
 perform set_config('request.jwt.claim.role','authenticated',true);
 if (select status from public.google_reply_execution_overview_v6
   where attempt_id=v_id) is distinct from 'confirmed' then
   raise exception 'Client approval owner could not read the execution outcome'; end if;
 if (select outcome from public.client_external_outcomes_v6
   where outcome_id=v_id and client_id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')
   is distinct from 'confirmed' then
   raise exception 'Confirmed provider receipt missing from client operational outcomes'; end if;
 perform set_config('request.jwt.claim.role','service_role',true);
 update public.google_reviews set comment='Changed review'
  where id='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
 if public.google_reply_prewrite_current_v6('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee') then
  raise exception 'Changed review kept the old reply approval'; end if;
 update public.google_reviews set comment='Helpful service'
  where id='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
 if public.google_reply_prewrite_current_v6('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee') then
  raise exception 'Edited-and-reverted review revived old approval'; end if;
 update public.client_google_locations set verification_state='suspended'
  where id='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
 if public.google_reply_prewrite_current_v6('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee') then
  raise exception 'Suspended location passed prewrite'; end if;
end $checks$;
do $credential$
declare integration_id uuid; request_id uuid; review_id uuid;
  cid uuid:='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
begin
 if public.google_reply_credential_eligible_v6(cid) then
  raise exception 'Missing Google credential passed reply sender gate'; end if;
 perform set_config('request.jwt.claim.role','authenticated',true);
 perform set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal2"}',true);
 integration_id:=public.admin_store_integration_credential(
  cid,'google_business','Fixture Google account','fixture-secret','read');
 request_id:=public.request_integration_grant_v6(integration_id,false);
 select id into review_id from public.integration_grant_reviews_v6
  where canonical_request_id=request_id;
 perform public.decide_integration_grant_v6(review_id,request_id,true);
 perform set_config('request.jwt.claim.role','service_role',true);
 if public.google_reply_credential_eligible_v6(cid) then
  raise exception 'Read-only Google grant passed reply sender gate'; end if;
 perform set_config('request.jwt.claim.role','authenticated',true);
 integration_id:=public.admin_store_integration_credential(
  cid,'google_business','Fixture Google account','fixture-write-secret','write');
 update public.client_integrations set token_expires_at=now()+interval '1 day'
  where id=integration_id;
 perform set_config('request.jwt.claim.role','service_role',true);
 if public.google_reply_credential_eligible_v6(cid) then
  raise exception 'Unapproved write credential passed reply sender gate'; end if;
 perform set_config('request.jwt.claim.role','authenticated',true);
 request_id:=public.request_integration_grant_v6(integration_id,false);
 select id into review_id from public.integration_grant_reviews_v6
  where canonical_request_id=request_id;
 perform public.decide_integration_grant_v6(review_id,request_id,true);
 perform set_config('request.jwt.claim.role','service_role',true);
 if not public.google_reply_credential_eligible_v6(cid) then
  raise exception 'Current exact write grant did not release reply sender'; end if;
 update public.client_integrations set credential_label='Changed Google account'
  where id=integration_id;
 if public.google_reply_credential_eligible_v6(cid) then
  raise exception 'Changed account label kept reply sender credential eligible'; end if;
end $credential$;
rollback;

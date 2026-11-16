-- Rollback-only Google Business Profile proposal and execution-hold fixture.
begin;
insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','00000000-0000-0000-0000-000000000000',
 'authenticated','authenticated','google-profile-admin@example.invalid','',now(),now());
insert into public.profiles(id,role,email) values
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','admin','google-profile-admin@example.invalid');
insert into public.clients(id,name,initials) values
 ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Google profile fixture','GP'),
 ('dddddddd-dddd-4ddd-8ddd-dddddddddddd','Other client','OC');
insert into public.client_google_locations(id,client_id,location_ref,title,verification_state)
values ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
 'accounts/test_account/locations/test_location','Test location','verified');
insert into public.google_profile_changes(id,client_id,location_id,field,current_value,proposed_value,reason)
values ('cccccccc-cccc-4ccc-8ccc-cccccccccccc','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee','description','Old text','New text','Update service wording'),
 ('ffffffff-ffff-4fff-8fff-ffffffffffff','dddddddd-dddd-4ddd-8ddd-dddddddddddd',
 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee','description','Other text','Cross-client text','Invalid location');
select set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true);
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claims',
 '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal1"}',true);
do $checks$
declare change_id uuid := 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
 request_id uuid; review_id uuid; second_id uuid; third_id uuid;
begin
 begin
  update public.google_profile_changes set status='approved' where id=change_id;
  raise exception 'Direct Google approval succeeded';
 exception when insufficient_privilege then null; end;
 begin
  perform public.request_google_profile_review_v6('ffffffff-ffff-4fff-8fff-ffffffffffff');
  raise exception 'Cross-client Google location received an Inbox card';
 exception when check_violation then null; end;
 request_id:=public.request_google_profile_review_v6(change_id);
 select id into review_id from public.google_profile_review_requests_v6 where canonical_request_id=request_id;
 if request_id is null or public.request_google_profile_review_v6(change_id)<>request_id
  or (select status from public.approval_inbox_v6 where id=request_id)<>'pending'
  then raise exception 'Exact Google proposal was not pending and deduplicated'; end if;
 begin
  perform public.decide_google_profile_inbox_v6(review_id,request_id,true);
  raise exception 'AAL1 approved Google profile proposal';
 exception when insufficient_privilege then null; end;
 update public.google_profile_changes set proposed_value='Temporary text' where id=change_id;
 update public.google_profile_changes set proposed_value='New text' where id=change_id;
 if public.google_profile_review_source_state_v6(request_id)<>'superseded' then
  raise exception 'Reverted proposal words revived the same pending review'; end if;
 update public.google_profile_changes set proposed_value='Different text' where id=change_id;
 if public.google_profile_review_source_state_v6(request_id)<>'superseded' then
  raise exception 'Changed Google proposal did not supersede review'; end if;
 perform set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal2"}',true);
 begin
  perform public.decide_google_profile_inbox_v6(review_id,request_id,true);
  raise exception 'Stale Google proposal was approved';
 exception when check_violation then null; end;
 second_id:=public.request_google_profile_review_v6(change_id);
 if second_id=request_id then raise exception 'Changed Google proposal reused stale review'; end if;
 update public.google_profile_changes set proposed_value='New text' where id=change_id;
 if public.google_profile_review_source_state_v6(request_id)<>'superseded' then
  raise exception 'Old Google review revived when its text returned'; end if;
 update public.google_profile_changes set proposed_value='Different text' where id=change_id;
 third_id:=public.request_google_profile_review_v6(change_id);
 if third_id=second_id then raise exception 'Reverted edit reused stale review'; end if;
 select id into review_id from public.google_profile_review_requests_v6 where canonical_request_id=third_id;
 perform public.decide_google_profile_inbox_v6(review_id,third_id,true);
 if (select status from public.approval_inbox_v6 where id=third_id)<>'approved'
  or (select approved_request_id from public.google_profile_changes where id=change_id)<>third_id
  then raise exception 'Exact Google decision did not sign the source'; end if;
 perform set_config('request.jwt.claim.role','service_role',true);
 perform set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"service_role"}',true);
 if public.google_profile_prewrite_current_v6(change_id) then
  raise exception 'Unreviewed Google credential passed profile prewrite'; end if;
 begin
  perform public.record_profile_change_applied(change_id,'unverified-provider-ref');
  raise exception 'Held Google profile field was marked applied';
 exception when insufficient_privilege then null; end;
end $checks$;
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claims',
 '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal2"}',true);
do $prewrite$
declare cid uuid:='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
 change_id uuid:='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
 loc_id uuid:='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
 integration_id uuid; request_id uuid; review_id uuid; job_id uuid;
 claim jsonb; attempt_id uuid; claim_key uuid;
begin
 integration_id:=public.admin_store_integration_credential(
  cid,'google_business','accounts/test_account','fixture-secret','write');
 request_id:=public.request_integration_grant_v6(integration_id,false);
 select id into review_id from public.integration_grant_reviews_v6
  where canonical_request_id=request_id;
 perform public.decide_integration_grant_v6(review_id,request_id,true);
 perform set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal1"}',true);
 begin
  perform public.request_google_profile_write_v6(change_id);
  raise exception 'AAL1 queued a Google profile write';
 exception when insufficient_privilege then null; end;
 perform set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal2"}',true);
 job_id:=public.request_google_profile_write_v6(change_id);
 if job_id is null or public.request_google_profile_write_v6(change_id)<>job_id
  or not exists(select 1 from public.agent_jobs j where j.id=job_id
   and j.agent_key='google_profile_field_writer'
   and j.input_table='google_profile_changes' and j.input_id=change_id) then
  raise exception 'Exact Google profile write did not queue one owned job'; end if;
 if public.google_profile_prewrite_current_v6(change_id) then
  raise exception 'Authenticated caller passed service-only profile prewrite'; end if;
 perform set_config('request.jwt.claim.role','service_role',true);
 if not public.google_profile_prewrite_current_v6(change_id) then
  raise exception 'Exact approved proposal and write grant did not pass prewrite'; end if;
 claim:=public.claim_google_profile_execution_v6(change_id);
 if claim is null or claim->>'proposed_value'<>'Different text'
  or public.claim_google_profile_execution_v6(change_id) is not null then
  raise exception 'Profile field did not receive exactly one execution reservation'; end if;
 attempt_id:=(claim->>'attempt_id')::uuid;
 claim_key:=(claim->>'claim_key')::uuid;
 if public.begin_google_profile_write_v6(attempt_id,gen_random_uuid())
  or not public.begin_google_profile_write_v6(attempt_id,claim_key)
  or public.begin_google_profile_write_v6(attempt_id,claim_key) then
  raise exception 'Google profile write did not begin exactly once'; end if;
 begin
  perform public.record_profile_change_applied(change_id,'unverified-provider-ref');
  raise exception 'Started but unconfirmed profile write marked source applied';
 exception when insufficient_privilege then null; end;
 begin
  perform public.finish_google_profile_execution_v6(
   attempt_id,claim_key,'confirmed','Wrong text','locations/test_location#description');
  raise exception 'Mismatched provider readback was confirmed';
 exception when check_violation then null; end;
 begin
  perform public.finish_google_profile_execution_v6(
   attempt_id,claim_key,'refused',null,null,'After write');
  raise exception 'Started provider write was falsely recorded as refused';
 exception when check_violation then null; end;
 if not public.finish_google_profile_execution_v6(attempt_id,claim_key,
  'confirmed','Different text','locations/test_location#description')
  or public.finish_google_profile_execution_v6(attempt_id,claim_key,
   'confirmed','Different text','locations/test_location#description') then
  raise exception 'Google profile result was not final and immutable'; end if;
 if (select v.status from public.google_profile_execution_overview_v6 v
  where v.change_id='cccccccc-cccc-4ccc-8ccc-cccccccccccc') is distinct from 'confirmed' then
  raise exception 'Profile execution outcome was not readable'; end if;
 if (select status from public.google_profile_changes where id=change_id)<>'applied'
  or (select external_ref from public.google_profile_changes where id=change_id)
   is distinct from 'locations/test_location#description' then
  raise exception 'Confirmed readback did not update the exact source status'; end if;
 update public.client_google_locations set title='Changed title' where id=loc_id;
 update public.client_google_locations set title='Test location' where id=loc_id;
 if public.google_profile_prewrite_current_v6(change_id) then
  raise exception 'Changed-and-restored location revived profile approval'; end if;
end $prewrite$;
rollback;

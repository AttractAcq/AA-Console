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
 request_id uuid; review_id uuid; second_id uuid;
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
 select id into review_id from public.google_profile_review_requests_v6 where canonical_request_id=second_id;
 perform public.decide_google_profile_inbox_v6(review_id,second_id,true);
 if (select status from public.approval_inbox_v6 where id=second_id)<>'approved'
  or (select approved_request_id from public.google_profile_changes where id=change_id)<>second_id
  then raise exception 'Exact Google decision did not sign the source'; end if;
 perform set_config('request.jwt.claim.role','service_role',true);
 perform set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"service_role"}',true);
 begin
  perform public.record_profile_change_applied(change_id,'unverified-provider-ref');
  raise exception 'Held Google profile field was marked applied';
 exception when insufficient_privilege then null; end;
end $checks$;
rollback;

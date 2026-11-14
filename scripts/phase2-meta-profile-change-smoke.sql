-- Rollback-only exact Meta profile proposal decision fixture.
begin;
insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','00000000-0000-0000-0000-000000000000',
 'authenticated','authenticated','meta-profile-admin@example.invalid','',now(),now());
insert into public.profiles(id,role,email) values
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','admin','meta-profile-admin@example.invalid');
insert into public.clients(id,name,initials) values
 ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Meta profile fixture','MP');
insert into public.meta_profile_changes(id,client_id,platform,field,current_value,proposed_value,reason)
values ('cccccccc-cccc-4ccc-8ccc-cccccccccccc','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
 'instagram','bio','Old bio','New bio','Refresh messaging');
select set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true);
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claims',
 '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal1"}',true);
do $checks$
declare change_id uuid := 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
 request_id uuid; review_id uuid; second_id uuid;
begin
 begin
  perform public.decide_meta_profile_change_v6(change_id,true);
  raise exception 'Legacy direct decision succeeded';
 exception when insufficient_privilege then null; end;
 begin
  update public.meta_profile_changes set status='approved' where id=change_id;
  raise exception 'Direct status approval succeeded';
 exception when insufficient_privilege then null; end;
 request_id:=public.request_meta_profile_review_v6(change_id);
 select id into review_id from public.meta_profile_review_requests_v6
  where canonical_request_id=request_id;
 if request_id is null or public.request_meta_profile_review_v6(change_id)<>request_id
  or (select status from public.approval_inbox_v6 where id=request_id)<>'pending'
  then raise exception 'Exact Meta proposal was not pending and deduplicated'; end if;
 begin
  perform public.decide_meta_profile_inbox_v6(review_id,request_id,true);
  raise exception 'AAL1 approved Meta proposal';
 exception when insufficient_privilege then null; end;
 update public.meta_profile_changes set proposed_value='Different bio' where id=change_id;
 if public.meta_profile_review_source_state_v6(request_id)<>'superseded' then
  raise exception 'Changed proposal did not supersede review'; end if;
 perform set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal2"}',true);
 begin
  perform public.decide_meta_profile_inbox_v6(review_id,request_id,true);
  raise exception 'Stale Meta proposal was approved';
 exception when check_violation then null; end;
 second_id:=public.request_meta_profile_review_v6(change_id);
 if second_id=request_id then raise exception 'Changed proposal reused stale request'; end if;
 update public.meta_profile_changes set proposed_value='New bio' where id=change_id;
 if public.meta_profile_review_source_state_v6(request_id)<>'superseded' then
  raise exception 'Old Meta review epoch revived after proposal reverted'; end if;
 update public.meta_profile_changes set proposed_value='Different bio' where id=change_id;
 select id into review_id from public.meta_profile_review_requests_v6 where canonical_request_id=second_id;
 perform public.decide_meta_profile_inbox_v6(review_id,second_id,true);
 if (select status from public.approval_inbox_v6 where id=second_id)<>'approved'
  or (select approved_request_id from public.meta_profile_changes where id=change_id)<>second_id
  then raise exception 'Exact Meta profile decision did not sign source'; end if;
 perform set_config('request.jwt.claim.role','service_role',true);
 perform set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"service_role"}',true);
 begin
  perform public.record_profile_change_applied(change_id,'unverified-provider-ref');
  raise exception 'A held Meta profile field was marked applied';
 exception when insufficient_privilege then null; end;
end $checks$;
rollback;

-- Rollback-only exact agency-wide video owner governance.
begin;
insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
values
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','00000000-0000-0000-0000-000000000000','authenticated','authenticated','owner-admin-a@example.invalid','',now(),now()),
 ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','00000000-0000-0000-0000-000000000000','authenticated','authenticated','owner-admin-b@example.invalid','',now(),now());
insert into public.profiles(id,role,email) values
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','admin','owner-admin-a@example.invalid'),
 ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','admin','owner-admin-b@example.invalid');
select set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true);
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claims',
 '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal1"}',true);
do $checks$
declare owner_a uuid:='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
 owner_b uuid:='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
 request_id uuid; review_id uuid;
begin
 begin
  perform public.set_content_approval_owner(owner_b);
  raise exception 'Direct global owner assignment succeeded';
 exception when insufficient_privilege then null; end;
 request_id:=public.request_global_video_owner_v6(owner_b);
 select id into review_id from public.global_video_owner_reviews_v6
  where canonical_request_id=request_id;
 if public.request_global_video_owner_v6(owner_b)<>request_id
  or (select status from public.approval_inbox_v6 where id=request_id)<>'pending'
  or (select client_id from public.approval_inbox_v6 where id=request_id) is not null
  then raise exception 'Global owner review was not pending, deduplicated and agency scoped'; end if;
 begin
  perform public.decide_global_video_owner_v6(review_id,request_id,true);
  raise exception 'AAL1 assigned the global video owner';
 exception when insufficient_privilege then null; end;
 update public.profiles set role='employee' where id=owner_b;
 update public.profiles set role='admin' where id=owner_b;
 if public.global_video_owner_source_state_v6(request_id)<>'superseded' then
  raise exception 'Reverted owner role revived the old review'; end if;
 perform set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal2"}',true);
 begin
  perform public.decide_global_video_owner_v6(review_id,request_id,true);
  raise exception 'Stale owner review was approved';
 exception when check_violation then null; end;
 request_id:=public.request_global_video_owner_v6(owner_b);
 select id into review_id from public.global_video_owner_reviews_v6
  where canonical_request_id=request_id;
 perform set_config('request.jwt.claim.sub',owner_b::text,true);
 perform set_config('request.jwt.claims',
  '{"sub":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb","role":"authenticated","aal":"aal2"}',true);
 begin
  perform public.decide_global_video_owner_v6(review_id,request_id,true);
  raise exception 'Admin approved their own owner assignment';
 exception when insufficient_privilege then null; end;
 perform set_config('request.jwt.claim.sub',owner_a::text,true);
 perform set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal2"}',true);
 perform public.decide_global_video_owner_v6(review_id,request_id,true);
 if (select owner_user_id from public.content_approval_settings where singleton)<>owner_b
  or (select status from public.approval_inbox_v6 where id=request_id)<>'approved'
  then raise exception 'Exact agency review did not assign the owner'; end if;
 begin
  perform public.decide_global_video_owner_v6(review_id,request_id,true);
  raise exception 'Duplicate owner decision succeeded';
 exception when check_violation then null; end;
 begin
  perform public.set_content_approval_owner(owner_a);
  raise exception 'Old review allowed a direct owner change';
 exception when insufficient_privilege then null; end;
end $checks$;
rollback;

-- Rollback-only exact rendered-video owner, SMM and client seat fixture.
begin;
insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
values
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','00000000-0000-0000-0000-000000000000','authenticated','authenticated','video-owner@example.invalid','',now(),now()),
 ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','00000000-0000-0000-0000-000000000000','authenticated','authenticated','video-smm@example.invalid','',now(),now()),
 ('cccccccc-cccc-4ccc-8ccc-cccccccccccc','00000000-0000-0000-0000-000000000000','authenticated','authenticated','video-client@example.invalid','',now(),now());
insert into public.profiles(id,role,email) values
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','admin','video-owner@example.invalid'),
 ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','employee','video-smm@example.invalid'),
 ('cccccccc-cccc-4ccc-8ccc-cccccccccccc','client','video-client@example.invalid');
insert into public.clients(id,name,initials) values
 ('dddddddd-dddd-4ddd-8ddd-dddddddddddd','Video fixture','VF');
insert into public.client_users(client_id,user_id) values
 ('dddddddd-dddd-4ddd-8ddd-dddddddddddd','cccccccc-cccc-4ccc-8ccc-cccccccccccc');
insert into public.team_members(id,user_id,category,name,initials)
values ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','smm','Fixture SMM','FS');
insert into public.client_assignments(member_id,client_id)
values ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee','dddddddd-dddd-4ddd-8ddd-dddddddddddd');
insert into public.content_approval_settings(singleton,owner_user_id)
values (true,'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
insert into public.client_media_assets(id,client_id,media_type,title,storage_path,
 render_path,content_format,usage_rights)
values ('ffffffff-ffff-4fff-8fff-ffffffffffff','dddddddd-dddd-4ddd-8ddd-dddddddddddd',
 'video','Exact cut','dddddddd-dddd-4ddd-8ddd-dddddddddddd/source.mp4',
 'dddddddd-dddd-4ddd-8ddd-dddddddddddd/render.mp4','reel','agency_owned');
insert into storage.objects(id,bucket_id,name,version)
values ('11111111-1111-4111-8111-111111111111','client-media',
 'dddddddd-dddd-4ddd-8ddd-dddddddddddd/render.mp4','v1');
select set_config('request.jwt.claim.role','service_role',true);
do $attest$
declare i jsonb;
begin
 i:=public.creative_storage_identity_v6('ffffffff-ffff-4fff-8fff-ffffffffffff');
 perform public.attest_creative_storage_bytes_v6('ffffffff-ffff-4fff-8fff-ffffffffffff',
  i->>'storage_path',repeat('a',64),12,(i->>'object_id')::uuid,
  i->>'object_version',(i->>'object_updated_at')::timestamptz);
end $attest$;
select set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true);
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claims',
 '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal1"}',true);
do $checks$
declare asset_id uuid:='ffffffff-ffff-4fff-8fff-ffffffffffff';
 owner_request uuid; manager_request uuid; client_request uuid; review_id uuid;
begin
 begin
  perform public.sign_video_approval(asset_id,'owner');
  raise exception 'Direct owner signoff succeeded';
 exception when insufficient_privilege then null; end;
 owner_request:=public.request_video_seat_review_v6(asset_id,'owner');
 select id into review_id from public.video_seat_review_requests_v6
  where canonical_request_id=owner_request;
 if owner_request is null or public.request_video_seat_review_v6(asset_id,'owner')<>owner_request
  or (select status from public.approval_inbox_v6 where id=owner_request)<>'pending' then
  raise exception 'Owner request was not pending and deduplicated'; end if;
 begin
  perform public.decide_video_seat_inbox_v6(review_id,owner_request,true);
  raise exception 'AAL1 signed rendered video';
 exception when insufficient_privilege then null; end;
 update public.client_media_assets set title='Edited cut' where id=asset_id;
 update public.client_media_assets set title='Exact cut' where id=asset_id;
 if public.video_seat_review_source_state_v6(owner_request)<>'superseded' then
  raise exception 'Reverted title revived old review'; end if;
 perform set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal2"}',true);
 begin
  perform public.decide_video_seat_inbox_v6(review_id,owner_request,true);
  raise exception 'Stale owner request was approved';
 exception when check_violation then null; end;
 owner_request:=public.request_video_seat_review_v6(asset_id,'owner');
 select id into review_id from public.video_seat_review_requests_v6
  where canonical_request_id=owner_request;
 perform public.decide_video_seat_inbox_v6(review_id,owner_request,true);
 if not public.video_signoff_current_v6(asset_id,'owner') then
  raise exception 'Exact owner signoff was not current'; end if;
 begin
  perform public.review_media_asset(asset_id,'approved'::public.review_status);
  raise exception 'Video finalized without SMM';
 exception when raise_exception then
  if sqlerrm='Video finalized without SMM' then raise; end if;
 end;
 perform set_config('request.jwt.claim.sub','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',true);
 perform set_config('request.jwt.claims',
  '{"sub":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb","role":"authenticated","aal":"aal2"}',true);
 manager_request:=public.request_video_seat_review_v6(asset_id,'manager');
 update public.client_assignments set ended_at=now()
  where member_id='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
 update public.client_assignments set ended_at=null
  where member_id='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
 if public.video_seat_review_source_state_v6(manager_request)<>'superseded' then
  raise exception 'Restored SMM assignment revived old video review'; end if;
 manager_request:=public.request_video_seat_review_v6(asset_id,'manager');
 select id into review_id from public.video_seat_review_requests_v6
  where canonical_request_id=manager_request;
 perform public.decide_video_seat_inbox_v6(review_id,manager_request,true);
 if not public.video_signoff_current_v6(asset_id,'manager') then
  raise exception 'Exact SMM signoff was not current'; end if;
 perform public.request_video_client_approval(asset_id,'cccccccc-cccc-4ccc-8ccc-cccccccccccc');
 begin
  perform public.review_media_asset(asset_id,'approved'::public.review_status);
  raise exception 'Video finalized before requested client signoff';
 exception when raise_exception then
  if sqlerrm='Video finalized before requested client signoff' then raise; end if;
 end;
 perform set_config('request.jwt.claim.sub','cccccccc-cccc-4ccc-8ccc-cccccccccccc',true);
 perform set_config('request.jwt.claims',
  '{"sub":"cccccccc-cccc-4ccc-8ccc-cccccccccccc","role":"authenticated","aal":"aal2"}',true);
 client_request:=public.request_video_seat_review_v6(asset_id,'client');
 delete from public.client_users where client_id='dddddddd-dddd-4ddd-8ddd-dddddddddddd'
  and user_id='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
 insert into public.client_users(client_id,user_id) values
  ('dddddddd-dddd-4ddd-8ddd-dddddddddddd','cccccccc-cccc-4ccc-8ccc-cccccccccccc');
 if public.video_seat_review_source_state_v6(client_request)<>'superseded' then
  raise exception 'Restored client membership revived old video review'; end if;
 client_request:=public.request_video_seat_review_v6(asset_id,'client');
 select id into review_id from public.video_seat_review_requests_v6
  where canonical_request_id=client_request;
 perform public.decide_video_seat_inbox_v6(review_id,client_request,true);
 if not public.video_signoff_current_v6(asset_id,'client') then
  raise exception 'Exact client signoff was not current'; end if;
 perform set_config('request.jwt.claim.sub','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',true);
 perform set_config('request.jwt.claims',
  '{"sub":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb","role":"authenticated","aal":"aal2"}',true);
 perform public.review_media_asset(asset_id,'approved'::public.review_status);
 if (select human_approved_at from public.client_media_assets where id=asset_id) is null
  or not public.video_signoff_current_v6(asset_id,'client') then
  raise exception 'All exact seats did not permit finalization'; end if;
 perform set_config('request.jwt.claim.role','service_role',true);
 update storage.objects set version='v2' where id='11111111-1111-4111-8111-111111111111';
 if public.video_signoff_current_v6(asset_id,'owner') then
  raise exception 'Changed render object retained owner approval'; end if;
end $checks$;
rollback;

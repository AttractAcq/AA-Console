-- Rollback-only exact rendered-video owner, SMM and client seat fixture.
begin;
-- Seed and mutate legacy seats for video-review invalidation; the separate
-- authority-assignment fixture tests the direct-write guard.
alter table public.client_assignments disable trigger client_authority_assignment_guard_v6;
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
-- This fixture exercises video seats, not owner governance. Seed its prior
-- owner as legacy state; the separate owner fixture tests the new guard.
alter table public.content_approval_settings disable trigger global_video_owner_guard_v6;
insert into public.content_approval_settings(singleton,owner_user_id)
values (true,'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
alter table public.content_approval_settings enable trigger global_video_owner_guard_v6;
insert into public.client_media_assets(id,client_id,media_type,title,storage_path,
 render_path,content_format,usage_rights)
values ('ffffffff-ffff-4fff-8fff-ffffffffffff','dddddddd-dddd-4ddd-8ddd-dddddddddddd',
 'video','Exact cut','dddddddd-dddd-4ddd-8ddd-dddddddddddd/source.mp4',
 'dddddddd-dddd-4ddd-8ddd-dddddddddddd/render.mp4','reel','agency_owned');
insert into storage.objects(id,bucket_id,name,version)
values ('11111111-1111-4111-8111-111111111111','client-media',
 'dddddddd-dddd-4ddd-8ddd-dddddddddddd/render.mp4','v1');
insert into public.post_copy(asset_id,platform,caption) values
 ('ffffffff-ffff-4fff-8fff-ffffffffffff','instagram','Finished reel');
set local session_replication_role='replica';
insert into public.client_integrations
 (client_id,provider,credential_label,credential_secret_id,status)
values ('dddddddd-dddd-4ddd-8ddd-dddddddddddd','instagram','17890000000000001',
 vault.create_secret('disposable-video-fixture-token'),'connected');
set local session_replication_role='origin';
insert into public.content_slots
 (id,client_id,platform,scheduled_at,stage,asset_id,format)
values ('22222222-2222-4222-8222-222222222222',
 'dddddddd-dddd-4ddd-8ddd-dddddddddddd','instagram',now()+interval '2 days',
 'awaiting_approval','ffffffff-ffff-4fff-8fff-ffffffffffff','reel');
insert into public.client_ideas(id,client_id,title,source,status,slot_id)
values ('33333333-3333-4333-8333-333333333333',
 'dddddddd-dddd-4ddd-8ddd-dddddddddddd','Recurring reel','auto','draft',
 '22222222-2222-4222-8222-222222222222');
insert into public.client_briefs(id,client_id,source_idea_id,title)
values ('44444444-4444-4444-8444-444444444444',
 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
 '33333333-3333-4333-8333-333333333333','Recurring reel brief');
update public.client_media_assets set brief_id='44444444-4444-4444-8444-444444444444'
 where id='ffffffff-ffff-4fff-8fff-ffffffffffff';
update public.content_slots set
 idea_id='33333333-3333-4333-8333-333333333333',
 brief_id='44444444-4444-4444-8444-444444444444'
 where id='22222222-2222-4222-8222-222222222222';
insert into public.slot_events(slot_id,from_stage,to_stage,actor)
values ('22222222-2222-4222-8222-222222222222','qa','awaiting_approval','engine');
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
 engine_request uuid; post_id uuid; packet jsonb;
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
 -- The Engine decision is the final human approval for this recurring reel.
  perform set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true);
  perform set_config('request.jwt.claims',
   '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal2"}',true);
  packet:=public.engine_slot_exact_package_v6('22222222-2222-4222-8222-222222222222');
  if packet is null or packet->'video_seats'->>'client_user_id'
     is distinct from 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    or jsonb_array_length(packet->'video_seats'->'signoffs')<>3
    or packet->'asset'->>'render_path'
      is distinct from 'dddddddd-dddd-4ddd-8ddd-dddddddddddd/render.mp4' then
    raise exception 'Engine reel packet lost exact render or video seats'; end if;
  engine_request:=public.request_engine_slot_exact_review_v6(
    '22222222-2222-4222-8222-222222222222');
  perform public.decide_engine_slot_inbox_v6(
    '22222222-2222-4222-8222-222222222222',engine_request,true);
  if (select human_approved_at from public.client_media_assets where id=asset_id) is null
    or public.video_signoff_current_v6(asset_id,'client') is not true then
    raise exception 'Engine reel did not finalize with all exact video seats'; end if;
  select scheduled_post_id into post_id from public.content_slots
    where id='22222222-2222-4222-8222-222222222222';
  if post_id is null or public.engine_slot_exact_source_current_v8(post_id) is not true
    or public.organic_creative_source_current_v8(post_id) is not true
    or public.organic_publication_source_snapshot_v6(post_id) is null
    or public.organic_publication_claim_snapshot_v7(post_id) is null then
    raise exception 'Approved Engine reel has no current publication source'; end if;
  begin
    update public.client_assignments set ended_at=now()
      where member_id='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    if public.engine_slot_exact_source_current_v8(post_id) is true
      or public.organic_publication_source_snapshot_v6(post_id) is not null
      or public.organic_publication_claim_snapshot_v7(post_id) is not null then
      raise exception 'Changed video manager retained Engine publication authority'; end if;
    raise exception 'rollback temporary manager change';
  exception when raise_exception then
    if sqlerrm<>'rollback temporary manager change' then raise; end if;
  end;
  if public.engine_slot_exact_source_current_v8(post_id) is not true then
    raise exception 'Restored video manager did not restore exact Engine source'; end if;
  update storage.objects set version='v2'
    where id='11111111-1111-4111-8111-111111111111';
  if public.engine_slot_exact_source_current_v8(post_id) is true
    or public.organic_publication_source_snapshot_v6(post_id) is not null
    or public.organic_publication_claim_snapshot_v7(post_id) is not null
    or public.video_signoff_current_v6(asset_id,'owner') is true then
    raise exception 'Changed reel render retained Engine publication authority'; end if;
end $checks$;
rollback;

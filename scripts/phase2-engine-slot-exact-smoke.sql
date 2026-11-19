-- Rollback-only exact Engine slot decision and schedule fixture.
begin;
insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','00000000-0000-0000-0000-000000000000',
  'authenticated','authenticated','exact-engine-admin@example.invalid','',now(),now());
insert into public.profiles(id,role,email) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','admin','exact-engine-admin@example.invalid');
insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
values ('ffffffff-ffff-4fff-8fff-ffffffffffff','00000000-0000-0000-0000-000000000000',
  'authenticated','authenticated','other-engine-client@example.invalid','',now(),now());
insert into public.profiles(id,role,email) values
  ('ffffffff-ffff-4fff-8fff-ffffffffffff','client','other-engine-client@example.invalid');
insert into public.clients(id,name,initials) values
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Exact Engine fixture','EE');
insert into public.clients(id,name,initials) values
  ('99999999-9999-4999-8999-999999999999','Other Engine fixture','OE');
insert into public.client_users(client_id,user_id) values
  ('99999999-9999-4999-8999-999999999999','ffffffff-ffff-4fff-8fff-ffffffffffff');
insert into public.client_media_assets
  (id,client_id,media_type,content_format,title,storage_path,usage_rights)
values ('cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','image','single','Engine image',
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/engine.png','agency_owned');
insert into public.client_media_assets
  (id,client_id,media_type,content_format,title,storage_path,render_path,usage_rights)
values ('cccccccc-cccc-4ccc-8ccc-cccccccccccd',
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','image','single','Finished Engine image',
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/source.png',
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/finished.png','agency_owned');
insert into storage.objects(id,bucket_id,name,version) values
  ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee','client-media',
   'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/engine.png','v1'),
  ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeed','client-media',
   'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/source.png','v1'),
  ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeef','client-media',
   'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/finished.png','v1');
insert into public.post_copy(asset_id,platform,caption) values
  ('cccccccc-cccc-4ccc-8ccc-cccccccccccc','instagram','Exact caption'),
  ('cccccccc-cccc-4ccc-8ccc-cccccccccccd','instagram','Finished render caption');
insert into public.client_integrations(client_id,provider,credential_label,status)
values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','instagram','17890000000000000','connected');
insert into public.content_slots
  (id,client_id,platform,scheduled_at,stage,asset_id)
values ('dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','instagram',now()+interval '2 days',
  'awaiting_approval','cccccccc-cccc-4ccc-8ccc-cccccccccccc');
insert into public.content_slots
  (id,client_id,platform,scheduled_at,stage,asset_id)
values ('dddddddd-dddd-4ddd-8ddd-ddddddddddde',
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','instagram',now()+interval '3 days',
  'awaiting_approval','cccccccc-cccc-4ccc-8ccc-cccccccccccd');
insert into public.slot_events(slot_id,from_stage,to_stage,actor)
values ('dddddddd-dddd-4ddd-8ddd-dddddddddddd','qa','awaiting_approval','engine'),
  ('dddddddd-dddd-4ddd-8ddd-ddddddddddde','qa','awaiting_approval','engine');
select set_config('request.jwt.claim.role','service_role',true);
select public.attest_creative_storage_bytes_v6(
  'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/engine.png',repeat('a',64),19,
  'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee','v1',
  (select updated_at from storage.objects where id='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'));
select public.attest_creative_storage_bytes_v6(
  'cccccccc-cccc-4ccc-8ccc-cccccccccccd',
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/finished.png',repeat('b',64),21,
  'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeef','v1',
  (select updated_at from storage.objects where id='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeef'));
select set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true);
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal1"}',true);
do $checks$
declare v_request uuid;
  v_render_request uuid;
  v_render_preview jsonb;
begin
  begin
    update public.client_media_assets set usage_rights=null
      where id='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    begin
      perform public.request_engine_slot_exact_review_v6(
        'dddddddd-dddd-4ddd-8ddd-dddddddddddd');
      raise exception 'Missing creative rights produced a reviewable Engine card';
    exception when check_violation then null; end;
    raise exception 'rollback temporary missing rights';
  exception when raise_exception then
    if SQLERRM<>'rollback temporary missing rights' then raise; end if;
  end;
  v_request:=public.request_engine_slot_exact_review_v6(
    'dddddddd-dddd-4ddd-8ddd-dddddddddddd');
  if v_request is null or public.engine_slot_exact_source_state_v6(v_request)<>'pending'
    or (select preview_blocker from public.approval_inbox_v6 where id=v_request) is not null
    or (select account_ref from public.approval_inbox_v6 where id=v_request)
      <>'17890000000000000' then
    raise exception 'The exact Engine package was not decision-ready';
  end if;
  if public.request_engine_slot_exact_review_v6(
    'dddddddd-dddd-4ddd-8ddd-dddddddddddd')<>v_request then
    raise exception 'Repeated Engine evidence preparation was not idempotent'; end if;
  begin
    perform public.decide_engine_slot_inbox_v6(
      'dddddddd-dddd-4ddd-8ddd-dddddddddddd',v_request,true);
    raise exception 'AAL1 approved Engine slot';
  exception when insufficient_privilege then null; end;
  perform set_config('request.jwt.claims',
    '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal2"}',true);
  perform set_config('request.jwt.claim.sub','ffffffff-ffff-4fff-8fff-ffffffffffff',true);
  perform set_config('request.jwt.claims',
    '{"sub":"ffffffff-ffff-4fff-8fff-ffffffffffff","role":"authenticated","aal":"aal2"}',true);
  begin
    perform public.decide_engine_slot_inbox_v6(
      'dddddddd-dddd-4ddd-8ddd-dddddddddddd',v_request,true);
    raise exception 'Another client approved the Engine slot';
  exception when insufficient_privilege then null; end;
  perform set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true);
  perform set_config('request.jwt.claims',
    '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal2"}',true);
  begin
    perform public.review_media_asset(
      'cccccccc-cccc-4ccc-8ccc-cccccccccccc','approved'::public.review_status);
    raise exception 'Direct Engine asset signoff bypassed the Inbox';
  exception when insufficient_privilege then null; end;
  begin
    perform public.approve_slot('dddddddd-dddd-4ddd-8ddd-dddddddddddd');
    raise exception 'Direct Engine approval bypassed the Inbox';
  exception when insufficient_privilege then
    if SQLERRM not like '%Approve this exact Engine asset%' then raise; end if;
  end;
  begin
    update public.post_copy set caption='Changed caption'
      where asset_id='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    if public.engine_slot_exact_source_state_v6(v_request)<>'superseded' then
      raise exception 'Changed copy left the Engine review current'; end if;
    begin
      perform public.decide_engine_slot_inbox_v6(
        'dddddddd-dddd-4ddd-8ddd-dddddddddddd',v_request,true);
      raise exception 'Changed copy was approved';
    exception when check_violation then null; end;
    raise exception 'rollback temporary copy change';
  exception when raise_exception then
    if SQLERRM<>'rollback temporary copy change' then raise; end if;
  end;
  begin
    update storage.objects set version='v2'
      where id='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    if public.engine_slot_exact_source_state_v6(v_request)<>'superseded' then
      raise exception 'Changed Storage bytes left the Engine review current'; end if;
    raise exception 'rollback temporary Storage change';
  exception when raise_exception then
    if SQLERRM<>'rollback temporary Storage change' then raise; end if;
  end;
  perform public.decide_engine_slot_inbox_v6(
    'dddddddd-dddd-4ddd-8ddd-dddddddddddd',v_request,true);
  if (select stage::text from public.content_slots
    where id='dddddddd-dddd-4ddd-8ddd-dddddddddddd')<>'scheduled'
    or (select status from public.approval_inbox_v6 where id=v_request)<>'approved'
    or (select human_approved_at from public.client_media_assets
      where id='cccccccc-cccc-4ccc-8ccc-cccccccccccc') is null
    or not exists(select 1 from public.content_slots s
      join public.scheduled_posts p on p.id=s.scheduled_post_id
      where s.id='dddddddd-dddd-4ddd-8ddd-dddddddddddd'
        and p.client_id=s.client_id and p.asset_id=s.asset_id)
    then raise exception 'Exact Engine decision did not atomically schedule'; end if;
  if public.engine_slot_exact_source_state_v6(v_request)<>'source_decided'
    or public.ordinary_media_signoff_current_v6(
      'cccccccc-cccc-4ccc-8ccc-cccccccccccc') then
    raise exception 'Engine approval was not distinct from ordinary-media approval'; end if;
  if public.organic_creative_source_current_v8(
      (select scheduled_post_id from public.content_slots
        where id='dddddddd-dddd-4ddd-8ddd-dddddddddddd')) is not true then
    raise exception 'Current exact Engine source decision did not authorize its linked post'; end if;
  if (select current_signoff from public.ordinary_media_current_status_v6
      where asset_id='cccccccc-cccc-4ccc-8ccc-cccccccccccc') is not true then
    raise exception 'Assets status hid current exact Engine source approval'; end if;
  perform set_config('request.jwt.claim.sub','ffffffff-ffff-4fff-8fff-ffffffffffff',true);
  perform set_config('request.jwt.claims',
    '{"sub":"ffffffff-ffff-4fff-8fff-ffffffffffff","role":"authenticated","aal":"aal2"}',true);
  if public.organic_creative_source_current_v8(
      (select scheduled_post_id from public.content_slots
        where id='dddddddd-dddd-4ddd-8ddd-dddddddddddd')) is true then
    raise exception 'Another client read Engine source authority'; end if;
  perform set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true);
  perform set_config('request.jwt.claims',
    '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal2"}',true);
  v_render_request:=public.request_engine_slot_exact_review_v6(
    'dddddddd-dddd-4ddd-8ddd-ddddddddddde');
  select e.preview->'exact_package' into v_render_preview
    from public.approval_request_evidence_v6 e where e.request_id=v_render_request;
  if v_render_preview#>>'{asset,render_path}'<>
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/finished.png'
    or v_render_preview#>>'{asset,file_sha256}'<>repeat('b',64)
    or v_render_preview#>>'{storage,object_id}'<>
      'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeef'
    or public.engine_slot_exact_source_state_v6(v_render_request)<>'pending' then
    raise exception 'Engine render packet did not bind the finished file'; end if;
  perform public.decide_engine_slot_inbox_v6(
    'dddddddd-dddd-4ddd-8ddd-ddddddddddde',v_render_request,true);
  if public.organic_creative_source_current_v8(
      (select scheduled_post_id from public.content_slots
        where id='dddddddd-dddd-4ddd-8ddd-ddddddddddde')) is not true then
    raise exception 'Finished Engine render did not gain source authority'; end if;
  update storage.objects set version='v2'
    where id='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeef';
  if public.organic_creative_source_current_v8(
      (select scheduled_post_id from public.content_slots
        where id='dddddddd-dddd-4ddd-8ddd-ddddddddddde')) is true then
    raise exception 'Changed Engine render retained source authority'; end if;
  update storage.objects set version='v2'
    where id='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  if public.engine_slot_exact_source_state_v6(v_request)<>'superseded'
    or (select status from public.approval_inbox_v6 where id=v_request)<>'superseded' then
    raise exception 'Changed media bytes left a scheduled Engine approval current';
  end if;
  if public.organic_creative_source_current_v8(
      (select scheduled_post_id from public.content_slots
        where id='dddddddd-dddd-4ddd-8ddd-dddddddddddd')) is true then
    raise exception 'Changed Engine media left organic source authority current'; end if;
  if (select current_signoff from public.ordinary_media_current_status_v6
      where asset_id='cccccccc-cccc-4ccc-8ccc-cccccccccccc') is true then
    raise exception 'Assets status kept stale Engine source approved'; end if;
end $checks$;
rollback;

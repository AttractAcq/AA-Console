-- Rollback-only review of an exact two-frame carousel and a stale second frame.
begin;
insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
values ('a1200000-0000-4000-8000-000000000001','00000000-0000-0000-0000-000000000000',
  'authenticated','authenticated','framed-admin@example.invalid','',now(),now()),
  ('a1200000-0000-4000-8000-000000000002','00000000-0000-0000-0000-000000000000',
  'authenticated','authenticated','framed-client@example.invalid','',now(),now());
insert into public.profiles(id,role,email) values
  ('a1200000-0000-4000-8000-000000000001','admin','framed-admin@example.invalid'),
  ('a1200000-0000-4000-8000-000000000002','client','framed-client@example.invalid');
insert into public.clients(id,name,initials) values
  ('b1200000-0000-4000-8000-000000000001','Framed review fixture','FR');
insert into public.client_users(client_id,user_id) values
  ('b1200000-0000-4000-8000-000000000001','a1200000-0000-4000-8000-000000000002');
insert into public.client_media_assets
  (id,client_id,media_type,content_format,title,storage_path,usage_rights)
values ('c1200000-0000-4000-8000-000000000001',
  'b1200000-0000-4000-8000-000000000001','image','carousel','Two-frame offer',
  'framed-review/one.png','agency_owned');
insert into public.client_media_frames(id,asset_id,position,storage_path,caption) values
  ('f1200000-0000-4000-8000-000000000001','c1200000-0000-4000-8000-000000000001',1,'framed-review/one.png','Open'),
  ('f1200000-0000-4000-8000-000000000002','c1200000-0000-4000-8000-000000000001',2,'framed-review/two.png','Close');
insert into storage.objects(id,bucket_id,name,version) values
  ('d1200000-0000-4000-8000-000000000001','client-media','framed-review/one.png','v1'),
  ('d1200000-0000-4000-8000-000000000002','client-media','framed-review/two.png','v1');

select set_config('request.jwt.claim.role','service_role',true);
select public.attest_creative_storage_bytes_v6(
  'c1200000-0000-4000-8000-000000000001','framed-review/one.png',repeat('a',64),12,
  'd1200000-0000-4000-8000-000000000001','v1',
  (select updated_at from storage.objects where name='framed-review/one.png'));
select public.attest_creative_frame_bytes_v8(
  'c1200000-0000-4000-8000-000000000001','f1200000-0000-4000-8000-000000000001',
  'framed-review/one.png',repeat('a',64),12,
  'd1200000-0000-4000-8000-000000000001','v1',
  (select updated_at from storage.objects where name='framed-review/one.png'));
select public.attest_creative_frame_bytes_v8(
  'c1200000-0000-4000-8000-000000000001','f1200000-0000-4000-8000-000000000002',
  'framed-review/two.png',repeat('b',64),15,
  'd1200000-0000-4000-8000-000000000002','v1',
  (select updated_at from storage.objects where name='framed-review/two.png'));
select set_config('request.jwt.claim.sub','a1200000-0000-4000-8000-000000000001',true);
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claims',
  '{"sub":"a1200000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal2"}',true);

do $check$
declare aid uuid:='c1200000-0000-4000-8000-000000000001';
  request_id uuid; review_id uuid; v_preview jsonb;
begin
  if not public.framed_creative_evidence_current_v8(aid) then
    raise exception 'Both frames should have current byte evidence'; end if;
  begin
    perform public.review_media_asset(aid,'approved'::public.review_status);
    raise exception 'Direct carousel signoff bypassed Inbox';
  exception when insufficient_privilege then null; end;
  request_id:=public.request_ordinary_media_review_v6(aid);
  select id into review_id from public.ordinary_media_review_requests_v6
    where canonical_request_id=request_id;
  select r.preview into v_preview from public.approval_requests_v6 r where r.id=request_id;
  if jsonb_array_length(v_preview->'frames')<>2
    or v_preview#>>'{frames,0,file_sha256}'<>repeat('a',64)
    or v_preview#>>'{frames,1,file_sha256}'<>repeat('b',64)
    or v_preview#>>'{frames,1,caption}'<>'Close'
    or public.ordinary_media_review_source_state_v6(request_id)<>'pending' then
    raise exception 'Inbox packet lost ordered frame bytes or caption'; end if;
  perform public.approve_ordinary_media_inbox_v6(review_id,request_id);
  if not public.ordinary_media_signoff_current_v6(aid) then
    raise exception 'Exact framed signoff did not become current'; end if;
  update storage.objects set version='v2' where name='framed-review/two.png';
  if public.ordinary_media_signoff_current_v6(aid)
    or public.ordinary_media_review_source_state_v6(request_id)='source_decided' then
    raise exception 'Replacing second frame left approval current'; end if;
  begin
    perform public.schedule_asset(aid,current_date+1);
    raise exception 'Stale framed creative scheduled';
  exception when SQLSTATE 'P0001' then
    if SQLERRM not like '%exact creative signoff is missing or stale%' then raise; end if;
  end;
  perform set_config('request.jwt.claim.role','service_role',true);
  perform public.attest_creative_frame_bytes_v8(
    aid,'f1200000-0000-4000-8000-000000000002','framed-review/two.png',
    repeat('c',64),16,'d1200000-0000-4000-8000-000000000002','v2',
    (select updated_at from storage.objects where name='framed-review/two.png'));
  perform set_config('request.jwt.claim.role','authenticated',true);
  request_id:=public.request_ordinary_media_review_v6(aid);
  select id into review_id from public.ordinary_media_review_requests_v6
    where canonical_request_id=request_id;
  if (select count(*) from public.ordinary_media_signoffs_v6 where asset_id=aid)<>1
    or public.ordinary_media_review_source_state_v6(request_id)<>'pending' then
    raise exception 'New frame bytes did not require a second decision'; end if;
  perform public.approve_ordinary_media_inbox_v6(review_id,request_id);
  if not public.ordinary_media_signoff_current_v6(aid)
    or (select count(*) from public.ordinary_media_signoffs_v6 where asset_id=aid)<>2 then
    raise exception 'Second frame decision did not preserve first signoff'; end if;
end $check$;
rollback;

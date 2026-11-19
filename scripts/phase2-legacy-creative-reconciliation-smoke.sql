-- Rollback-only historical approval without an exact Inbox signoff.
begin;
insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
values ('a1300000-0000-4000-8000-000000000001','00000000-0000-0000-0000-000000000000',
  'authenticated','authenticated','legacy-creative-admin@example.invalid','',now(),now());
insert into public.profiles(id,role,email) values
  ('a1300000-0000-4000-8000-000000000001','admin','legacy-creative-admin@example.invalid');
insert into public.clients(id,name,initials) values
  ('b1300000-0000-4000-8000-000000000001','Legacy creative fixture','LC');
insert into public.client_media_assets
  (id,client_id,media_type,content_format,title,storage_path,usage_rights,
   review_status,human_approved_at)
values ('c1300000-0000-4000-8000-000000000001',
  'b1300000-0000-4000-8000-000000000001','image','single','Legacy image',
  'legacy-creative/one.png','agency_owned','approved',now()-interval '1 day');
insert into storage.objects(id,bucket_id,name,version) values
  ('d1300000-0000-4000-8000-000000000001','client-media','legacy-creative/one.png','v1');
select set_config('request.jwt.claim.role','service_role',true);
select public.attest_creative_storage_bytes_v6(
  'c1300000-0000-4000-8000-000000000001','legacy-creative/one.png',repeat('a',64),12,
  'd1300000-0000-4000-8000-000000000001','v1',
  (select updated_at from storage.objects where name='legacy-creative/one.png'));
select set_config('request.jwt.claim.sub','a1300000-0000-4000-8000-000000000001',true);
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claims',
  '{"sub":"a1300000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal2"}',true);

do $checks$
declare aid uuid:='c1300000-0000-4000-8000-000000000001';
  request_id uuid; review_id uuid; legacy_at timestamptz;
begin
  select human_approved_at into legacy_at from public.client_media_assets where id=aid;
  if public.ordinary_media_signoff_current_v6(aid) then
    raise exception 'Legacy timestamp was treated as current source authority'; end if;
  request_id:=public.request_ordinary_media_review_v6(aid);
  select id into review_id from public.ordinary_media_review_requests_v6
    where canonical_request_id=request_id;
  if review_id is null or public.request_ordinary_media_review_v6(aid)<>request_id
    or (select count(*) from public.ordinary_media_reopen_events_v8
      where asset_id=aid and prior_request_id is null
        and legacy_approved_at=legacy_at)<>1
    or (select human_approved_at from public.client_media_assets where id=aid) is not null
    or (select review_status from public.client_media_assets where id=aid)<>'pending'
    or public.ordinary_media_review_source_state_v6(request_id)<>'pending' then
    raise exception 'Legacy approval was not safely reopened for exact review'; end if;
  perform public.approve_ordinary_media_inbox_v6(review_id,request_id);
  if not public.ordinary_media_signoff_current_v6(aid)
    or (select count(*) from public.ordinary_media_signoffs_v6 where asset_id=aid)<>1 then
    raise exception 'Legacy creative did not receive a new exact signoff'; end if;
end $checks$;
rollback;

-- Rollback-only exact single-file creative approval fixture.
begin;
insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','00000000-0000-0000-0000-000000000000',
  'authenticated','authenticated','creative-admin@example.invalid','',now(),now());
insert into public.profiles(id,role,email) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','admin','creative-admin@example.invalid');
insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
values ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee','00000000-0000-0000-0000-000000000000',
  'authenticated','authenticated','creative-client@example.invalid','',now(),now());
insert into public.profiles(id,role,email) values
  ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee','client','creative-client@example.invalid');
insert into public.clients(id,name,initials) values
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Creative Inbox fixture','CI');
insert into public.client_users(client_id,user_id) values
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee');
insert into public.client_media_assets
  (id,client_id,media_type,content_format,title,storage_path,usage_rights)
values ('cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','image','single','Client image',
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/creative.png','agency_owned');
insert into storage.objects(id,bucket_id,name,version) values
  ('dddddddd-dddd-4ddd-8ddd-dddddddddddd','client-media',
   'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/creative.png','v1');
select set_config('request.jwt.claim.role','service_role',true);
select public.attest_creative_storage_bytes_v6(
  'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/creative.png',repeat('a',64),14,
  'dddddddd-dddd-4ddd-8ddd-dddddddddddd','v1',
  (select updated_at from storage.objects where id='dddddddd-dddd-4ddd-8ddd-dddddddddddd'));
select set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true);
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal1"}',true);

do $checks$
declare request_id uuid;
  review_id uuid;
  v_asset_id uuid := 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
begin
  begin
    perform public.review_media_asset(v_asset_id,'approved'::public.review_status);
    raise exception 'Direct human creative approval succeeded';
  exception when insufficient_privilege then null; end;
  perform set_config('request.jwt.claim.sub','eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',true);
  perform set_config('request.jwt.claims',
    '{"sub":"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee","role":"authenticated","aal":"aal1"}',true);
  request_id := public.request_ordinary_media_review_v6(v_asset_id);
  perform set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true);
  perform set_config('request.jwt.claims',
    '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal1"}',true);
  select id into review_id from public.ordinary_media_review_requests_v6
    where canonical_request_id=request_id;
  if review_id is null or public.request_ordinary_media_review_v6(v_asset_id)<>request_id
    or public.ordinary_media_review_source_state_v6(request_id)<>'pending'
    or public.ordinary_media_signoff_current_v6(v_asset_id)
    or (select status from public.approval_inbox_v6 where id=request_id)<>'pending'
    then raise exception 'Exact creative request did not become pending and deduplicated'; end if;
  begin
    perform public.approve_ordinary_media_inbox_v6(review_id,request_id);
    raise exception 'AAL1 approved creative';
  exception when insufficient_privilege then null; end;
  perform set_config('request.jwt.claim.sub','eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',true);
  perform set_config('request.jwt.claims',
    '{"sub":"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee","role":"authenticated","aal":"aal2"}',true);
  begin
    perform public.approve_ordinary_media_inbox_v6(review_id,request_id);
    raise exception 'Client requester took manager decision';
  exception when insufficient_privilege then null; end;
  perform set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true);
  perform set_config('request.jwt.claims',
    '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal2"}',true);
  perform public.approve_ordinary_media_inbox_v6(review_id,request_id);
  if public.ordinary_media_review_source_state_v6(request_id)<>'source_decided'
    or not public.ordinary_media_signoff_current_v6(v_asset_id)
    or (select status from public.approval_inbox_v6 where id=request_id)<>'approved'
    or not exists(select 1 from public.client_media_assets a
      join public.ordinary_media_signoffs_v6 s on s.asset_id=a.id
      where a.id=v_asset_id and a.human_approved_at is not null
        and s.approved_request_id=request_id) then
    raise exception 'Exact Inbox decision did not sign off the creative'; end if;
  begin
    perform public.schedule_asset(v_asset_id,current_date+1);
    raise exception 'Fixture asset scheduled without campaign lineage';
  exception when SQLSTATE 'P0001' then
    if SQLERRM not like '%no verified organic campaign brief%' then raise; end if;
  end;
  update storage.objects set version='v2'
    where id='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  if public.ordinary_media_review_source_state_v6(request_id)='source_decided'
    or public.ordinary_media_signoff_current_v6(v_asset_id)
    or (select status from public.approval_inbox_v6 where id=request_id)='approved'
    then raise exception 'Storage replacement left creative approval current'; end if;
  begin
    perform public.schedule_asset(v_asset_id,current_date+1);
    raise exception 'Stale creative scheduled';
  exception when SQLSTATE 'P0001' then
    if SQLERRM not like '%exact creative signoff is missing or stale%' then raise; end if;
  end;
end $checks$;
rollback;

-- Rollback-only recruitment media lineage and stale-byte fixture.
begin;
insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','00000000-0000-0000-0000-000000000000',
  'authenticated','authenticated','recruitment-admin@example.invalid','',now(),now());
insert into public.profiles(id,role,email) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','admin','recruitment-admin@example.invalid');
update public.clients set name='Fixture prior house row'
  where is_internal and lower(name)='attract acquisition';
insert into public.clients(id,name,initials,is_internal) values
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Attract Acquisition','AA',true);
select set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true);
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal2"}',true);
insert into public.client_briefs
  (id,client_id,title,media_type,purpose,recruitment_role,apply_url,
   hook,script,call_to_action)
values ('cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Editor recruitment','image',
  'recruitment','editor','https://example.invalid/apply',
  'Join the team','Work on client campaigns','APPLY_NOW');
do $brief$
declare r public.approval_requests_v6%rowtype;
begin
  select * into r from public.approval_requests_v6
    where source_kind='recruitment_brief'
      and source_id='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  if r.id is null then raise exception 'Recruitment brief card missing'; end if;
  perform public.approve_recruitment_brief_from_inbox_v6(
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc',r.id,
    r.source_version,r.artifact_hash);
  if not public.recruitment_brief_signoff_current_v6(
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc') then
    raise exception 'Exact recruitment brief signoff was not current'; end if;
end $brief$;
insert into public.client_media_assets
  (id,client_id,brief_id,media_type,content_format,title,storage_path,usage_rights)
values ('dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  'cccccccc-cccc-4ccc-8ccc-cccccccccccc','image','single','Editor image',
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/recruitment.png','agency_owned');
insert into storage.objects(id,bucket_id,name,version) values
  ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee','client-media',
   'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/recruitment.png','v1');
select set_config('request.jwt.claim.role','service_role',true);
select public.attest_creative_storage_bytes_v6(
  'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/recruitment.png',repeat('a',64),17,
  'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee','v1',
  (select updated_at from storage.objects where id='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'));
select set_config('request.jwt.claim.role','authenticated',true);
do $checks$
declare v_media_request uuid;
  v_media_review uuid;
  v_campaign uuid;
  v_build_request uuid;
begin
  if public.recruitment_media_current_v6(
    'dddddddd-dddd-4ddd-8ddd-dddddddddddd')
    or exists(select 1 from public.recruitment_media_ready_v6)
    then raise exception 'Unapproved recruitment image appeared ready'; end if;
  v_media_request:=public.request_ordinary_media_review_v6(
    'dddddddd-dddd-4ddd-8ddd-dddddddddddd');
  select id into v_media_review from public.ordinary_media_review_requests_v6
    where canonical_request_id=v_media_request;
  perform public.approve_ordinary_media_inbox_v6(v_media_review,v_media_request);
  if not public.recruitment_media_current_v6(
    'dddddddd-dddd-4ddd-8ddd-dddddddddddd')
    or not exists(select 1 from public.recruitment_media_ready_v6
      where id='dddddddd-dddd-4ddd-8ddd-dddddddddddd') then
    raise exception 'Exact recruitment image and brief were not eligible'; end if;
  v_campaign:=public.create_recruitment_meta_campaign(
    'Editor hiring',25,array['ZA']::text[],
    array['dddddddd-dddd-4ddd-8ddd-dddddddddddd']::uuid[]);
  if v_campaign is null or not exists(select 1 from public.recruitment_meta_campaign_ads
    where campaign_id=v_campaign and asset_id='dddddddd-dddd-4ddd-8ddd-dddddddddddd')
    then raise exception 'Current recruitment media could not enter a held campaign'; end if;
  select id into v_build_request from public.approval_requests_v6
    where source_kind='recruitment_meta_build' and source_id=v_campaign::text;
  if v_build_request is null or public.recruitment_meta_build_source_state_v6(v_build_request)
    <>'source_held' then raise exception 'Held recruitment build request missing'; end if;
  update storage.objects set version='v2'
    where id='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  if public.recruitment_media_current_v6(
    'dddddddd-dddd-4ddd-8ddd-dddddddddddd')
    or exists(select 1 from public.recruitment_media_ready_v6
      where id='dddddddd-dddd-4ddd-8ddd-dddddddddddd') then
    raise exception 'Replaced recruitment media remained eligible'; end if;
  if public.recruitment_meta_build_source_state_v6(v_build_request)<>'superseded' then
    raise exception 'Held Meta build request kept stale media bytes'; end if;
  begin
    perform public.create_recruitment_meta_campaign(
      'Stale editor hiring',25,array['ZA']::text[],
      array['dddddddd-dddd-4ddd-8ddd-dddddddddddd']::uuid[]);
    raise exception 'Stale recruitment media entered a campaign';
  exception when raise_exception then
    if SQLERRM not like '%current Inbox-cleared%' then raise; end if;
  end;
end $checks$;
rollback;

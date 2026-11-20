-- Rollback-only paid operator packet with an image and exact rendered video.
-- The frozen packet must include every planned piece and final video bytes.
begin;
insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','00000000-0000-0000-0000-000000000000',
  'authenticated','authenticated','paid-operator-fixture@example.invalid','',now(),now());
insert into public.profiles(id,role,email) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','admin','paid-operator-fixture@example.invalid');
insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
values ('99999999-9999-4999-8999-999999999999','00000000-0000-0000-0000-000000000000',
  'authenticated','authenticated','paid-client-fixture@example.invalid','',now(),now());
insert into public.profiles(id,role,email) values
  ('99999999-9999-4999-8999-999999999999','client','paid-client-fixture@example.invalid');
insert into public.clients(id,name,initials) values
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Paid operator fixture','PO');
insert into public.client_users(client_id,user_id) values
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','99999999-9999-4999-8999-999999999999');
insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
values ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee','00000000-0000-0000-0000-000000000000',
  'authenticated','authenticated','paid-video-manager@example.invalid','',now(),now());
insert into public.profiles(id,role,email) values
  ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee','employee','paid-video-manager@example.invalid');
insert into public.team_members(id,user_id,category,name,initials)
values ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee','smm','Paid video manager','PM');
alter table public.client_assignments disable trigger client_authority_assignment_guard_v6;
insert into public.client_assignments(member_id,client_id)
values ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
alter table public.client_assignments enable trigger client_authority_assignment_guard_v6;
alter table public.content_approval_settings disable trigger global_video_owner_guard_v6;
insert into public.content_approval_settings(singleton,owner_user_id)
values (true,'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
on conflict(singleton) do update set owner_user_id=excluded.owner_user_id;
alter table public.content_approval_settings enable trigger global_video_owner_guard_v6;
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true);
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal2"}',true);
do $source$
declare oid uuid; main_offer uuid; approval_id uuid;
begin
  insert into public.market_opportunities(client_id,name,micro_market,buying_situation,
    core_problem,desired_outcome,idempotency_key,confidence)
  values('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Paid local buyers',
    'Local service buyers','Need service this month','Cannot find a provider',
    'A booked consultation','paid-operator-opportunity','conversation') returning id into oid;
  update public.market_opportunities set status='validated' where id=oid;
  insert into public.service_offers(client_id,kind,service_name)
    values('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','main','Fixture service')
    returning id into main_offer;
  insert into public.opportunity_links(opportunity_id,client_id,role,offer_id)
    values(oid,'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','offer',main_offer);
  insert into public.opportunity_scores(opportunity_id,client_id,factors,total,classification)
    values(oid,'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','{}'::jsonb,72,'test');
  insert into public.opportunity_awareness_stages(opportunity_id,client_id,stage,mindset,message)
    values(oid,'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','problem_aware',
      'Need a provider','Book a consultation');
  approval_id:=public.request_opportunity_approval_v6(oid);
  perform public.approve_opportunity_v6(oid,approval_id);
  perform public.create_secondary_offer_v7(oid);
end $source$;
select public.create_service_offer_version_v6(
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','New secondary offer','Local buyers',
  'Fixture promise',array[]::text[],array[]::text[],null,null,null,'[]'::jsonb,
  'paid-fixture',(select id from public.service_offers
    where client_id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' and kind='secondary'
    order by created_at desc limit 1));
select public.approve_service_offer_version_v6(id)
  from public.service_offer_versions where idempotency_key='paid-fixture';
insert into public.client_campaigns(id,client_id,name,brief,acquisition_mode,runs_organic,runs_paid,
  paid_platform,content_count,organic_content_count,paid_content_count,built_at,
  offer_version_id,audience,target_countries,daily_budget)
values ('cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Paid fixture campaign','Fixture',
  'paid',false,true,'meta',4,0,4,now(),
  (select id from public.service_offer_versions where idempotency_key='paid-fixture'),
  'Local buyers',array['US'],25);
insert into public.opportunity_links(opportunity_id,client_id,role,campaign_id)
select o.id,o.client_id,'campaign','cccccccc-cccc-4ccc-8ccc-cccccccccccc'
  from public.market_opportunities o where o.idempotency_key='paid-operator-opportunity';
select public.set_campaign_content_spec_v7('cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  '[{"route":"paid","platform":"facebook","media_type":"image","content_format":"single"},
    {"route":"paid","platform":"instagram","media_type":"video","content_format":"reel"},
    {"route":"paid","platform":"instagram","media_type":"image","content_format":"carousel"},
    {"route":"paid","platform":"instagram","media_type":"image","content_format":"story"}]'::jsonb);
select public.approve_campaign_plan_v6('cccccccc-cccc-4ccc-8ccc-cccccccccccc');
select set_config('request.jwt.claim.role','service_role',true);
select set_config('request.jwt.claims','{"role":"service_role"}',true);

do $checks$
declare cid uuid:='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  client uuid:='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  v_run_id uuid; route_id uuid; route_version integer; work_id uuid; video_work_id uuid;
  carousel_work_id uuid; story_work_id uuid;
  asset_id uuid; video_asset_id uuid; carousel_asset_id uuid; story_asset_id uuid;
  frame_one uuid; frame_two uuid; story_frame uuid;
  asset_fingerprint text; plan_hash text; spec_hash text;
  frozen public.campaign_preparation_packages_v7%rowtype;
  bundle public.paid_operator_bundles_v7%rowtype;
  same_bundle public.paid_operator_bundles_v7%rowtype;
  request_id uuid; creative_request_id uuid; creative_review_id uuid;
  video_request_id uuid; video_review_id uuid;
  event_id uuid; refused boolean:=false;
begin
  select public.campaign_plan_fingerprint(c),c.content_spec_hash into plan_hash,spec_hash
    from public.client_campaigns c where id=cid;
  select id into v_run_id from public.create_workflow_run(client,'campaign_sweep',
    'v7.paid.operator.fixture','paid-operator-fixture',jsonb_build_object(
      'plan_fingerprint',plan_hash,'content_spec_hash',spec_hash),
    now()+interval '1 day',cid);
  perform public.add_workflow_agent_step(v_run_id,'piece1_create','{}',
    'creative_build','client_briefs','dddddddd-dddd-4ddd-8ddd-dddddddddddd');
  perform public.add_workflow_agent_step(v_run_id,'piece2_create','{}',
    'creative_build','client_briefs','eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee');
  perform public.add_workflow_agent_step(v_run_id,'piece3_create','{}',
    'creative_build','client_briefs','ffffffff-ffff-4fff-8fff-ffffffffffff');
  perform public.add_workflow_agent_step(v_run_id,'piece4_create','{}',
    'creative_build','client_briefs','11111111-1111-4111-8111-111111111111');
  select id,version into route_id,route_version
    from public.ensure_campaign_route_packages_v7(cid,v_run_id) where route='paid';
  select id into work_id from public.create_delivery_work_item_v6(cid,route_id,
    null,null,'content_piece1',route_version,'content_production_factory',true,
    jsonb_build_object('workflow_run_id',v_run_id),
    '{"artifact_kind":"asset","platform":"facebook","media_type":"image","content_format":"single"}'::jsonb);
  perform public.bind_campaign_sweep_work_v7(work_id,v_run_id,'piece1','piece1_create');
  select id into video_work_id from public.create_delivery_work_item_v6(cid,route_id,
    null,null,'content_piece2',route_version,'content_production_factory',true,
    jsonb_build_object('workflow_run_id',v_run_id),
    '{"artifact_kind":"asset","platform":"instagram","media_type":"video","content_format":"reel"}'::jsonb);
  perform public.bind_campaign_sweep_work_v7(video_work_id,v_run_id,'piece2','piece2_create');
  select id into carousel_work_id from public.create_delivery_work_item_v6(cid,route_id,
    null,null,'content_piece3',route_version,'content_production_factory',true,
    jsonb_build_object('workflow_run_id',v_run_id),
    '{"artifact_kind":"asset","platform":"instagram","media_type":"image","content_format":"carousel"}'::jsonb);
  perform public.bind_campaign_sweep_work_v7(carousel_work_id,v_run_id,'piece3','piece3_create');
  select id into story_work_id from public.create_delivery_work_item_v6(cid,route_id,
    null,null,'content_piece4',route_version,'content_production_factory',true,
    jsonb_build_object('workflow_run_id',v_run_id),
    '{"artifact_kind":"asset","platform":"instagram","media_type":"image","content_format":"story"}'::jsonb);
  perform public.bind_campaign_sweep_work_v7(story_work_id,v_run_id,'piece4','piece4_create');
  perform public.seal_workflow_run(v_run_id);
  perform public.sync_campaign_sweep_work_v7(10);
  insert into public.client_media_assets(client_id,media_type,content_format,title,
    storage_path,usage_rights,ad_primary_text,ad_headline,ad_cta)
    values(client,'image','single','Paid fixture creative',
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/paid.png','agency_owned',
      'Fixture copy','Fixture headline','Learn more')
    returning id into asset_id;
  insert into storage.objects(id,bucket_id,name,version) values
    ('dddddddd-dddd-4ddd-8ddd-dddddddddddd','client-media',
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/paid.png','v1');
  perform public.attest_creative_storage_bytes_v6(asset_id,
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/paid.png',repeat('b',64),14,
    'dddddddd-dddd-4ddd-8ddd-dddddddddddd','v1',
    (select updated_at from storage.objects where id='dddddddd-dddd-4ddd-8ddd-dddddddddddd'));
  perform set_config('request.jwt.claim.role','authenticated',true);
  perform set_config('request.jwt.claim.sub','99999999-9999-4999-8999-999999999999',true);
  perform set_config('request.jwt.claims',
    '{"sub":"99999999-9999-4999-8999-999999999999","role":"authenticated","aal":"aal2"}',true);
  creative_request_id:=public.request_ordinary_media_review_v6(asset_id);
  perform set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true);
  perform set_config('request.jwt.claims',
    '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal2"}',true);
  select id into creative_review_id from public.ordinary_media_review_requests_v6
    where canonical_request_id=creative_request_id;
  perform public.approve_ordinary_media_inbox_v6(creative_review_id,creative_request_id);
  if not public.ordinary_media_signoff_current_v6(asset_id) then
    raise exception 'Paid creative lacks an exact human signoff'; end if;
  insert into public.client_media_assets(client_id,media_type,content_format,title,
    storage_path,render_path,usage_rights,ad_primary_text,ad_headline,ad_cta)
  values(client,'video','reel','Paid fixture short video',
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/source.mp4',
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/final.mp4','agency_owned',
    'Video primary copy','Video headline','Learn more')
  returning id into video_asset_id;
  insert into storage.objects(id,bucket_id,name,version) values
    ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee','client-media',
     'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/final.mp4','v1');
  perform set_config('request.jwt.claim.role','service_role',true);
  perform set_config('request.jwt.claims','{"role":"service_role"}',true);
  perform public.attest_creative_storage_bytes_v6(video_asset_id,
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/final.mp4',repeat('c',64),20,
    'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee','v1',
    (select updated_at from storage.objects where id='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'));
  perform set_config('request.jwt.claim.role','authenticated',true);
  perform set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true);
  perform set_config('request.jwt.claims',
    '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal2"}',true);
  video_request_id:=public.request_video_seat_review_v6(video_asset_id,'owner');
  select id into video_review_id from public.video_seat_review_requests_v6
    where canonical_request_id=video_request_id;
  perform public.decide_video_seat_inbox_v6(video_review_id,video_request_id,true);
  perform set_config('request.jwt.claim.sub','eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',true);
  perform set_config('request.jwt.claims',
    '{"sub":"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee","role":"authenticated","aal":"aal2"}',true);
  video_request_id:=public.request_video_seat_review_v6(video_asset_id,'manager');
  select id into video_review_id from public.video_seat_review_requests_v6
    where canonical_request_id=video_request_id;
  perform public.decide_video_seat_inbox_v6(video_review_id,video_request_id,true);
  perform set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true);
  perform set_config('request.jwt.claims',
    '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal2"}',true);
  perform public.review_media_asset(video_asset_id,'approved'::public.review_status);
  if not public.video_signoff_current_v6(video_asset_id,'owner')
    or not public.video_signoff_current_v6(video_asset_id,'manager') then
    raise exception 'Paid short video lacks current exact human seats'; end if;
  perform set_config('request.jwt.claim.role','service_role',true);
  perform set_config('request.jwt.claims','{"role":"service_role"}',true);
  insert into public.client_media_assets(client_id,media_type,content_format,title,
    storage_path,usage_rights,ad_primary_text,ad_headline,ad_cta)
  values(client,'image','carousel','Paid carousel',
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/slide-one.png','agency_owned',
    'Carousel copy','Carousel headline','Learn more') returning id into carousel_asset_id;
  insert into public.client_media_frames(asset_id,position,storage_path,caption)
  values(carousel_asset_id,1,
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/slide-one.png','Opening slide')
    returning id into frame_one;
  insert into public.client_media_frames(asset_id,position,storage_path,caption)
  values(carousel_asset_id,2,
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/slide-two.png','Closing slide')
    returning id into frame_two;
  insert into public.client_media_assets(client_id,media_type,content_format,title,
    storage_path,usage_rights,ad_primary_text,ad_headline,ad_cta)
  values(client,'image','story','Paid story',
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/story.png','agency_owned',
    'Story copy','Story headline','Learn more') returning id into story_asset_id;
  insert into public.client_media_frames(asset_id,position,storage_path,caption)
  values(story_asset_id,1,
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/story.png','Only story frame')
    returning id into story_frame;
  insert into storage.objects(id,bucket_id,name,version) values
    ('ffffffff-ffff-4fff-8fff-ffffffffffff','client-media',
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/slide-one.png','v1'),
    ('11111111-1111-4111-8111-111111111111','client-media',
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/slide-two.png','v1'),
    ('22222222-2222-4222-8222-222222222222','client-media',
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/story.png','v1');
  perform public.attest_creative_storage_bytes_v6(carousel_asset_id,
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/slide-one.png',repeat('d',64),14,
    'ffffffff-ffff-4fff-8fff-ffffffffffff','v1',
    (select updated_at from storage.objects where id='ffffffff-ffff-4fff-8fff-ffffffffffff'));
  perform public.attest_creative_frame_bytes_v8(carousel_asset_id,frame_one,
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/slide-one.png',repeat('d',64),14,
    'ffffffff-ffff-4fff-8fff-ffffffffffff','v1',
    (select updated_at from storage.objects where id='ffffffff-ffff-4fff-8fff-ffffffffffff'));
  perform public.attest_creative_frame_bytes_v8(carousel_asset_id,frame_two,
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/slide-two.png',repeat('e',64),16,
    '11111111-1111-4111-8111-111111111111','v1',
    (select updated_at from storage.objects where id='11111111-1111-4111-8111-111111111111'));
  perform public.attest_creative_storage_bytes_v6(story_asset_id,
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/story.png',repeat('f',64),12,
    '22222222-2222-4222-8222-222222222222','v1',
    (select updated_at from storage.objects where id='22222222-2222-4222-8222-222222222222'));
  perform public.attest_creative_frame_bytes_v8(story_asset_id,story_frame,
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/story.png',repeat('f',64),12,
    '22222222-2222-4222-8222-222222222222','v1',
    (select updated_at from storage.objects where id='22222222-2222-4222-8222-222222222222'));
  perform set_config('request.jwt.claim.role','authenticated',true);
  perform set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true);
  perform set_config('request.jwt.claims',
    '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal2"}',true);
  creative_request_id:=public.request_ordinary_media_review_v6(carousel_asset_id);
  select id into creative_review_id from public.ordinary_media_review_requests_v6
    where canonical_request_id=creative_request_id;
  perform public.approve_ordinary_media_inbox_v6(creative_review_id,creative_request_id);
  creative_request_id:=public.request_ordinary_media_review_v6(story_asset_id);
  select id into creative_review_id from public.ordinary_media_review_requests_v6
    where canonical_request_id=creative_request_id;
  perform public.approve_ordinary_media_inbox_v6(creative_review_id,creative_request_id);
  if not public.ordinary_media_signoff_current_v6(carousel_asset_id)
    or not public.ordinary_media_signoff_current_v6(story_asset_id) then
    raise exception 'Paid framed creative lacks exact review'; end if;
  perform set_config('request.jwt.claim.role','service_role',true);
  perform set_config('request.jwt.claims','{"role":"service_role"}',true);
  select fingerprint into asset_fingerprint from public.delivery_source_catalog_v6
    where entity_kind='content_asset' and source_key=asset_id::text;
  update public.workflow_steps set status='completed'
    where run_id=v_run_id and step_key='piece1_create';
  insert into public.workflow_artifacts(run_id,step_id,artifact_kind,record_id,
    version_key,qa_evidence)
  select v_run_id,s.id,'asset',asset_id,'fixture-v1',
    jsonb_build_object('result','pass','checks',jsonb_build_array('fixture_asset'),
      'source_fingerprint',asset_fingerprint)
    from public.workflow_steps s where s.run_id=v_run_id and s.step_key='piece1_create';
  select fingerprint into asset_fingerprint from public.delivery_source_catalog_v6
    where entity_kind='content_asset' and source_key=video_asset_id::text;
  update public.workflow_steps set status='completed'
    where run_id=v_run_id and step_key='piece2_create';
  insert into public.workflow_artifacts(run_id,step_id,artifact_kind,record_id,
    version_key,qa_evidence)
  select v_run_id,s.id,'asset',video_asset_id,'fixture-video-v1',
    jsonb_build_object('result','pass','checks',jsonb_build_array('fixture_video'),
      'source_fingerprint',asset_fingerprint)
    from public.workflow_steps s where s.run_id=v_run_id and s.step_key='piece2_create';
  select fingerprint into asset_fingerprint from public.delivery_source_catalog_v6
    where entity_kind='content_asset' and source_key=carousel_asset_id::text;
  update public.workflow_steps set status='completed'
    where run_id=v_run_id and step_key='piece3_create';
  insert into public.workflow_artifacts(run_id,step_id,artifact_kind,record_id,
    version_key,qa_evidence)
  select v_run_id,s.id,'asset',carousel_asset_id,'fixture-carousel-v1',
    jsonb_build_object('result','pass','checks',jsonb_build_array('fixture_carousel'),
      'source_fingerprint',asset_fingerprint)
    from public.workflow_steps s where s.run_id=v_run_id and s.step_key='piece3_create';
  select fingerprint into asset_fingerprint from public.delivery_source_catalog_v6
    where entity_kind='content_asset' and source_key=story_asset_id::text;
  update public.workflow_steps set status='completed'
    where run_id=v_run_id and step_key='piece4_create';
  insert into public.workflow_artifacts(run_id,step_id,artifact_kind,record_id,
    version_key,qa_evidence)
  select v_run_id,s.id,'asset',story_asset_id,'fixture-story-v1',
    jsonb_build_object('result','pass','checks',jsonb_build_array('fixture_story'),
      'source_fingerprint',asset_fingerprint)
    from public.workflow_steps s where s.run_id=v_run_id and s.step_key='piece4_create';
  perform public.sync_campaign_sweep_work_v7(10);
  perform set_config('request.jwt.claim.role','authenticated',true);
  perform set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true);
  perform set_config('request.jwt.claims',
    '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal2"}',true);
  select * into frozen from public.assemble_campaign_preparation_package_v7(cid);
  select id into request_id from public.approval_requests_v6
    where source_kind='campaign_preparation_package' and source_id=frozen.id::text;
  perform public.decide_campaign_preparation_package_v7(frozen.id,request_id,true);
  select * into bundle from public.create_paid_operator_bundle_v7(frozen.id,
    'Paid manager','Cap at 25 per day','Use campaign and page source IDs');
  select * into same_bundle from public.create_paid_operator_bundle_v7(frozen.id,
    'Paid manager','Cap at 25 per day','Use campaign and page source IDs');
  if bundle.id<>same_bundle.id or not public.paid_operator_bundle_current_v7(bundle.id)
    or jsonb_array_length(bundle.snapshot->'source'->'creative')<>4
    or not exists(select 1 from jsonb_array_elements(bundle.snapshot->'source'->'creative') item
      where item->>'asset_id'=video_asset_id::text
        and item->>'storage_path'='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/final.mp4'
        and item->>'file_sha256'=repeat('c',64))
    or not exists(select 1 from jsonb_array_elements(bundle.snapshot->'source'->'creative') item
      where item->>'asset_id'=asset_id::text
        and item->>'ad_primary_text'='Fixture copy')
    or not exists(select 1 from jsonb_array_elements(bundle.snapshot->'source'->'creative') item
      where item->>'asset_id'=carousel_asset_id::text
        and jsonb_array_length(item->'files')=2
        and item#>>'{files,0,file_sha256}'=repeat('d',64)
        and item#>>'{files,1,file_sha256}'=repeat('e',64))
    or not exists(select 1 from jsonb_array_elements(bundle.snapshot->'source'->'creative') item
      where item->>'asset_id'=story_asset_id::text
        and jsonb_array_length(item->'files')=1
        and item#>>'{files,0,file_sha256}'=repeat('f',64)) then
    raise exception 'Exact paid bundle was not current, complete and idempotent'; end if;
  begin
    update public.client_media_assets set title='Changed paid cut'
      where id=video_asset_id;
    if public.video_signoff_current_v6(video_asset_id,'owner')
      or public.paid_operator_bundle_current_v7(bundle.id) then
      raise exception 'Changed final video retained a current paid packet';
    end if;
    raise exception 'rollback video edit probe';
  exception when raise_exception then
    if sqlerrm <> 'rollback video edit probe' then raise; end if;
  end;
  if not public.paid_operator_bundle_current_v7(bundle.id) then
    raise exception 'Rollback-only video edit invalidated the original packet';
  end if;
  begin
    update storage.objects set version='v2'
      where id='11111111-1111-4111-8111-111111111111';
    if public.ordinary_media_signoff_current_v6(carousel_asset_id)
      or public.paid_operator_bundle_current_v7(bundle.id) then
      raise exception 'Changed second frame retained a current paid packet';
    end if;
    raise exception 'rollback second frame probe';
  exception when raise_exception then
    if sqlerrm <> 'rollback second frame probe' then raise; end if;
  end;
  if not public.paid_operator_bundle_current_v7(bundle.id) then
    raise exception 'Rollback-only frame edit invalidated the original packet';
  end if;
  select id into request_id from public.approval_requests_v6
    where source_kind='paid_operator_bundle' and source_id=bundle.id::text;
  if request_id is null or public.paid_operator_bundle_approved_v7(bundle.id)
    or public.paid_operator_bundle_review_source_state_v7(request_id)<>'pending' then
    raise exception 'Frozen Meta packet bypassed exact review'; end if;
  begin
    perform public.paid_operator_bundle_export_v7(bundle.id);
  exception when insufficient_privilege then refused:=true; end;
  if not refused then raise exception 'Unapproved Meta packet exported'; end if;
  refused:=false;
  perform public.decide_paid_operator_bundle_v7(bundle.id,request_id,true,null);
  if not public.paid_operator_bundle_approved_v7(bundle.id) then
    raise exception 'Exact Meta packet approval did not bind'; end if;
  begin
    perform public.record_paid_operator_event_v7(bundle.id,'handoff_reported','ticket-100');
  exception when check_violation then refused:=true; end;
  if not refused then raise exception 'Handoff skipped verified download'; end if;
  refused:=false;
  begin
    perform public.record_paid_operator_event_v7(bundle.id,'verified_download',
      'browser-sha256:' || bundle.snapshot_hash);
  exception when check_violation then refused:=true; end;
  if not refused then raise exception 'Unverified packet hash was accepted'; end if;
  refused:=false;
  perform public.record_paid_operator_event_v7(bundle.id,'verified_download',
    'sha256:' || bundle.snapshot_hash);
  select id into event_id from public.record_paid_operator_event_v7(bundle.id,
    'handoff_reported','ticket-100');
  if event_id is distinct from (select id from public.record_paid_operator_event_v7(
      bundle.id,'handoff_reported','ticket-100')) then
    raise exception 'Handoff retry was not idempotent'; end if;
  perform public.record_paid_operator_event_v7(bundle.id,
    'external_ids_reported','ads-manager-100','123456','7890');
  if (select match_state from public.paid_operator_metric_match_v7
      where bundle_id=bundle.id)<>'no_matching_metric_rows' then
    raise exception 'A reported ID was treated as observed without metrics'; end if;
  perform set_config('request.jwt.claim.role','service_role',true);
  perform set_config('request.jwt.claims','{"role":"service_role"}',true);
  insert into public.metrics_daily(client_id,surface,entity_type,external_id,metric_date,
    basis,spend,currency,impressions)
  values(client,'paid','campaign','123456',current_date,'daily',10,'USD',100);
  perform set_config('request.jwt.claim.role','authenticated',true);
  perform set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true);
  perform set_config('request.jwt.claims',
    '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal2"}',true);
  if not exists(select 1 from public.paid_operator_metric_match_v7
      where bundle_id=bundle.id and match_state='metric_rows_match_reported_id'
        and days_with_rows=1 and recorded_spend=10 and currency='USD') then
    raise exception 'Matching daily paid metrics were not reconciled'; end if;
  update public.client_campaigns set daily_budget=30 where id=cid;
  if public.paid_operator_bundle_current_v7(bundle.id) then
    raise exception 'A changed budget retained a current handoff'; end if;
  begin
    perform public.record_paid_operator_event_v7(bundle.id,
      'activation_reported','ads-manager-101','123456');
  exception when check_violation then refused:=true; end;
  if not refused then raise exception 'Stale paid bundle accepted an activation report'; end if;
end $checks$;
rollback;

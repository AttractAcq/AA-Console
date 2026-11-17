-- A current QA output can be frozen once; changing its source stales the freeze.
begin;
insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','00000000-0000-0000-0000-000000000000',
  'authenticated','authenticated','snapshot-fixture@example.invalid','',now(),now());
insert into public.profiles(id,role,email) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','admin','snapshot-fixture@example.invalid');
insert into public.clients(id,name,initials) values
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Snapshot fixture','SF');
insert into public.client_campaigns(id,client_id,name,brief,acquisition_mode,runs_organic,runs_paid,
  content_count,organic_content_count,paid_content_count)
values ('cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Snapshot campaign','Fixture',
  'organic',true,false,1,1,0);
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true);
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal2"}',true);
-- A reviewable package now requires the same signed opportunity and secondary
-- offer lineage as a new commercial campaign. Keep this fixture on that path.
do $source$
declare o public.market_opportunities%rowtype;
  offer public.service_offers%rowtype;
  v public.service_offer_versions%rowtype;
  main_offer_id uuid; approval_id uuid;
begin
  insert into public.market_opportunities(client_id,name,micro_market,buying_situation,
    core_problem,desired_outcome,idempotency_key,confidence)
  values('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Snapshot buyer',
    'Homeowners with unused garages','Preparing for winter fitness',
    'Their garage cannot be used for training','A private gym at home',
    'snapshot-opportunity','conversation') returning * into o;
  update public.market_opportunities set status='validated' where id=o.id;
  insert into public.service_offers(client_id,kind,service_name)
    values(o.client_id,'main','Garage conversion') returning id into main_offer_id;
  insert into public.opportunity_links(opportunity_id,client_id,role,offer_id)
    values(o.id,o.client_id,'offer',main_offer_id);
  insert into public.opportunity_scores(opportunity_id,client_id,factors,total,classification)
    values(o.id,o.client_id,'{}'::jsonb,72,'test');
  insert into public.opportunity_awareness_stages(opportunity_id,client_id,stage,mindset,message)
    values(o.id,o.client_id,'problem_aware','Winter is coming','Convert the garage');
  approval_id:=public.request_opportunity_approval_v6(o.id);
  perform public.approve_opportunity_v6(o.id,approval_id);
  offer:=public.create_secondary_offer_v7(o.id);
  v:=public.create_service_offer_version_v6(o.client_id,'New secondary offer',
    'Homeowners with unused garages','A garage ready for training',
    array['Insulation'],array['Gym equipment'],null,null,null,'[]'::jsonb,
    'snapshot-offer-version',offer.id);
  perform public.approve_service_offer_version_v6(v.id);
  insert into public.opportunity_links(opportunity_id,client_id,role,campaign_id)
    values(o.id,o.client_id,'campaign','cccccccc-cccc-4ccc-8ccc-cccccccccccc');
  update public.client_campaigns set offer_version_id=v.id,built_at=now()
    where id='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
end $source$;
select public.set_campaign_content_spec_v7('cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  '[{"route":"organic","platform":"instagram","media_type":"image","content_format":"single"}]'::jsonb);
select public.approve_campaign_plan_v6('cccccccc-cccc-4ccc-8ccc-cccccccccccc');
select set_config('request.jwt.claim.role','service_role',true);
select set_config('request.jwt.claims','{"role":"service_role"}',true);

do $checks$
declare cid uuid:='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  client uuid:='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  v_run_id uuid; route_id uuid; route_version integer; work_id uuid;
  asset_id uuid; asset_fingerprint text; plan_hash text; spec_hash text;
  frozen public.campaign_preparation_packages_v7%rowtype;
  again public.campaign_preparation_packages_v7%rowtype;
  request_id uuid; refused boolean := false;
begin
  select public.campaign_plan_fingerprint(c),c.content_spec_hash into plan_hash,spec_hash
    from public.client_campaigns c where id=cid;
  select id into v_run_id from public.create_workflow_run(client,'campaign_sweep',
    'v7.snapshot.fixture','snapshot-fixture',jsonb_build_object(
      'plan_fingerprint',plan_hash,'content_spec_hash',spec_hash),
    now()+interval '1 day',cid);
  perform public.add_workflow_agent_step(v_run_id,'piece1_create','{}',
    'creative_build','client_briefs','dddddddd-dddd-4ddd-8ddd-dddddddddddd');
  select id,version into route_id,route_version
    from public.ensure_campaign_route_packages_v7(cid,v_run_id) where route='organic';
  select id into work_id from public.create_delivery_work_item_v6(cid,route_id,
    null,null,'content_piece1',route_version,'content_production_factory',true,
    jsonb_build_object('workflow_run_id',v_run_id),
    '{"artifact_kind":"asset","platform":"instagram","media_type":"image","content_format":"single"}'::jsonb);
  perform public.bind_campaign_sweep_work_v7(work_id,v_run_id,'piece1','piece1_create');
  perform public.seal_workflow_run(v_run_id);
  perform public.sync_campaign_sweep_work_v7(10);
  insert into public.client_media_assets(client_id,media_type,title,storage_path)
    values(client,'image','Snapshot creative','campaign-fixture/snapshot.png')
    returning id into asset_id;
  update public.client_media_assets set delivery_bytes_sha256=repeat('a',64)
    where id=asset_id;
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
  perform public.sync_campaign_sweep_work_v7(10);
  if public.campaign_package_readiness_v7(cid)->>'status'<>'ready_for_review' then
    raise exception 'Current QA work did not make package reviewable';
  end if;
  perform set_config('request.jwt.claim.role','authenticated',true);
  perform set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true);
  perform set_config('request.jwt.claims',
    '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal2"}',true);
  select * into frozen from public.assemble_campaign_preparation_package_v7(cid);
  select * into again from public.assemble_campaign_preparation_package_v7(cid);
  if frozen.id<>again.id or frozen.snapshot_hash<>again.snapshot_hash
    or not public.campaign_preparation_package_current_v7(frozen.id)
    or jsonb_array_length(frozen.snapshot->'outputs')<>1 then
    raise exception 'Package freeze was not exact and idempotent'; end if;
  select id into request_id from public.approval_requests_v6
    where source_kind='campaign_preparation_package' and source_id=frozen.id::text;
  if request_id is null or (select status from public.approval_inbox_v6
    where id=request_id)<>'pending' then
    raise exception 'Exact package review did not enter the unified inbox'; end if;
  perform set_config('request.jwt.claims',
    '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal1"}',true);
  begin
    perform public.decide_campaign_preparation_package_v7(frozen.id,request_id,true);
  exception when insufficient_privilege then refused:=true;
  end;
  if not refused then raise exception 'AAL1 approved a preparation package'; end if;
  perform set_config('request.jwt.claims',
    '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal2"}',true);
  perform public.decide_campaign_preparation_package_v7(frozen.id,request_id,true);
  if not public.campaign_preparation_approved_v7(frozen.id)
    or (select status from public.approval_inbox_v6 where id=request_id)<>'approved' then
    raise exception 'AAL2 review did not approve the exact package'; end if;
  update public.client_media_assets set storage_path='campaign-fixture/changed.png'
    where id=asset_id;
  if public.campaign_preparation_package_current_v7(frozen.id)
    or public.campaign_preparation_approved_v7(frozen.id)
    or (select status from public.approval_inbox_v6 where id=request_id)<>'superseded' then
    raise exception 'Changed output kept its package approval usable'; end if;
end $checks$;
rollback;

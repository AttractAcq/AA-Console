-- Rollback-only proof that one reviewed plan prepares independent route work,
-- binds exact workflow steps, and preserves a new package version on rerun.
begin;
insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','00000000-0000-0000-0000-000000000000',
  'authenticated','authenticated','route-work-admin@example.invalid','',now(),now());
insert into public.profiles(id,role,email) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','admin','route-work-admin@example.invalid');
insert into public.clients(id,name,initials) values
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Route work fixture','RW');
insert into public.client_campaigns(id,client_id,name,brief,acquisition_mode,runs_organic,runs_paid,
  paid_platform,content_count,organic_content_count,paid_content_count,built_at)
values ('cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Two route work','Fixture',
  'both',true,true,'meta',2,1,1,now());
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true);
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal2"}',true);
select public.set_campaign_content_spec_v7('cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  '[{"route":"organic","platform":"instagram","media_type":"image","content_format":"single"},
    {"route":"paid","platform":"facebook","media_type":"image","content_format":"carousel"}]'::jsonb);
select public.approve_campaign_plan_v6('cccccccc-cccc-4ccc-8ccc-cccccccccccc');
select set_config('request.jwt.claim.role','service_role',true);
select set_config('request.jwt.claims','{"role":"service_role"}',true);

do $checks$
declare cid uuid:='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  run1 uuid; run2 uuid; organic1 record; paid1 record; organic2 record;
  work1 uuid; work2 uuid; asset2 uuid; asset_fingerprint text; n integer;
begin
  select id into run1 from public.create_workflow_run(
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','campaign_sweep','v7.fixture',
    'route-work-1','{}'::jsonb,now()+interval '1 day',cid);
  perform public.add_workflow_agent_step(run1,'piece1_create','{}',
    'creative_build','client_briefs','dddddddd-dddd-4ddd-8ddd-dddddddddddd');
  perform public.add_workflow_agent_step(run1,'piece2_create','{}',
    'creative_build','client_briefs','eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee');
  select * into organic1 from public.ensure_campaign_route_packages_v7(cid,run1)
    where route='organic';
  select * into paid1 from public.ensure_campaign_route_packages_v7(cid,run1)
    where route='paid';
  if organic1.id is null or paid1.id is null or organic1.id=paid1.id then
    raise exception 'Route packages were not independent'; end if;
  select id into work1 from public.create_delivery_work_item_v6(cid,organic1.id,
    null,null,'content_piece1',organic1.version,'content_production_factory',true,
    jsonb_build_object('workflow_run_id',run1),'{"artifact_kind":"asset"}'::jsonb);
  select id into work2 from public.create_delivery_work_item_v6(cid,paid1.id,
    null,null,'content_piece2',paid1.version,'content_production_factory',true,
    jsonb_build_object('workflow_run_id',run1),'{"artifact_kind":"asset"}'::jsonb);
  perform public.bind_campaign_sweep_work_v7(work1,run1,'piece1','piece1_create');
  perform public.bind_campaign_sweep_work_v7(work2,run1,'piece2','piece2_create');
  perform public.seal_workflow_run(run1);
  n:=public.sync_campaign_sweep_work_v7(10);
  if n<>2 or (select count(*) from public.delivery_work_items_v6
    where id in (work1,work2) and state='prepared')<>2 then
    raise exception 'Sealed pieces were not prepared'; end if;
  update public.workflow_steps set status='blocked',blocker='Fix only organic source'
    where run_id=run1 and step_key='piece1_create';
  n:=public.sync_campaign_sweep_work_v7(10);
  if n<>1 or (select state from public.delivery_work_items_v6 where id=work1)<>'held'
    or (select state from public.delivery_work_items_v6 where id=work2)<>'prepared' then
    raise exception 'A failed piece affected its sibling'; end if;
  perform set_config('request.jwt.claim.role','authenticated',true);
  perform set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true);
  perform set_config('request.jwt.claims',
    '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal2"}',true);
  perform public.retry_campaign_sweep_step_v7((select id from public.workflow_steps
    where run_id=run1 and step_key='piece1_create'));
  if (select status from public.workflow_steps where run_id=run1
      and step_key='piece1_create')<>'pending'
    or (select status from public.workflow_steps where run_id=run1
      and step_key='piece2_create')<>'pending'
    or (select count(*) from public.campaign_sweep_step_retries_v7 where run_id=run1)<>1
    then raise exception 'Retry reset a sibling or lost its audit'; end if;
  begin
    perform public.retry_campaign_sweep_step_v7((select id from public.workflow_steps
      where run_id=run1 and step_key='piece1_create'));
    raise exception 'A second retry reset pending work';
  exception when raise_exception then
    if sqlerrm='A second retry reset pending work' then raise; end if;
  end;
  perform set_config('request.jwt.claim.role','service_role',true);
  perform set_config('request.jwt.claims','{"role":"service_role"}',true);
  insert into public.client_media_assets(client_id,media_type,title,storage_path)
  values('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','image',
    'Paid fixture creative','campaign-fixture/paid.png') returning id into asset2;
  -- Synthetic fixture bytes: production uses the Storage verifier to attest
  -- the actual object before this output link can be made.
  update public.client_media_assets set delivery_bytes_sha256=repeat('a',64)
    where id=asset2;
  select fingerprint into asset_fingerprint from public.delivery_source_catalog_v6
    where entity_kind='content_asset' and source_key=asset2::text;
  update public.workflow_steps set status='completed'
    where run_id=run1 and step_key='piece2_create';
  insert into public.workflow_artifacts(run_id,step_id,artifact_kind,record_id,
    version_key,qa_evidence)
  select run1,s.id,'asset',asset2,'fixture-v1',
    jsonb_build_object('result','pass','checks',jsonb_build_array('fixture_asset'),
      'source_fingerprint',asset_fingerprint)
  from public.workflow_steps s where s.run_id=run1 and s.step_key='piece2_create';
  perform public.sync_campaign_sweep_work_v7(10);
  if (select state from public.delivery_work_items_v6 where id=work2)<>'ready_for_review'
    or (select output_fingerprint from public.delivery_work_items_v6 where id=work2)
      is distinct from public.delivery_work_output_hash_v6(work2)
    or (select count(*) from public.delivery_work_outputs_v6 where work_item_id=work2)<>1
    then raise exception 'Accepted content asset did not reach relational review'; end if;
  update public.client_media_assets set storage_path='campaign-fixture/revised.png'
    where id=asset2;
  if (select effective_state from public.delivery_work_effective_v6 where id=work2)<>'held'
    then raise exception 'Changed output was still presented as reviewable'; end if;
  if (select id from public.ensure_campaign_route_packages_v7(cid,run1)
    where route='organic')<>organic1.id then
    raise exception 'Retry changed the package version'; end if;
  select id into run2 from public.create_workflow_run(
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','campaign_sweep','v7.fixture',
    'route-work-2','{}'::jsonb,now()+interval '1 day',cid);
  select * into organic2 from public.ensure_campaign_route_packages_v7(cid,run2)
    where route='organic';
  if organic2.id=organic1.id or organic2.version<>organic1.version+1 then
    raise exception 'A new sweep reused old route work'; end if;
end $checks$;
rollback;

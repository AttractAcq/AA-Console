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
  work1 uuid; work2 uuid; n integer;
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

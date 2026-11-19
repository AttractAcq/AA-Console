-- Rollback-only manual campaign entry contract. No provider or lasting client
-- row is touched. The planner dependency is disabled only inside this fixture.
begin;
insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
values ('cccccccc-cccc-4ccc-8ccc-cccccccccccc','00000000-0000-0000-0000-000000000000',
  'authenticated','authenticated','manual-campaign-admin@example.invalid','',now(),now());
insert into public.profiles(id,role,email)
values ('cccccccc-cccc-4ccc-8ccc-cccccccccccc','admin','manual-campaign-admin@example.invalid');
insert into public.clients(id,name,initials)
values ('dddddddd-dddd-4ddd-8ddd-dddddddddddd','Manual campaign fixture','MC');
update public.agents set requires_upstream='{}' where agent_key='campaign_plan';
select set_config('request.jwt.claim.sub','cccccccc-cccc-4ccc-8ccc-cccccccccccc',true);
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claims',
  '{"sub":"cccccccc-cccc-4ccc-8ccc-cccccccccccc","role":"authenticated","aal":"aal2"}',true);

do $checks$
declare organic public.client_campaigns%rowtype;
  replayed public.client_campaigns%rowtype;
  paid public.client_campaigns%rowtype;
  organic_revision public.client_campaigns%rowtype;
  replayed_revision public.client_campaigns%rowtype;
  organic_manifest public.campaign_manifest_versions%rowtype;
  paid_manifest public.campaign_manifest_versions%rowtype;
  readiness jsonb;
begin
  organic:=public.create_standalone_campaign_plan_v11(
    'dddddddd-dddd-4ddd-8ddd-dddddddddddd','standalone_organic',
    'Weekly advice','Give local homeowners useful advice',false,null,null,
    false,false,false,'{}'::uuid[],'organic-request');
  replayed:=public.create_standalone_campaign_plan_v11(
    'dddddddd-dddd-4ddd-8ddd-dddddddddddd','standalone_organic',
    'Weekly advice','Give local homeowners useful advice',false,null,null,
    false,false,false,'{}'::uuid[],'organic-request');
  if replayed.id is distinct from organic.id
    or organic.campaign_kind<>'standalone_organic'
    or organic.acquisition_mode<>'organic'
    or organic.runs_paid or not organic.runs_organic
    or organic.needs_landing_page or organic.needs_sales_agent or organic.needs_lead_magnet
    or exists(select 1 from public.opportunity_links where campaign_id=organic.id)
    or (select count(*) from public.agent_jobs
      where input_table='client_campaigns' and input_id=organic.id)<>1 then
    raise exception 'Standalone organic creation or idempotent planner queue failed'; end if;
  readiness:=public.campaign_package_readiness_v7(organic.id);
  if readiness->'blockers' @> '["Link one approved market opportunity before reviewing this campaign package."]'::jsonb
    or readiness->'blockers' @> '["Choose an exact signed secondary offer version for this opportunity."]'::jsonb then
    raise exception 'Standalone campaign inherited an opportunity-only package blocker'; end if;
  begin
    perform public.create_standalone_campaign_plan_v11(
      'dddddddd-dddd-4ddd-8ddd-dddddddddddd','standalone_organic',
      'Different request','Give local homeowners useful advice',false,null,null,
      false,false,false,'{}'::uuid[],'organic-request');
    raise exception 'A changed request reused an existing campaign key';
  exception when check_violation then null; end;
  begin
    update public.client_campaigns set needs_landing_page=true where id=organic.id;
    raise exception 'An operator module changed inside an existing plan';
  exception when check_violation then null; end;
  begin
    perform public.create_standalone_campaign_plan_v11(
      'dddddddd-dddd-4ddd-8ddd-dddddddddddd','standalone_paid',
      'Missing destination','Promote the service',true,null,null,
      true,false,false,'{}'::uuid[],'invalid-paid-request');
    raise exception 'Paid campaign accepted a missing platform';
  exception when invalid_parameter_value then null; end;
  paid:=public.create_standalone_campaign_plan_v11(
    'dddddddd-dddd-4ddd-8ddd-dddddddddddd','standalone_paid',
    'Service launch','Promote the service',true,'meta',null,
    true,false,true,'{}'::uuid[],'paid-request');
  if paid.campaign_kind<>'standalone_paid' or paid.acquisition_mode<>'paid'
    or paid.paid_platform<>'meta' or not paid.runs_paid or paid.runs_organic
    or not paid.needs_landing_page or paid.needs_sales_agent
    or not paid.needs_lead_magnet
    or exists(select 1 from public.opportunity_links where campaign_id=paid.id) then
    raise exception 'Standalone paid channel or module selection was not stored'; end if;
  update public.client_campaigns set built_at=now(),objective='Reach local homeowners',
    audience='Local homeowners' where id in (organic.id,paid.id);
  perform set_config('request.jwt.claim.role','service_role',true);
  select * into organic_manifest from public.create_typed_campaign_manifest_v11(
    organic.id,'organic-package',false);
  if organic_manifest.plan_snapshot->>'campaign_kind'<>'standalone_organic'
    or exists(select 1 from public.campaign_manifest_items
      where manifest_id=organic_manifest.id and item_key in (
        'offer','website','sales_path','lead_magnet','proof','proof_distribution')
        and required)
    or not exists(select 1 from public.campaign_manifest_items
      where manifest_id=organic_manifest.id and item_key='distribution'
        and module_key='content_distribution' and required) then
    raise exception 'Standalone organic manifest invented an unselected module'; end if;
  if (select id from public.create_typed_campaign_manifest_v11(
      organic.id,'organic-package',false)) is distinct from organic_manifest.id then
    raise exception 'Typed manifest retry created a duplicate version'; end if;
  begin
    perform public.create_typed_campaign_manifest_v11(organic.id,'wrong-magnet',true);
    raise exception 'Typed manifest accepted a changed magnet selection';
  exception when check_violation then null; end;
  select * into paid_manifest from public.create_typed_campaign_manifest_v11(
    paid.id,'paid-package',true);
  if paid_manifest.plan_snapshot->>'campaign_kind'<>'standalone_paid'
    or not exists(select 1 from public.campaign_manifest_items
      where manifest_id=paid_manifest.id and item_key='website' and required)
    or not exists(select 1 from public.campaign_manifest_items
      where manifest_id=paid_manifest.id and item_key='lead_magnet' and required)
    or exists(select 1 from public.campaign_manifest_items
      where manifest_id=paid_manifest.id and item_key='sales_path' and required)
    or not exists(select 1 from public.campaign_manifest_items
      where manifest_id=paid_manifest.id and item_key='distribution'
        and module_key='meta_ads_studio' and required) then
    raise exception 'Standalone paid manifest did not match selected producers'; end if;
  perform set_config('request.jwt.claim.role','authenticated',true);
  organic_revision:=public.create_typed_campaign_revision_v11(
    organic.id,organic.name,'Now include a service page',null,null,
    true,false,false,'organic-revision-request');
  replayed_revision:=public.create_typed_campaign_revision_v11(
    organic.id,organic.name,'Now include a service page',null,null,
    true,false,false,'organic-revision-request');
  if organic_revision.id is distinct from replayed_revision.id
    or organic_revision.id=organic.id
    or organic_revision.cloned_from_campaign_id is distinct from organic.id
    or organic_revision.campaign_kind<>'standalone_organic'
    or not organic_revision.needs_landing_page
    or organic.needs_landing_page
    or exists(select 1 from public.opportunity_links
      where campaign_id=organic_revision.id)
    or (select count(*) from public.agent_jobs
      where input_table='client_campaigns' and input_id=organic_revision.id)<>1 then
    raise exception 'Standalone revision did not preserve source and selected modules'; end if;
  begin
    perform public.create_typed_campaign_revision_v11(
      organic.id,organic.name,'Now include a service page',null,null,
      false,false,false,'organic-revision-request');
    raise exception 'Changed revision reused an existing key';
  exception when check_violation then null; end;
end $checks$;
rollback;

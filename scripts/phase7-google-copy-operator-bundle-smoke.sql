-- An exact approved Google search-copy version can enter a route-bound paid
-- operator packet. All setup and events roll back without provider effects.
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
  'paid',false,true,'google',1,0,1,now(),
  (select id from public.service_offer_versions where idempotency_key='paid-fixture'),
  'Local buyers',array['US'],25);
insert into public.opportunity_links(opportunity_id,client_id,role,campaign_id)
select o.id,o.client_id,'campaign','cccccccc-cccc-4ccc-8ccc-cccccccccccc'
  from public.market_opportunities o where o.idempotency_key='paid-operator-opportunity';
select public.set_campaign_content_spec_v7('cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  '[{"route":"paid","platform":"google_ads","media_type":"text","content_format":"single"}]'::jsonb);
insert into public.client_ideas(client_id,campaign_id,campaign_position,acquisition_route,
  title,body,media_type,content_format,source,status)
values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  'cccccccc-cccc-4ccc-8ccc-cccccccccccc',1,'paid',
  'Google search copy','Invite the local buyer to discuss the signed offer.',
  'text','single','manual','draft');
select public.approve_campaign_plan_v6('cccccccc-cccc-4ccc-8ccc-cccccccccccc');
select set_config('request.jwt.claim.role','service_role',true);
select set_config('request.jwt.claims','{"role":"service_role"}',true);

do $checks$
declare cid uuid:='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  client uuid:='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  v_run_id uuid; route_id uuid; route_version integer; work_id uuid;
  idea_id uuid; copy_id uuid; v_copy_hash text; v_job_id uuid;
  plan_hash text; spec_hash text;
  frozen public.campaign_preparation_packages_v7%rowtype;
  bundle public.paid_operator_bundles_v7%rowtype;
  same_bundle public.paid_operator_bundles_v7%rowtype;
  request_id uuid; copy_review_id uuid; integration_id uuid;
  credential_id uuid; grant_review_id uuid; read_job_id uuid; read_id uuid;
  event_id uuid; refused boolean:=false;
begin
  select public.campaign_plan_fingerprint(c),c.content_spec_hash into plan_hash,spec_hash
    from public.client_campaigns c where id=cid;
  select id into v_run_id from public.create_workflow_run(client,'campaign_sweep',
    'v7.paid.operator.fixture','paid-operator-fixture',jsonb_build_object(
      'plan_fingerprint',plan_hash,'content_spec_hash',spec_hash),
    now()+interval '1 day',cid);
  select id into idea_id from public.client_ideas where campaign_id=cid and campaign_position=1;
  perform public.add_workflow_agent_step(v_run_id,'piece1_create','{}',
    'google_search_copy','client_ideas',idea_id,'{"piece_index":1}'::jsonb);
  select id,version into route_id,route_version
    from public.ensure_campaign_route_packages_v7(cid,v_run_id) where route='paid';
  select id into work_id from public.create_delivery_work_item_v6(cid,route_id,
    null,null,'content_piece1',route_version,'content_production_factory',true,
    jsonb_build_object('workflow_run_id',v_run_id,'campaign_id',cid,
      'route_package_id',route_id,'content_spec_id',
      (select content_spec_id from public.client_campaigns where id=cid),
      'content_spec_hash',spec_hash,'piece_index',1,
      'piece',(select pieces->0 from public.campaign_content_spec_versions_v7
        where id=(select content_spec_id from public.client_campaigns where id=cid)),
      'planned_idea_id',idea_id),
    '{"artifact_kind":"google_search_copy","route":"paid","platform":"google_ads",
      "media_type":"text","content_format":"single","final_step_key":"piece1_create"}'::jsonb);
  perform public.bind_campaign_sweep_work_v7(work_id,v_run_id,'piece1','piece1_create');
  insert into public.agent_jobs(client_id,agent_key,input_table,input_id)
  values(client,'google_search_copy','client_ideas',idea_id) returning id into v_job_id;
  update public.workflow_steps set job_id=v_job_id,resolved_input_id=idea_id,
    status='needs_internal_qa' where run_id=v_run_id and step_key='piece1_create';
  update public.agent_jobs set status='completed' where id=v_job_id;
  perform public.seal_workflow_run(v_run_id);
  update public.workflow_runs set status='needs_internal_qa' where id=v_run_id;
  select id,copy_hash into copy_id,v_copy_hash
    from public.record_campaign_google_search_copy_v7(work_id,idea_id,v_job_id,
      array['Book a Local Consultation','Explore Service Options','Speak With Our Team'],
      array['Discuss your project with our local team.',
        'Book a consultation to explore the next step.'],
      'The copy invites the target buyer to discuss the signed offer.');
  select id into copy_review_id from public.approval_requests_v6
    where source_kind='google_search_copy' and source_id=copy_id::text;
  if public.google_search_copy_review_source_state_v7(copy_review_id)<>'source_held' then
    raise exception 'Copy was not held before internal QA'; end if;
  perform public.accept_ready_google_search_copy_steps_v7(20);
  perform public.sync_google_search_copy_work_v7(20);
  perform public.sync_campaign_sweep_work_v7(10);
  if public.google_search_copy_review_source_state_v7(copy_review_id)<>'pending' then
    raise exception 'QA copy did not become reviewable'; end if;
  perform set_config('request.jwt.claim.role','authenticated',true);
  perform set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true);
  perform set_config('request.jwt.claims',
    '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal2"}',true);
  perform public.decide_google_search_copy_v7(copy_id,copy_review_id,true,null);
  if not public.google_search_copy_approved_v7(copy_id) then
    raise exception 'Exact Google copy lacks human approval'; end if;
  select * into frozen from public.assemble_campaign_preparation_package_v7(cid);
  select id into request_id from public.approval_requests_v6
    where source_kind='campaign_preparation_package' and source_id=frozen.id::text;
  perform public.decide_campaign_preparation_package_v7(frozen.id,request_id,true);
  select * into bundle from public.create_paid_operator_bundle_v7(frozen.id,
    'Paid manager','Cap at 25 per day','Use campaign and page source IDs');
  select * into same_bundle from public.create_paid_operator_bundle_v7(frozen.id,
    'Paid manager','Cap at 25 per day','Use campaign and page source IDs');
  if bundle.id<>same_bundle.id or not public.paid_operator_bundle_current_v7(bundle.id)
    or jsonb_array_length(bundle.snapshot->'source'->'creative')<>1
    or bundle.snapshot->'source'->'creative'->0->>'copy_id'<>copy_id::text
    or bundle.snapshot->'source'->'creative'->0->>'copy_hash'<>v_copy_hash
    or bundle.snapshot->'source'->'route'->>'id'<>route_id::text then
    raise exception 'Exact Google bundle lost reviewed copy or route'; end if;
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
  if (select match_state from public.paid_google_operator_account_match_v7
      where bundle_id=bundle.id)<>'no_google_account_configured' then
    raise exception 'A reported Google ID was treated as observed'; end if;
  integration_id:=public.admin_store_integration_credential(
    client,'google_ads','Google fixture','fixture-oauth-token','read');
  update public.client_integrations set google_ads_customer_id='1234567890'
    where id=integration_id;
  select credential_secret_id into credential_id from public.client_integrations
    where id=integration_id;
  if (select match_state from public.paid_google_operator_account_match_v7
      where bundle_id=bundle.id)<>'no_current_account_read' then
    raise exception 'Configured Google ID without a read was treated as observed'; end if;
  request_id:=public.request_integration_grant_v6(integration_id,false);
  select id into grant_review_id from public.integration_grant_reviews_v6
    where canonical_request_id=request_id;
  perform public.decide_integration_grant_v6(grant_review_id,request_id,true);
  perform set_config('request.jwt.claim.role','service_role',true);
  perform set_config('request.jwt.claims','{"role":"service_role"}',true);
  insert into public.agent_jobs(agent_key,client_id)
    values('google_ads_read',client) returning id into read_job_id;
  select public.record_google_ads_full_read_v7(client,integration_id,credential_id,
    read_job_id,'1234567890','USD',current_date-29,current_date,'req-google-paid',
    '[{"id":"123456","name":"Fixture search campaign","status":"ENABLED",
      "channel":"SEARCH","metrics_observed":true,"impressions":"100",
      "clicks":"8","cost_micros":"1230000","conversions":"1.25"}]'::jsonb,
    '[]'::jsonb) into read_id;
  perform set_config('request.jwt.claim.role','authenticated',true);
  perform set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true);
  perform set_config('request.jwt.claims',
    '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal2"}',true);
  if not exists(select 1 from public.paid_google_operator_account_match_v7
      where bundle_id=bundle.id and match_state='metric_rows_match_reported_id'
        and read_run_id=read_id and configured_customer_id='1234567890'
        and recorded_spend=1.23 and recorded_clicks=8 and currency='USD') then
    raise exception 'Exact Google account read did not reconcile the reported ID'; end if;
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

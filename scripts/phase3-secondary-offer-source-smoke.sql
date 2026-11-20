-- Rollback-only proof that a secondary offer retains approved source evidence.
begin;
insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','00000000-0000-0000-0000-000000000000',
  'authenticated','authenticated','secondary-offer-admin@example.invalid','',now(),now());
insert into public.profiles(id,role,email)
values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','admin','secondary-offer-admin@example.invalid');
insert into public.clients(id,name,initials)
values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Secondary offer fixture','SO');
-- This rollback fixture exercises campaign source binding, not the separate
-- intelligence prerequisite gate. Allow its planner job to be queued here.
update public.agents set requires_upstream='{}' where agent_key='campaign_plan';
select set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true);
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal2"}',true);

do $checks$
declare o public.market_opportunities%rowtype;
  offer public.service_offers%rowtype;
  other_offer public.service_offers%rowtype;
  main_offer_id uuid;
  v public.service_offer_versions%rowtype;
  other_version public.service_offer_versions%rowtype;
  compiled public.service_offer_versions%rowtype;
  claim_proof public.client_proof_assets%rowtype;
  campaign public.client_campaigns%rowtype;
  manual_campaign public.client_campaigns%rowtype;
  atomic_revision public.client_campaigns%rowtype;
  typed_revision public.client_campaigns%rowtype;
  clone_id uuid; revision_id uuid; legacy_id uuid; unsourced_id uuid;
  approval_id uuid; request_id uuid; rights_request uuid; rights_id uuid;
  unsupported_version public.service_offer_versions%rowtype;
  unsupported_request_id uuid; h text; job_id uuid; sweep_job_id uuid;
  equation jsonb:=jsonb_build_object(
    'dream_outcome','A garage ready for training',
    'dream_outcome_boost','Insulation makes winter training practical',
    'likelihood','A scoped conversion based on the garage survey',
    'likelihood_mechanism','Survey and measured installation plan',
    'time_delay','Schedule after survey and materials confirmation',
    'delay_reduction_steps',jsonb_build_array('Survey before final quote'),
    'effort_sacrifice','The owner must clear the garage',
    'effort_reduction_steps',jsonb_build_array('Provide a clearing checklist'),
    'risk_reversal','Written scope before deposit',
    'bonuses','[]'::jsonb,'scarcity','','urgency','',
    'delivery_limits','Subject to a completed survey');
  mcp_created jsonb;
begin
  insert into public.market_opportunities(client_id,name,micro_market,buying_situation,
    core_problem,desired_outcome,idempotency_key,confidence)
  values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Winter garage gym',
    'Homeowners with unused garages','Preparing for winter fitness',
    'Their garage cannot be used for training','A private gym at home',
    'secondary-offer-opportunity','conversation') returning * into o;
  begin
    perform public.create_secondary_offer_v7(o.id);
    raise exception 'Unapproved opportunity created a secondary offer';
  exception when check_violation then null; end;
  update public.market_opportunities set status='validated' where id=o.id;
  insert into public.service_offers(client_id,kind,service_name)
    values(o.client_id,'main','Garage conversion') returning id into main_offer_id;
  insert into public.opportunity_links(opportunity_id,client_id,role,offer_id)
    values(o.id,o.client_id,'offer',main_offer_id);
  insert into public.opportunity_scores(opportunity_id,client_id,factors,total,classification)
    values(o.id,o.client_id,'{}'::jsonb,72,'test');
  insert into public.opportunity_awareness_stages(opportunity_id,client_id,stage,mindset,message)
    values(o.id,o.client_id,'problem_aware','Winter is coming','Convert the garage');
  approval_id := public.request_opportunity_approval_v6(o.id);
  perform public.approve_opportunity_v6(o.id,approval_id);
  h := public.opportunity_approval_hash_v6(o.id);
  offer := public.create_secondary_offer_v7(o.id);
  if not public.opportunity_approval_current_v6(o.id)
    or not public.secondary_offer_source_current_v7(offer.id)
    or not exists(select 1 from public.secondary_offer_sources_v7 s
      where s.offer_id=offer.id and s.opportunity_id=o.id and s.opportunity_hash=h)
    or not exists(select 1 from public.opportunity_links l
      where l.opportunity_id=o.id and l.offer_id=offer.id and l.role='offer')
    then raise exception 'Creating the offer broke approved source lineage'; end if;
  insert into public.client_proof_assets(client_id,media_type,title,body,source,claim,evidence)
    values(o.client_id,'text','Garage outcome','Completed within the agreed period',
      'Customer interview','Completed on time','Signed handover note')
    returning * into claim_proof;
  rights_request:=public.request_proof_rights_v6(claim_proof.id,'Signed quote release');
  select id into rights_id from public.proof_rights_requests_v6
    where canonical_request_id=rights_request;
  perform public.approve_proof_rights_v6(rights_id,rights_request);
  begin
    perform public.create_service_offer_version_v9(offer.id,o.client_id,
      'New secondary offer','Homeowners with unused garages','A garage ready for training',
      array['Insulation'],array['Gym equipment'],null,null,null,
      jsonb_build_array(jsonb_build_object('kind','general',
        'text','Completed within the agreed period')),
      equation,'missing-general-proof');
    raise exception 'A general claim without proof entered a structured offer';
  exception when invalid_parameter_value then null; end;
  unsupported_version := public.create_service_offer_version_v9(offer.id,o.client_id,
    'New secondary offer','Homeowners with unused garages','A garage ready for training',
    array['Insulation'],array['Gym equipment'],null,null,null,
    jsonb_build_array(jsonb_build_object('kind','general',
      'text','Completed within the agreed period','proof_asset_id',claim_proof.id)),
    equation,'unsupported-general-offer-version');
  select id into unsupported_request_id from public.approval_requests_v6
    where source_kind='service_offer' and source_id=unsupported_version.id::text;
  if public.service_offer_source_state_v6(unsupported_request_id)<>'source_held' then
    raise exception 'Mismatched general proof claim reached offer review'; end if;
  unsupported_version := public.create_service_offer_version_v9(offer.id,o.client_id,
    'New secondary offer','Homeowners with unused garages','A garage ready for training',
    array['Insulation'],array['Gym equipment'],null,null,null,
    jsonb_build_array(jsonb_build_object('kind','quantified',
      'text','Completed within the agreed period','proof_asset_id',claim_proof.id)),
    equation,'unsupported-secondary-offer-version');
  select id into unsupported_request_id from public.approval_requests_v6
    where source_kind='service_offer' and source_id=unsupported_version.id::text;
  if public.service_offer_source_state_v6(unsupported_request_id)<>'source_held' then
    raise exception 'Mismatched proof claim reached offer review'; end if;
  begin
    perform public.approve_service_offer_version_v6(unsupported_version.id);
    raise exception 'Mismatched proof claim was signed off';
  exception when check_violation then null; end;
  insert into public.client_proof_assets(client_id,media_type,title,body,source,claim,evidence)
    values(o.client_id,'text','Garage outcome exact','Completed within the agreed period',
      'Customer interview','Completed within the agreed period','Signed handover note')
    returning * into claim_proof;
  rights_request:=public.request_proof_rights_v6(claim_proof.id,'Signed quote release');
  select id into rights_id from public.proof_rights_requests_v6
    where canonical_request_id=rights_request;
  perform public.approve_proof_rights_v6(rights_id,rights_request);
  v := public.create_service_offer_version_v9(offer.id,o.client_id,'New secondary offer',
    'Homeowners with unused garages','A garage ready for training',
    array['Insulation'],array['Gym equipment'],null,null,null,
    jsonb_build_array(jsonb_build_object('kind','quantified',
      'text','Completed within the agreed period','proof_asset_id',claim_proof.id)),
    equation,
    'secondary-offer-version');
  select id into request_id from public.approval_requests_v6
    where source_kind='service_offer' and source_id=v.id::text;
  if public.service_offer_source_state_v6(request_id)<>'pending'
    or not exists(select 1 from public.approval_requests_v6 r
      where r.id=request_id and r.preview->'value_equation'=v.value_equation
        and r.artifact_hash=v.content_hash) then
    raise exception 'Current value-equation offer did not reach exact review'; end if;
  perform public.approve_service_offer_version_v6(v.id);
  if not exists(select 1 from public.service_offer_signoffs where offer_version_id=v.id)
    then raise exception 'Offer approval did not sign off exact version'; end if;
  begin
    update public.client_proof_assets set claim='A different garage outcome'
      where id=claim_proof.id;
    perform public.create_campaign_from_opportunity_v7(o.id,v.id,'organic');
    raise exception 'A signed offer with changed proof claim entered a new campaign';
  exception when check_violation then
    if SQLERRM not like '%offer claim no longer matches%' then raise; end if;
  end;
  other_offer := public.create_secondary_offer_v7(o.id);
  other_version := public.create_service_offer_version_v6(o.client_id,'New secondary offer',
    'Homeowners with unused garages','A second garage offer',
    array['Insulation'],array['Gym equipment'],null,null,null,'[]'::jsonb,
    'secondary-offer-other-version',other_offer.id);
  perform public.approve_service_offer_version_v6(other_version.id);
  begin
    perform public.create_campaign_from_opportunity_v7(o.id,null,'organic');
    raise exception 'Campaign creator accepted a missing exact offer version';
  exception when check_violation then null; end;
  begin
    perform public.create_campaign_from_opportunity_v7(
      o.id,'ffffffff-ffff-4fff-8fff-ffffffffffff','organic');
    raise exception 'Campaign creator accepted an unlinked offer version';
  exception when check_violation then null; end;
  begin
    perform public.create_campaign_from_opportunity_v6(o.id,'both','google');
    raise exception 'Legacy opportunity creator opened a new campaign without an exact offer';
  exception when check_violation then null; end;
  campaign := public.create_campaign_from_opportunity_v7(o.id,v.id,'organic');
  if (public.create_campaign_from_opportunity_v6(o.id,'organic')).id<>campaign.id then
    raise exception 'Legacy opportunity creator did not return the existing route'; end if;
  if campaign.offer_version_id is distinct from v.id
    or public.campaign_package_readiness_v7(campaign.id)->'blockers' @>
      '["The selected offer source changed; review a current offer before preparing this package."]'::jsonb
    then raise exception 'A current sourced offer did not bind cleanly to campaign preparation'; end if;
  clone_id:=public.clone_campaign_for_route(campaign.id,'paid','meta','Paid garage route');
  insert into public.client_campaigns(client_id,name,brief,acquisition_mode,
    runs_organic,runs_paid,cloned_from_campaign_id,offer_version_id)
    values(o.client_id,'Revised garage plan','Updated direction','organic',true,false,
      campaign.id,v.id) returning id into revision_id;
  if not exists(select 1 from public.opportunity_links l where l.role='campaign'
      and l.opportunity_id=o.id and l.campaign_id=clone_id)
    or not exists(select 1 from public.opportunity_links l where l.role='campaign'
      and l.opportunity_id=o.id and l.campaign_id=revision_id) then
    raise exception 'Cloning or revising dropped the approved opportunity lineage'; end if;
  begin
    insert into public.client_campaigns(client_id,name,brief,acquisition_mode,
      runs_organic,runs_paid,cloned_from_campaign_id)
      values(o.client_id,'Unbound revision','Bad revision','organic',true,false,campaign.id);
    raise exception 'A sourced revision accepted no signed offer';
  exception when check_violation then null; end;
  manual_campaign:=public.create_opportunity_campaign_plan_v11(
    o.client_id,o.id,v.id,'Combined garage launch','Focus on winter appointments',
    'both',false,'meta','P3','{}'::uuid[],true,false,true);
  if manual_campaign.offer_version_id is distinct from v.id
    or manual_campaign.acquisition_mode<>'both'
    or manual_campaign.campaign_kind<>'opportunity_campaign'
    or not manual_campaign.needs_landing_page or manual_campaign.needs_sales_agent
    or not manual_campaign.needs_lead_magnet
    or manual_campaign.template::text<>'P3'
    or manual_campaign.ideate_on_plan
    or position('Operator direction:' in manual_campaign.brief)=0
    or not exists(select 1 from public.opportunity_links l
      where l.opportunity_id=o.id and l.campaign_id=manual_campaign.id and l.role='campaign')
    or not exists(select 1 from public.agent_jobs j
      where j.agent_key='campaign_plan' and j.input_id=manual_campaign.id) then
    raise exception 'Atomic sourced creation lost its inputs, lineage or planner job'; end if;
  update public.client_campaigns set built_at=now(),
    objective='Book winter garage appointments',audience='Local buyers',
    content_count=2,organic_content_count=1,paid_content_count=1,
    channels=array['instagram','meta']::text[],budget=100
    where id=manual_campaign.id;
  perform public.set_campaign_content_spec_v7(manual_campaign.id,
    '[{"route":"organic","platform":"instagram","media_type":"image","content_format":"single"},
      {"route":"paid","platform":"facebook","media_type":"image","content_format":"single"}]'::jsonb);
  update public.agent_jobs set status='completed',completed_at=now()
    where agent_key='campaign_plan' and input_id=manual_campaign.id;
  perform public.approve_campaign_plan_v6(manual_campaign.id);
  sweep_job_id:=public.request_campaign_sweep_v6(manual_campaign.id);
  if public.campaign_sweep_blocker_v6(manual_campaign.id) is not null
    or sweep_job_id is null
    or (select count(*) from public.agent_jobs
      where agent_key='campaign_sweep' and input_id=manual_campaign.id)<>1 then
    raise exception 'Approved both-route opportunity plan did not queue one sweep'; end if;
  atomic_revision:=public.create_sourced_campaign_revision_v7(
    campaign.id,'Revised winter direction',v.id);
  if atomic_revision.cloned_from_campaign_id is distinct from campaign.id
    or not exists(select 1 from public.opportunity_links l
      where l.campaign_id=atomic_revision.id and l.opportunity_id=o.id and l.role='campaign')
    or not exists(select 1 from public.agent_jobs j
      where j.agent_key='campaign_plan' and j.input_id=atomic_revision.id) then
    raise exception 'Atomic plan revision lost source lineage or planner job'; end if;
  typed_revision:=public.create_typed_campaign_revision_v11(
    manual_campaign.id,manual_campaign.name,'Use an agent instead of the page',
    v.id::text,'P3',false,true,false,'typed-opportunity-revision');
  if typed_revision.id=manual_campaign.id
    or typed_revision.cloned_from_campaign_id is distinct from manual_campaign.id
    or typed_revision.campaign_kind<>'opportunity_campaign'
    or typed_revision.needs_landing_page or not typed_revision.needs_sales_agent
    or typed_revision.needs_lead_magnet
    or not exists(select 1 from public.opportunity_links l
      where l.campaign_id=typed_revision.id and l.opportunity_id=o.id and l.role='campaign')
    or (select count(*) from public.agent_jobs j
      where j.agent_key='campaign_plan' and j.input_id=typed_revision.id)<>1
    or (public.create_typed_campaign_revision_v11(
      manual_campaign.id,manual_campaign.name,'Use an agent instead of the page',
      v.id::text,'P3',false,true,false,'typed-opportunity-revision')).id
      is distinct from typed_revision.id then
    raise exception 'Typed opportunity revision lost modules, source or idempotency'; end if;
  if has_table_privilege('authenticated','public.client_campaigns','INSERT') then
    raise exception 'Authenticated callers can still bypass sourced campaign insertion'; end if;
  insert into public.client_campaigns(client_id,name,brief)
    values(o.client_id,'Historical unsourced campaign','For history only')
    returning id into legacy_id;
  insert into public.client_campaigns(client_id,name,brief,acquisition_mode,
    paid_platform,runs_organic,runs_paid)
    values(o.client_id,'Historical paid campaign without source','For history only',
      'paid','meta',false,true) returning id into unsourced_id;
  if not (public.campaign_package_readiness_v7(unsourced_id)->'blockers' @>
      '["Link one approved market opportunity before reviewing this campaign package.","Choose an exact signed secondary offer version for this opportunity."]'::jsonb)
    then raise exception 'Historical unsourced paid campaign remained package-reviewable'; end if;
  begin
    perform public.clone_campaign_for_route(legacy_id,'paid','google','Unsourced clone');
    raise exception 'A historical unsourced campaign was cloned into new work';
  exception when check_violation then null; end;
  begin
    perform public.create_sourced_campaign_plan_v7(o.client_id,o.id,v.id,
      'Duplicate combined launch','Duplicate','both',true,'meta');
    raise exception 'A second campaign reused the same opportunity route';
  exception when check_violation then null; end;
  begin
    perform public.create_sourced_campaign_plan_v7(o.client_id,o.id,v.id,
      'Invalid pillar campaign','Bad pillar','paid',true,'google',null,
      array['ffffffff-ffff-4fff-8fff-ffffffffffff'::uuid]);
    raise exception 'A foreign or missing pillar entered the campaign transaction';
  exception when check_violation then null; end;
  if exists(select 1 from public.client_campaigns c
    join public.opportunity_links l on l.campaign_id=c.id and l.role='campaign'
    where l.opportunity_id=o.id and c.acquisition_mode='paid' and c.paid_platform='google') then
    raise exception 'The failed pillar transaction left a campaign behind'; end if;
  insert into public.agent_jobs(agent_key,client_id,status,completed_at)
    values('offer_strategy',o.client_id,'completed',now());
  job_id := public.request_offer_compile_v6(o.client_id,'secondary','micro_niche',o.id);
  perform set_config('request.jwt.claim.role','service_role',true);
  perform set_config('request.jwt.claims','{"role":"service_role"}',true);
  compiled := public.create_compiled_secondary_offer_v7(o.client_id,o.id,h,job_id,
    'Winter conversion','Homeowners with unused garages','A warmer garage',
    array['Insulation'],array['Gym equipment'],job_id::text||':1');
  if (public.create_compiled_secondary_offer_v7(o.client_id,o.id,h,job_id,
    'Winter conversion','Homeowners with unused garages','A warmer garage',
    array['Insulation'],array['Gym equipment'],job_id::text||':1')).id<>compiled.id
    then raise exception 'Compiler retry created a duplicate offer'; end if;
  insert into public.mcp_bot_clients(bot_id,client_id)
    values('bot_marketing',o.client_id);
  mcp_created:=public.mcp_campaign_create_v7('bot_marketing',o.client_id,o.id,v.id,
    'Google garage campaign','Focus on winter leads','paid','google',
    'source-request-1','source-execution-1');
  if (mcp_created->'campaign'->>'opportunity_id')::uuid is distinct from o.id
    or (mcp_created->'campaign'->>'offer_version_id')::uuid is distinct from v.id
    or not exists(select 1 from public.agent_jobs j
      where j.id=(mcp_created->>'job_id')::uuid and j.agent_key='campaign_plan') then
    raise exception 'MCP sourced creation lost its source or planner job'; end if;
  if coalesce((public.mcp_campaign_create_v7('bot_marketing',o.client_id,o.id,v.id,
    'Google garage campaign','Focus on winter leads','paid','google',
    'source-request-1','source-execution-1')->>'replayed')::boolean,false) is not true then
    raise exception 'MCP source request replay was not idempotent'; end if;
  begin
    perform public.mcp_campaign_create_v6('bot_marketing',o.client_id,'Legacy bypass',
      'No source','paid','google','legacy-request-1','legacy-execution-1',v.id);
    raise exception 'Legacy MCP function created a new unsourced campaign';
  exception when check_violation then null; end;
  begin
    perform public.mcp_campaign_execution('bot_marketing',o.client_id,'create',
      p_name=>'Legacy bypass',p_brief=>'No source',
      p_request_id=>'legacy-request-2',p_execution_id=>'legacy-execution-2');
    raise exception 'Unversioned MCP function created a new unsourced campaign';
  exception when check_violation then null; end;
  perform set_config('request.jwt.claim.role','authenticated',true);
  perform set_config('request.jwt.claims',
    '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal2"}',true);
  update public.client_proof_assets set usage_rights='restricted'
    where id=claim_proof.id;
  if not (public.campaign_package_readiness_v7(campaign.id)->'blockers' @>
      '["A quantified offer claim has lost current cleared proof."]'::jsonb) then
    raise exception 'Revoked quantified proof left the signed campaign package reviewable'; end if;
  update public.opportunity_awareness_stages set message='A changed buyer message'
    where opportunity_id=o.id;
  if public.opportunity_approval_current_v6(o.id)
    or public.secondary_offer_source_current_v7(offer.id)
    or public.service_offer_source_state_v6(request_id)<>'source_held' then
    raise exception 'Changed evidence did not hold the secondary offer'; end if;
  if not (public.campaign_package_readiness_v7(campaign.id)->'blockers' @>
      '["The selected offer source changed; review a current offer before preparing this package."]'::jsonb)
    then raise exception 'Changed opportunity evidence left campaign package reviewable'; end if;
  begin
    perform public.create_campaign_from_opportunity_v7(o.id,v.id,'paid','meta');
    raise exception 'Campaign creator accepted stale opportunity and offer evidence';
  exception when check_violation then null; end;
  begin
    perform public.clone_campaign_for_route(campaign.id,'both','meta','Stale combined clone');
    raise exception 'Clone accepted stale opportunity evidence';
  exception when check_violation then null; end;
  begin
    perform public.create_sourced_campaign_plan_v7(o.client_id,o.id,v.id,
      'Stale Google launch','Stale','paid',true,'google');
    raise exception 'Campaign Factory accepted stale approved evidence';
  exception when check_violation then null; end;
  begin
    perform public.request_offer_compile_v6(o.client_id,'secondary','micro_niche',o.id);
    raise exception 'Stale opportunity queued an offer compiler';
  exception when check_violation then null; end;
end $checks$;
rollback;

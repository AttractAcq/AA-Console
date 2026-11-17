-- Rollback-only proof that a secondary offer retains approved source evidence.
begin;
insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','00000000-0000-0000-0000-000000000000',
  'authenticated','authenticated','secondary-offer-admin@example.invalid','',now(),now());
insert into public.profiles(id,role,email)
values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','admin','secondary-offer-admin@example.invalid');
insert into public.clients(id,name,initials)
values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Secondary offer fixture','SO');
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
  campaign public.client_campaigns%rowtype;
  approval_id uuid; request_id uuid; h text; job_id uuid;
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
  v := public.create_service_offer_version_v6(o.client_id,'New secondary offer',
    'Homeowners with unused garages','A garage ready for training',
    array['Insulation'],array['Gym equipment'],null,null,null,'[]'::jsonb,
    'secondary-offer-version',offer.id);
  select id into request_id from public.approval_requests_v6
    where source_kind='service_offer' and source_id=v.id::text;
  if public.service_offer_source_state_v6(request_id)<>'pending' then
    raise exception 'Sourced offer did not reach review'; end if;
  perform public.approve_service_offer_version_v6(v.id);
  if not exists(select 1 from public.service_offer_signoffs where offer_version_id=v.id)
    then raise exception 'Offer approval did not sign off exact version'; end if;
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
  campaign := public.create_campaign_from_opportunity_v7(o.id,v.id,'organic');
  if campaign.offer_version_id is distinct from v.id
    or public.campaign_package_readiness_v7(campaign.id)->'blockers' @>
      '["The selected offer source changed; review a current offer before preparing this package."]'::jsonb
    then raise exception 'A current sourced offer did not bind cleanly to campaign preparation'; end if;
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
  perform set_config('request.jwt.claim.role','authenticated',true);
  perform set_config('request.jwt.claims',
    '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal2"}',true);
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
    perform public.request_offer_compile_v6(o.client_id,'secondary','micro_niche',o.id);
    raise exception 'Stale opportunity queued an offer compiler';
  exception when check_violation then null; end;
end $checks$;
rollback;

-- Rollback-only check that the Build source and chosen service name are one write.
begin;
insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','00000000-0000-0000-0000-000000000000',
  'authenticated','authenticated','manual-offer-admin@example.invalid','',now(),now());
insert into public.profiles(id,role,email)
values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','admin','manual-offer-admin@example.invalid');
insert into public.clients(id,name,initials)
values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Manual offer fixture','MF');
select set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true);
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal2"}',true);

do $checks$
declare t record; source_record uuid; main public.service_offers%rowtype;
  targeted public.service_offers%rowtype; opportunity public.market_opportunities%rowtype;
  request_id uuid; before_count integer;
begin
  select count(*) into before_count from public.service_offers
    where client_id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  begin
    perform public.create_named_main_offer_v9(
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Garage conversion');
    raise exception 'Unreviewed Strategy created a named main offer';
  exception when check_violation then null; end;
  if (select count(*) from public.service_offers
      where client_id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')<>before_count then
    raise exception 'Failed main-source check left an offer shell'; end if;
  for t in select item_key,item_type,title,display_order from public.record_templates
    where domain='offer_strategy' order by display_order,item_key loop
    insert into public.client_agent_records(client_id,domain,item_key,item_type,title,
      display_order,body)
    values('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','offer_strategy',
      t.item_key,t.item_type,t.title,t.display_order,'Verified service context')
    returning id into source_record;
    perform public.review_model_section_v7(source_record,'Owner interview',current_date,
      'supported','Verified against source');
  end loop;
  main:=public.create_named_main_offer_v9(
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','  Garage conversion  ');
  if main.service_name<>'Garage conversion' or main.kind<>'main'
    or not public.main_offer_source_current_v7(main.id) then
    raise exception 'Named baseline service lost its current Strategy source'; end if;
  insert into public.agent_jobs(agent_key,client_id,status,created_by)
    values('offer_strategy',main.client_id,'completed',auth.uid());
  request_id:=public.request_named_offer_compile_v9(
    main.client_id,'main',null,'  Garage conversion  ');
  if not exists(select 1 from public.agent_jobs j where j.id=request_id
    and j.client_id=main.client_id and j.params->>'service_name'='Garage conversion'
    and j.params->>'kind'='main' and j.params->>'source'='strategy') then
    raise exception 'Main compiler job lost the selected service or source'; end if;
  begin
    perform public.create_named_main_offer_v9(main.client_id,' ');
    raise exception 'Blank service name was accepted';
  exception when invalid_parameter_value then null; end;

  insert into public.market_opportunities(client_id,name,micro_market,buying_situation,
    core_problem,desired_outcome,idempotency_key,confidence)
  values(main.client_id,'Winter garage gym','Unused garages','Preparing for winter fitness',
    'No usable exercise space','A private gym','manual-offer-opp','conversation')
  returning * into opportunity;
  begin
    perform public.create_named_secondary_offer_v9(opportunity.id,'Garage conversion');
    raise exception 'Unapproved opportunity created a named offer';
  exception when check_violation then null; end;
  update public.market_opportunities set status='validated' where id=opportunity.id;
  insert into public.opportunity_links(opportunity_id,client_id,role,offer_id)
    values(opportunity.id,main.client_id,'offer',main.id);
  insert into public.opportunity_scores(opportunity_id,client_id,factors,total,classification)
    values(opportunity.id,main.client_id,'{}'::jsonb,72,'test');
  insert into public.opportunity_awareness_stages(opportunity_id,client_id,stage,mindset,message)
    values(opportunity.id,main.client_id,'problem_aware','Winter is coming','Convert the garage');
  request_id:=public.request_opportunity_approval_v6(opportunity.id);
  perform public.approve_opportunity_v6(opportunity.id,request_id);
  targeted:=public.create_named_secondary_offer_v9(opportunity.id,'  Winter garage gym  ');
  if targeted.service_name<>'Winter garage gym' or targeted.kind<>'secondary'
    or not public.secondary_offer_source_current_v7(targeted.id)
    or not exists(select 1 from public.opportunity_links l
      where l.opportunity_id=opportunity.id and l.offer_id=targeted.id and l.role='offer') then
    raise exception 'Named targeted offer lost its current opportunity source'; end if;
  request_id:=public.request_named_offer_compile_v9(
    main.client_id,'secondary',opportunity.id,'  Winter garage gym  ');
  if not exists(select 1 from public.agent_jobs j where j.id=request_id
    and j.client_id=main.client_id and j.input_id=opportunity.id
    and j.params->>'service_name'='Winter garage gym'
    and j.params->>'kind'='secondary' and j.params->>'source'='micro_niche'
    and j.params->>'opportunity_hash'=public.opportunity_approval_hash_v6(opportunity.id)) then
    raise exception 'Targeted compiler job lost the selected service or approval'; end if;
end $checks$;
rollback;

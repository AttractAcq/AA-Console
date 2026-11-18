-- Rollback-only proof that a strategy draft saves all working-out and its
-- proposal together, or leaves the previous card and attributes untouched.
begin;
insert into public.clients(id,name,initials)
values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Atomic strategy fixture','AS');
insert into public.market_opportunities(id,client_id,name,micro_market,buying_situation,
  core_problem,desired_outcome,idempotency_key,confidence)
values ('cccccccc-cccc-4ccc-8ccc-cccccccccccc','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  'Winter garage gym','Homeowners with unused garages','Preparing for winter fitness',
  'No place to train','A private gym at home','atomic-strategy','conversation');
select set_config('request.jwt.claim.role','service_role',true);

do $checks$
declare
  cid uuid:='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  client uuid:='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  j uuid;
  old_card uuid;
  new_card uuid;
  h text;
  attrs jsonb:='{"problem":["No training space"],"outcome":["A home gym"],"motivation":[],"trigger":[],"objection":["Cost"]}'::jsonb;
  good_stages jsonb:='[{"stage":"problem_aware","mindset":"Ready to act","message":"Plan the space"}]'::jsonb;
  fields jsonb:='{"core_problem":"No space","desired_outcome":"Home gym"}'::jsonb;
  refused boolean;
begin
  insert into public.agent_jobs(agent_key,client_id,input_table,input_id)
    values('opportunity_strategise',client,'market_opportunities',cid)
    returning id into j;
  insert into public.opportunity_proposals(opportunity_id,client_id,kind,payload,rationale,proposed_by)
    values(cid,client,'strategy',jsonb_build_object('fields',fields),
      'Earlier draft','fixture') returning id into old_card;
  h:=public.opportunity_strategy_input_hash_v7(cid);
  refused:=false;
  begin
    perform public.save_opportunity_strategy_draft_v7(
      cid,client,j,h,attrs,
      '[{"stage":"invalid","mindset":"Ready","message":"Plan"}]'::jsonb,
      fields,'New draft','opportunity_strategise');
  exception when check_violation then refused:=true; end;
  if not refused or exists(select 1 from public.opportunity_attributes where opportunity_id=cid)
    or exists(select 1 from public.opportunity_awareness_stages where opportunity_id=cid)
    or not exists(select 1 from public.opportunity_proposals
      where id=old_card and resolution='open') then
    raise exception 'Failed strategy save left partial working-out or lost the old card';
  end if;

  new_card:=public.save_opportunity_strategy_draft_v7(
    cid,client,j,h,attrs,good_stages,fields,'New draft','opportunity_strategise');
  if new_card is null or not exists(select 1 from public.opportunity_proposals
      where id=old_card and resolution='superseded')
    or not exists(select 1 from public.opportunity_proposals
      where id=new_card and resolution='open')
    or not exists(select 1 from public.opportunity_attributes
      where opportunity_id=cid and kind='objection' and body='Cost')
    or not exists(select 1 from public.opportunity_awareness_stages
      where opportunity_id=cid and stage='problem_aware' and message='Plan the space') then
    raise exception 'Atomic strategy save did not commit the whole draft';
  end if;
  if public.save_opportunity_strategy_draft_v7(
      cid,client,j,h,attrs,good_stages,fields,'New draft','opportunity_strategise')
      is distinct from new_card then
    raise exception 'Job replay created a second strategy card';
  end if;

  insert into public.agent_jobs(agent_key,client_id,input_table,input_id)
    values('opportunity_strategise',client,'market_opportunities',cid)
    returning id into j;
  h:=public.opportunity_strategy_input_hash_v7(cid);
  insert into public.client_agent_records(client_id,domain,item_key,title,body)
    values(client,'market','strategy-source','Demand signal','Demand has changed');
  refused:=false;
  begin
    perform public.save_opportunity_strategy_draft_v7(
      cid,client,j,h,attrs,good_stages,fields,'Stale draft','opportunity_strategise');
  exception when check_violation then refused:=true; end;
  if not refused or not exists(select 1 from public.opportunity_proposals
      where id=new_card and resolution='open') then
    raise exception 'Changed strategy source was allowed to replace the review card';
  end if;

  perform set_config('request.jwt.claim.role','authenticated',true);
  refused:=false;
  begin
    perform public.save_opportunity_strategy_draft_v7(
      cid,client,j,h,attrs,good_stages,fields,'Browser draft','opportunity_strategise');
  exception when insufficient_privilege then refused:=true; end;
  if not refused then raise exception 'Browser identity saved a strategy draft'; end if;
end $checks$;
rollback;

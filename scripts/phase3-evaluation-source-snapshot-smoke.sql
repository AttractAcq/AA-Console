-- Rollback-only proof that a human cannot score an old agent proposal after
-- the opportunity, rubric or Intelligence read changes.
begin;
insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','00000000-0000-0000-0000-000000000000',
  'authenticated','authenticated','evaluation-snapshot@example.invalid','',now(),now());
insert into public.profiles(id,role,email)
values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','admin','evaluation-snapshot@example.invalid');
insert into public.clients(id,name,initials)
values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Evaluation snapshot fixture','ES');
insert into public.market_opportunities(id,client_id,name,micro_market,buying_situation,
  core_problem,desired_outcome,idempotency_key,confidence)
values ('cccccccc-cccc-4ccc-8ccc-cccccccccccc','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  'Winter garage gym','Homeowners with unused garages','Preparing for winter fitness',
  'No place to train','A private gym at home','evaluation-snapshot','conversation');
select set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true);
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal2"}',true);

do $checks$
declare
  cid uuid:='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  h text;
  factors jsonb;
  p uuid;
  saved uuid;
  j uuid;
  refused boolean;
begin
  select jsonb_object_agg(f.factor,50) into factors from public.opportunity_score_factors f;
  h:=public.opportunity_evaluation_input_hash_v7(cid);
  if h !~ '^[0-9a-f]{64}$' then raise exception 'Input fingerprint unavailable'; end if;
  insert into public.opportunity_proposals(opportunity_id,client_id,kind,payload,rationale,proposed_by)
    values(cid,'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','score',
      jsonb_build_object('factors',factors,'input_hash',h),'Current evidence','fixture')
    returning id into p;
  perform public.accept_opportunity_score_proposal_v6(p);
  if not exists(select 1 from public.opportunity_proposals where id=p and resolution='accepted')
    then raise exception 'Current proposal was not accepted'; end if;

  insert into public.opportunity_proposals(opportunity_id,client_id,kind,payload,rationale,proposed_by)
    values(cid,'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','score',
      jsonb_build_object('factors',factors,'input_hash',
        public.opportunity_evaluation_input_hash_v7(cid)),'Old evidence','fixture')
    returning id into p;
  insert into public.client_agent_records(client_id,domain,item_key,title,body)
    values('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','market','evaluation-snapshot',
      'Updated market evidence','Different demand signal');
  refused:=false;
  begin
    perform public.accept_opportunity_score_proposal_v6(p);
  exception when check_violation then refused:=true; end;
  if not refused or exists(select 1 from public.opportunity_proposals where id=p and resolution='accepted')
    then raise exception 'Changed Intelligence was accepted as the old score'; end if;
  perform public.reject_opportunity_proposal_v6(p,'The source changed');
  if not exists(select 1 from public.opportunity_events
      where opportunity_id=cid and event='proposal_rejected' and detail='The source changed')
    then raise exception 'Reasoned rejection did not reach the event log'; end if;

  insert into public.opportunity_proposals(opportunity_id,client_id,kind,payload,rationale,proposed_by)
    values(cid,'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','score',
      jsonb_build_object('factors',factors),'Legacy proposal','fixture')
    returning id into p;
  refused:=false;
  begin
    perform public.accept_opportunity_score_proposal_v6(p);
  exception when check_violation then refused:=true; end;
  if not refused then raise exception 'Unfingerprinted historical proposal was accepted'; end if;

  insert into public.agent_jobs(agent_key,client_id,input_table,input_id)
    values('opportunity_evaluate','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      'market_opportunities',cid) returning id into j;
  perform set_config('request.jwt.claim.role','service_role',true);
  refused:=false;
  begin
    perform public.save_opportunity_score_proposal_v7(cid,
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',j,
      jsonb_build_object('factors',factors,'input_hash',
        public.opportunity_evaluation_input_hash_v7(cid)),
      'New evidence',repeat('x',121));
  exception when check_violation then refused:=true; end;
  if not refused or not exists(select 1 from public.opportunity_proposals
      where id=p and resolution='open') then
    raise exception 'Failed new proposal superseded the existing review card';
  end if;
  saved:=public.save_opportunity_score_proposal_v7(cid,
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',j,
    jsonb_build_object('factors',factors,'input_hash',
      public.opportunity_evaluation_input_hash_v7(cid)),
    'New evidence','opportunity_evaluate');
  if saved is null or not exists(select 1 from public.opportunity_proposals
      where id=p and resolution='superseded') or not exists(
      select 1 from public.opportunity_proposals where id=saved and resolution='open')
    then raise exception 'Atomic proposal replacement did not commit'; end if;
  if public.save_opportunity_score_proposal_v7(cid,
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',j,
    jsonb_build_object('factors',factors,'input_hash',
      public.opportunity_evaluation_input_hash_v7(cid)),
    'New evidence','opportunity_evaluate') is distinct from saved
    then raise exception 'Job replay created a second review card'; end if;
  perform set_config('request.jwt.claim.role','authenticated',true);
  refused:=false;
  begin
    perform public.save_opportunity_score_proposal_v7(cid,
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',j,
      jsonb_build_object('factors',factors,'input_hash',
        public.opportunity_evaluation_input_hash_v7(cid)),
      'New evidence','opportunity_evaluate');
  exception when insufficient_privilege then refused:=true; end;
  if not refused then raise exception 'Browser identity saved a score proposal'; end if;
end $checks$;
rollback;

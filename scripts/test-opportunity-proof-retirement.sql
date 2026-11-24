-- Rollback-only regression for review, readiness and exact decision provenance.
begin;
insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','00000000-0000-0000-0000-000000000000',
  'authenticated','authenticated','opportunity-admin@example.invalid','',now(),now()),
  ('cccccccc-cccc-4ccc-8ccc-cccccccccccc','00000000-0000-0000-0000-000000000000',
  'authenticated','authenticated','opportunity-outsider@example.invalid','',now(),now());
insert into public.profiles(id,role,email) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','admin','opportunity-admin@example.invalid'),
  ('cccccccc-cccc-4ccc-8ccc-cccccccccccc','client','opportunity-outsider@example.invalid');
insert into public.clients(id,name,initials) values
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Opportunity fixture','OF');
select set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true);
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal1"}',true);

do $checks$
declare o public.market_opportunities%rowtype;
  offer_id uuid;
  req_id uuid;
  receipt public.opportunity_proof_requirements%rowtype;
  original_preview jsonb;
begin
  insert into public.service_offers(client_id,service_name)
    values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Garage conversion')
    returning id into offer_id;
  insert into public.market_opportunities(client_id,name,micro_market,buying_situation,
    core_problem,desired_outcome,idempotency_key,confidence)
    values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Winter garage gym',
      'Homeowners with unused garages','Preparing for winter fitness',
      'Their garage cannot be used for training','A private gym at home',
      'winter-garage','conversation') returning * into o;
  update public.market_opportunities set status = 'validated' where id = o.id;
  insert into public.opportunity_links(opportunity_id,client_id,role,offer_id)
    values (o.id,o.client_id,'offer',offer_id);
  insert into public.opportunity_scores(opportunity_id,client_id,factors,total,classification)
    values (o.id,o.client_id,'{}'::jsonb,72,'test');
  insert into public.opportunity_awareness_stages(opportunity_id,client_id,stage,mindset,message)
    values (o.id,o.client_id,'problem_aware','Winter is coming','Convert the garage');
  if exists (select 1 from public.opportunity_readiness
    where opportunity_id = o.id and blocker is not null) then
    raise exception 'Fixture opportunity is not ready'; end if;
  req_id := public.require_opportunity_proof_v6(o.id, 'Show completed installation');
  original_preview := public.opportunity_approval_preview_v6(o.id);
  if public.opportunity_proof_ready_v6(o.id) or (select open_proof_gaps from public.opportunity_readiness where opportunity_id=o.id) <> 1 then
    raise exception 'Open requirement did not block'; end if;
  perform set_config('request.jwt.claim.sub','cccccccc-cccc-4ccc-8ccc-cccccccccccc',true);
  perform set_config('request.jwt.claims','{"sub":"cccccccc-cccc-4ccc-8ccc-cccccccccccc","role":"authenticated","aal":"aal1"}',true);
  begin
    perform public.retire_opportunity_proof_requirement(req_id,'Outside scope');
    raise exception 'Unassigned reviewer retired a requirement';
  exception when insufficient_privilege then null; end;
  if has_function_privilege('anon','public.retire_opportunity_proof_requirement(uuid,text)','EXECUTE')
    or has_function_privilege('service_role','public.retire_opportunity_proof_requirement(uuid,text)','EXECUTE')
    or has_column_privilege('service_role','public.opportunity_proof_requirements','retired_by','UPDATE') then
    raise exception 'Retirement writes accessible outside the reviewer path'; end if;
  perform set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true);
  perform set_config('request.jwt.claims','{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal1"}',true);
  begin
    perform public.retire_opportunity_proof_requirement(req_id,'  ');
    raise exception 'Missing reason accepted';
  exception when invalid_parameter_value then null; end;
  perform public.retire_opportunity_proof_requirement(req_id,'Installation is outside the planning offer.');
  select * into strict receipt from public.opportunity_proof_requirements where id=req_id;
  perform public.retire_opportunity_proof_requirement(req_id,'Installation is outside the planning offer.');
  if receipt.retired_by is distinct from auth.uid() or receipt.retired_at is null
    or receipt.retirement_reason is distinct from 'Installation is outside the planning offer.'
    or receipt.requirement <> 'Show completed installation' or receipt.proof_id is not null or receipt.satisfied_at is not null
    or (select to_jsonb(r) from public.opportunity_proof_requirements r where r.id=req_id) <> to_jsonb(receipt) then
    raise exception 'Retirement or replay lost the original decision'; end if;
  begin
    perform public.retire_opportunity_proof_requirement(req_id,'Second reason');
    raise exception 'Overwrote the first decision';
  exception when check_violation then null; end;
  if not public.opportunity_proof_ready_v6(o.id)
    or (select open_proof_gaps from public.opportunity_readiness where opportunity_id=o.id) <> 0
    or public.opportunity_approval_preview_v6(o.id) = original_preview
    or public.opportunity_approval_preview_v6(o.id)#>>'{proof_requirements,0,retirement_reason}' is distinct from receipt.retirement_reason then
    raise exception 'Readiness or exact review preview missed retirement'; end if;
  if public.request_opportunity_approval_v6(o.id) is null then raise exception 'Retired requirement still blocks the Inbox'; end if;
end $checks$;
rollback;

-- Rollback-only proof of the exact evaluated-opportunity decision boundary.
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
update public.agents set requires_upstream='{}' where agent_key='campaign_plan';
select set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true);
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal1"}',true);

do $checks$
declare o public.market_opportunities%rowtype;
  offer_id uuid;
  secondary_offer public.service_offers%rowtype;
  offer_version public.service_offer_versions%rowtype;
  request_id uuid;
  new_request uuid;
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
  insert into public.opportunity_proof_requirements(opportunity_id,client_id,requirement)
    values (o.id,o.client_id,'A cleared customer outcome');
  begin
    perform public.request_opportunity_approval_v6(o.id);
    raise exception 'Opportunity with missing proof requested approval';
  exception when check_violation then null; end;
  delete from public.opportunity_proof_requirements where opportunity_id = o.id;
  begin
    update public.market_opportunities set status = 'approved' where id = o.id;
    raise exception 'Direct AAL1 approval succeeded';
  exception when insufficient_privilege then null; end;
  request_id := public.request_opportunity_approval_v6(o.id);
  if public.request_opportunity_approval_v6(o.id) <> request_id
    or public.opportunity_approval_source_state_v6(request_id) <> 'pending'
    or (select status from public.approval_inbox_v6 where id = request_id) <> 'pending'
    then raise exception 'The exact request was not deduplicated and registered'; end if;
  begin
    perform public.approve_opportunity_v6(o.id,request_id);
    raise exception 'AAL1 approved opportunity';
  exception when insufficient_privilege then null; end;
  perform set_config('request.jwt.claim.sub','cccccccc-cccc-4ccc-8ccc-cccccccccccc',true);
  perform set_config('request.jwt.claims',
    '{"sub":"cccccccc-cccc-4ccc-8ccc-cccccccccccc","role":"authenticated","aal":"aal2"}',true);
  begin
    perform public.approve_opportunity_v6(o.id,request_id);
    raise exception 'Wrong client approved opportunity';
  exception when insufficient_privilege then null; end;
  perform set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true);
  perform set_config('request.jwt.claims',
    '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal2"}',true);
  begin
    update public.market_opportunities set status = 'approved' where id = o.id;
    raise exception 'Direct AAL2 approval succeeded without Inbox';
  exception when insufficient_privilege then null; end;
  update public.opportunity_awareness_stages set message = 'A changed message'
    where opportunity_id = o.id;
  if public.opportunity_approval_source_state_v6(request_id) <> 'superseded' then
    raise exception 'A changed strategy did not stale the request'; end if;
  begin
    perform public.approve_opportunity_v6(o.id,request_id);
    raise exception 'Stale opportunity was approved';
  exception when check_violation then null; end;
  new_request := public.request_opportunity_approval_v6(o.id);
  if new_request = request_id then raise exception 'Stale request epoch was reused'; end if;
  perform public.approve_opportunity_v6(o.id,new_request);
  if (select status from public.approval_inbox_v6 where id = new_request) <> 'approved'
    or not public.opportunity_approval_current_v6(o.id) then
    raise exception 'Source and Inbox approval diverged'; end if;
  secondary_offer:=public.create_secondary_offer_v7(o.id);
  offer_version:=public.create_service_offer_version_v6(o.client_id,
    secondary_offer.service_name,'Homeowners with unused garages','A garage ready for training',
    array['Insulation'],array['Gym equipment'],null,null,null,'[]'::jsonb,
    'opportunity-approval-fixture-offer',secondary_offer.id);
  perform public.approve_service_offer_version_v6(offer_version.id);
  perform public.create_campaign_from_opportunity_v7(o.id,offer_version.id,'organic');
  if not public.opportunity_approval_current_v6(o.id) then
    raise exception 'A downstream campaign link invalidated its source approval'; end if;
  update public.opportunity_awareness_stages set message = 'Changed after approval'
    where opportunity_id = o.id;
  if public.opportunity_approval_current_v6(o.id)
    or public.opportunity_approval_source_state_v6(new_request) <> 'superseded' then
    raise exception 'A changed approved opportunity remained campaign-ready'; end if;
  begin
    perform public.create_campaign_from_opportunity_v7(o.id,offer_version.id,'organic');
    raise exception 'Stale opportunity reused a campaign without a current decision';
  exception when check_violation then null; end;
  perform public.set_opportunity_status_v6(o.id,'paused','Recheck changed strategy');
  if (select approved_request_id from public.market_opportunities where id = o.id) is not null
    then raise exception 'Paused opportunity retained campaign approval'; end if;
  perform public.set_opportunity_status_v6(o.id,'validated');
  request_id := public.request_opportunity_approval_v6(o.id);
  if request_id = new_request then
    raise exception 'Resumed opportunity reused its old approval epoch'; end if;
  perform public.reject_opportunity_approval_v6(o.id,request_id,'Insufficient buyer evidence');
  if (select status from public.approval_inbox_v6 where id = request_id) <> 'rejected'
    then raise exception 'Rejection did not reach the Inbox'; end if;
  if public.request_opportunity_approval_v6(o.id) = request_id then
    raise exception 'Rejected opportunity reused its old request'; end if;
end $checks$;
rollback;

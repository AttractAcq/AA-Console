-- Rollback-only separate activation decision for an approved opportunity.
begin;
insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','00000000-0000-0000-0000-000000000000',
 'authenticated','authenticated','activation-admin@example.invalid','',now(),now());
insert into public.profiles(id,role,email) values
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','admin','activation-admin@example.invalid');
insert into public.clients(id,name,initials) values
 ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Activation fixture','AF');
-- Campaign-source setup in this rollback fixture does not exercise the
-- separate Intelligence prerequisite for the planner worker.
update public.agents set requires_upstream='{}' where agent_key='campaign_plan';
select set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true);
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claims',
 '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal1"}',true);
do $checks$
declare o public.market_opportunities%rowtype; offer_id uuid;
 secondary_offer public.service_offers%rowtype;
 offer_version public.service_offer_versions%rowtype;
 approval_id uuid; activation_id uuid; newer_id uuid; source_id uuid;
begin
 insert into public.service_offers(client_id,service_name)
  values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Garage conversion') returning id into offer_id;
 insert into public.market_opportunities(client_id,name,micro_market,buying_situation,
  core_problem,desired_outcome,idempotency_key,confidence)
  values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Winter garage gym',
   'Homeowners with unused garages','Preparing for winter fitness',
   'Their garage cannot be used for training','A private gym at home',
   'winter-garage-activation','conversation') returning * into o;
 update public.market_opportunities set status='validated' where id=o.id;
 insert into public.opportunity_links(opportunity_id,client_id,role,offer_id)
  values(o.id,o.client_id,'offer',offer_id);
 insert into public.opportunity_scores(opportunity_id,client_id,factors,total,classification)
  values(o.id,o.client_id,'{}'::jsonb,72,'test');
 insert into public.opportunity_awareness_stages(opportunity_id,client_id,stage,mindset,message)
  values(o.id,o.client_id,'problem_aware','Winter is coming','Convert the garage');
 approval_id:=public.request_opportunity_approval_v6(o.id);
 perform set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal2"}',true);
 perform public.approve_opportunity_v6(o.id,approval_id);
 if not public.opportunity_approval_current_v6(o.id) then
  raise exception 'Existing opportunity approval changed when activation columns were added'; end if;
 secondary_offer:=public.create_secondary_offer_v7(o.id);
 offer_version:=public.create_service_offer_version_v6(o.client_id,
  secondary_offer.service_name,'Homeowners with unused garages',
  'A garage ready for training',array['Insulation'],array['Gym equipment'],
  null,null,null,'[]'::jsonb,'activation-fixture-offer',secondary_offer.id);
 perform public.approve_service_offer_version_v6(offer_version.id);
 begin
  perform public.set_opportunity_status_v6(o.id,'active');
  raise exception 'Direct active status bypassed activation Inbox';
 exception when insufficient_privilege then null; end;
 activation_id:=public.request_opportunity_activation_v6(o.id,'Start this buying situation');
 select id into source_id from public.opportunity_activation_requests_v6 where canonical_request_id=activation_id;
 if activation_id is null or public.request_opportunity_activation_v6(o.id,'Start this buying situation')<>activation_id
  or (select status from public.approval_inbox_v6 where id=activation_id)<>'pending'
  then raise exception 'Activation request was not pending and deduplicated'; end if;
 perform set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal1"}',true);
 begin
  perform public.decide_opportunity_activation_inbox_v6(source_id,activation_id,true);
  raise exception 'AAL1 activated opportunity';
 exception when insufficient_privilege then null; end;
 perform set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal2"}',true);
 perform public.create_campaign_from_opportunity_v7(o.id,offer_version.id,'organic');
 if public.opportunity_activation_source_state_v6(activation_id)<>'superseded'
  or not public.opportunity_approval_current_v6(o.id)
  then raise exception 'New campaign did not stale activation while preserving opportunity approval'; end if;
 begin
  perform public.decide_opportunity_activation_inbox_v6(source_id,activation_id,true);
  raise exception 'Stale campaign package activated opportunity';
 exception when check_violation then null; end;
 newer_id:=public.request_opportunity_activation_v6(o.id,'Start this buying situation');
 if newer_id=activation_id then raise exception 'Stale activation epoch was reused'; end if;
 select id into source_id from public.opportunity_activation_requests_v6 where canonical_request_id=newer_id;
 perform public.decide_opportunity_activation_inbox_v6(source_id,newer_id,true);
 if (select status from public.market_opportunities where id=o.id)<>'active'
  or (select status from public.approval_inbox_v6 where id=newer_id)<>'approved'
  or not public.opportunity_approval_current_v6(o.id)
  or public.opportunity_activation_source_state_v6(newer_id)<>'source_decided'
  then raise exception 'Exact activation did not persist independently of approval'; end if;
 perform public.set_opportunity_status_v6(o.id,'learning','First campaign results');
 if public.opportunity_activation_source_state_v6(newer_id)<>'source_decided' then
  raise exception 'Learning status lost its activation decision history'; end if;
 perform public.set_opportunity_status_v6(o.id,'paused','Recheck market');
 if (select activated_request_id from public.market_opportunities where id=o.id) is not null
  then raise exception 'Paused opportunity retained activation signature'; end if;
 execute 'alter table public.market_opportunities disable trigger opportunity_activation_guard_v6';
 update public.market_opportunities set status='active' where id=o.id;
 execute 'alter table public.market_opportunities enable trigger opportunity_activation_guard_v6';
 begin
  perform public.set_opportunity_status_v6(o.id,'learning');
  raise exception 'Legacy active opportunity progressed without activation decision';
 exception when insufficient_privilege then null; end;
end $checks$;
rollback;

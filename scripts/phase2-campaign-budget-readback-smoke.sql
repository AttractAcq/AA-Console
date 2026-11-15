-- Rollback-only proof that an uncertain budget action gets a read-only job and
-- a value observation, without turning the original outcome into success.
begin;
insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','00000000-0000-0000-0000-000000000000',
 'authenticated','authenticated','budget-readback@example.invalid','',now(),now());
insert into public.profiles(id,role,email) values
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','admin','budget-readback@example.invalid');
insert into public.clients(id,name,initials) values
 ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Budget readback fixture','BR');
insert into public.client_campaigns
 (id,client_id,name,brief,acquisition_mode,runs_organic,runs_paid,paid_platform,
  meta_ad_set_id,daily_budget)
values ('cccccccc-cccc-4ccc-8ccc-cccccccccccc',
 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Budget readback','Synthetic Meta ad set',
 'paid',false,true,'meta','23848',50);
insert into public.campaign_manifest_versions
 (id,campaign_id,client_id,version,idempotency_key,acquisition_mode,plan_snapshot,plan_hash)
values ('dddddddd-dddd-4ddd-8ddd-dddddddddddd',
 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',1,'budget-readback','paid','{}'::jsonb,
 repeat('a',32));

select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true);
select set_config('request.jwt.claims',
 '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal2"}',true);
do $grant$
declare iid uuid; rid uuid; qid uuid;
begin
 iid:=public.admin_store_integration_credential(
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','meta','act_123','fixture-secret','write');
 update public.client_integrations set ad_account_id='act_123' where id=iid;
 rid:=public.request_integration_grant_v6(iid,false);
 select id into qid from public.integration_grant_reviews_v6 where canonical_request_id=rid;
 perform public.decide_integration_grant_v6(qid,rid,true);
end $grant$;

select set_config('request.jwt.claim.role','service_role',true);
select set_config('request.jwt.claim.sub','',true);
select set_config('request.jwt.claims','{"role":"service_role"}',true);
do $request$
declare aid uuid;
begin
 aid:=public.request_campaign_budget_change_v6(
  'cccccccc-cccc-4ccc-8ccc-cccccccccccc',75,'Synthetic readback',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
 if aid is null then raise exception 'Budget approval was not created'; end if;
end $request$;

select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true);
select set_config('request.jwt.claims',
 '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal2"}',true);
do $approve$
declare aid uuid;
begin
 select id into aid from public.campaign_action_approvals
  where scope->>'reason'='Synthetic readback';
 perform public.decide_campaign_action_approval_v6(aid,'approved');
end $approve$;

select set_config('request.jwt.claim.role','service_role',true);
select set_config('request.jwt.claim.sub','',true);
select set_config('request.jwt.claims','{"role":"service_role"}',true);
do $uncertain$
declare a public.campaign_action_approvals%rowtype; eid uuid;
begin
 select * into a from public.campaign_action_approvals
  where scope->>'reason'='Synthetic readback';
 insert into public.campaign_action_executions
  (approval_id,client_id,campaign_id,action_key,artifact_version_hash,
   manifest_id,status,attempts,claimed_at,lease_until)
 values (a.id,a.client_id,a.campaign_id,a.action_key,a.artifact_version_hash,
  a.manifest_id,'executing',1,now(),now()+interval '10 minutes')
 returning id into eid;
 perform public.record_campaign_action_uncertain_v6(eid,
  'Synthetic lost readback','23848',null,'{}'::jsonb);
end $uncertain$;

select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true);
select set_config('request.jwt.claims',
 '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal1"}',true);
do $aal1$
declare eid uuid;
begin
 select id into eid from public.campaign_action_executions limit 1;
 begin
  perform public.request_campaign_budget_readback_v6(eid);
  raise exception 'AAL1 requested budget readback';
 exception when insufficient_privilege then null; end;
end $aal1$;
select set_config('request.jwt.claims',
 '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal2"}',true);
do $queue$
declare eid uuid; jid uuid;
begin
 select id into eid from public.campaign_action_executions limit 1;
 jid:=public.request_campaign_budget_readback_v6(eid);
 if jid is null or jid is distinct from public.request_campaign_budget_readback_v6(eid)
  then raise exception 'Budget readback did not queue idempotently'; end if;
end $queue$;

select set_config('request.jwt.claim.role','service_role',true);
select set_config('request.jwt.claim.sub','',true);
select set_config('request.jwt.claims','{"role":"service_role"}',true);
do $observe$
declare eid uuid; target jsonb; result_value text;
begin
 select id into eid from public.campaign_action_executions limit 1;
 target:=public.campaign_budget_readback_target_v6(eid,
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
 if target is null or target->>'ad_set_external_id'<>'23848'
  or (target->>'proposed_daily_budget')::numeric<>75
  or public.campaign_budget_readback_target_v6(eid,
    'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee') is not null then
  raise exception 'Budget readback target was not exact and client bound'; end if;
 begin
  perform public.record_campaign_budget_readback_v6(eid,
   'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','wrong','act_123','GBP',7500);
  raise exception 'Different ad set was recorded as a readback';
 exception when check_violation then null; end;
 begin
  perform public.record_campaign_budget_readback_v6(eid,
   'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','23848','act_999','GBP',7500);
  raise exception 'Different Meta account was recorded as a readback';
 exception when check_violation then null; end;
 result_value:=public.record_campaign_budget_readback_v6(eid,
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','23848','act_123','GBP',7500);
 if result_value<>'matches_proposed'
  or (select status from public.campaign_action_executions where id=eid)<>'uncertain' then
  raise exception 'Readback changed execution truth or lost its observation'; end if;
 perform set_config('request.jwt.claim.role','authenticated',true);
 perform set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true);
 perform set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal2"}',true);
 if (select outcome from public.client_external_outcomes_v6
      where outcome_id=eid)<>'uncertain'
  or not exists(select 1 from public.campaign_budget_readback_overview_v6
    where execution_id=eid and result='matches_proposed') then
  raise exception 'Owner could not see uncertain outcome and readback'; end if;
end $observe$;
rollback;

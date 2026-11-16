-- Rollback-only exact budget-source review; no Meta provider call.
begin;
insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','00000000-0000-0000-0000-000000000000',
 'authenticated','authenticated','budget-admin@example.invalid','',now(),now());
insert into public.profiles(id,role,email) values
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','admin','budget-admin@example.invalid');
insert into public.clients(id,name,initials) values
 ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Budget fixture','BF');
insert into public.client_campaigns
 (id,client_id,name,brief,acquisition_mode,runs_organic,runs_paid,paid_platform,
  meta_ad_set_id,daily_budget)
values ('cccccccc-cccc-4ccc-8ccc-cccccccccccc',
 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Budget campaign','Test exact budget review',
 'paid',false,true,'meta','23848',50);
insert into public.campaign_manifest_versions
 (id,campaign_id,client_id,version,idempotency_key,acquisition_mode,plan_snapshot,plan_hash)
values ('dddddddd-dddd-4ddd-8ddd-dddddddddddd',
 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',1,'budget-test','paid','{}'::jsonb,
 repeat('a',32));
select set_config('request.jwt.claim.role','service_role',true);
do $request$
declare aid uuid; rid uuid; cid uuid:='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
 change_id uuid;
begin
 begin
  perform public.request_campaign_action_approval_v6(
   'dddddddd-dddd-4ddd-8ddd-dddddddddddd','legacy-profile','profile_update',
   'google_profile:fixture',repeat('b',64),'{}'::jsonb);
  raise exception 'Unsourced generic profile action was accepted';
 exception when check_violation then null; end;
 aid:=public.request_campaign_budget_change_v6(
  cid,75,'Raise after lead quality review','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
 select id into rid from public.approval_requests_v6
  where source_kind='campaign_action' and source_id=aid::text;
 select id into change_id from public.campaign_budget_changes where approval_id=aid;
 if aid is null or rid is null or change_id is null
  or (select status from public.approval_inbox_v6 where id=rid)<>'pending'
  or (select preview_blocker from public.approval_inbox_v6 where id=rid) is not null
  or (select preview->'budget_change'->>'reason' from public.approval_inbox_v6
      where id=rid)<>'Raise after lead quality review'
  then raise exception 'Source budget was not reviewable in the Inbox'; end if;
 update public.campaign_budget_changes set reason='Changed reason' where id=change_id;
 if (select status from public.approval_inbox_v6 where id=rid)<>'superseded' then
  raise exception 'Changing budget reason kept approval current'; end if;
 update public.campaign_budget_changes set reason='Raise after lead quality review'
  where id=change_id;
 if (select status from public.approval_inbox_v6 where id=rid)<>'superseded' then
  raise exception 'Reverted budget reason revived old approval'; end if;
 aid:=public.request_campaign_budget_change_v6(
  cid,80,'New exact budget request','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
 select id into rid from public.approval_requests_v6
  where source_kind='campaign_action' and source_id=aid::text;
 if (select status from public.approval_inbox_v6 where id=rid)<>'pending' then
  raise exception 'Fresh budget action did not get exact review'; end if;
end $request$;
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true);
select set_config('request.jwt.claims',
 '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal2"}',true);
do $decision$
declare aid uuid; rid uuid;
begin
 select a.id into aid from public.campaign_action_approvals a
  where a.scope->>'reason'='New exact budget request';
 select r.id into rid from public.approval_requests_v6 r
  where r.source_kind='campaign_action' and r.source_id=aid::text;
 perform set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal1"}',true);
 begin
  perform public.decide_campaign_action_approval_v6(aid,'approved');
  raise exception 'AAL1 approved the budget action';
 exception when insufficient_privilege then null; end;
 perform set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal2"}',true);
 perform public.decide_campaign_action_approval_v6(aid,'approved');
 if (select status from public.approval_inbox_v6 where id=rid)<>'approved' then
  raise exception 'Exact budget decision was not recorded'; end if;
end $decision$;
select set_config('request.jwt.claim.role','service_role',true);
update public.client_campaigns set daily_budget=60
 where id='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
do $stale$
declare rid uuid;
begin
 select r.id into rid from public.approval_requests_v6 r
 join public.campaign_action_approvals a on a.id::text=r.source_id
 where a.scope->>'reason'='New exact budget request';
 if (select status from public.approval_inbox_v6 where id=rid)<>'superseded' then
  raise exception 'Changed campaign budget kept action approval current'; end if;
 update public.client_campaigns set daily_budget=50
  where id='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
 if (select status from public.approval_inbox_v6 where id=rid)<>'superseded' then
  raise exception 'Restored campaign budget revived old approval'; end if;
end $stale$;
-- Simulate an already recorded provider outcome inside this rollback-only
-- transaction. The action's own expected budget change must not stale its
-- historical exact approval.
do $applied_setup$
declare aid uuid;
begin
 aid:=public.request_campaign_budget_change_v6(
  'cccccccc-cccc-4ccc-8ccc-cccccccccccc',90,'Applied state fixture',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
 perform set_config('request.jwt.claim.role','authenticated',true);
 perform set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal2"}',true);
 perform public.decide_campaign_action_approval_v6(aid,'approved');
 perform set_config('request.jwt.claim.role','service_role',true);
 perform public.record_budget_change_applied(
  (select id from public.campaign_budget_changes where approval_id=aid),'23848');
 if (select status from public.approval_inbox_v6
   where source_kind='campaign_action' and source_id=aid::text)<>'approved' then
  raise exception 'The approved action staled itself after its expected budget change'; end if;
end $applied_setup$;
rollback;

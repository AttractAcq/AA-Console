-- Rollback-only proof for an owner-requested GitHub GET after an uncertain
-- page publish. No GitHub request or page write occurs in this fixture.
begin;
insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','00000000-0000-0000-0000-000000000000',
 'authenticated','authenticated','page-readback@example.invalid','',now(),now());
insert into public.profiles(id,role,email) values
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','admin','page-readback@example.invalid');
insert into public.clients(id,name,initials) values
 ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Page readback fixture','PR');
insert into public.client_campaigns
 (id,client_id,name,brief,acquisition_mode,runs_organic,runs_paid)
values ('cccccccc-cccc-4ccc-8ccc-cccccccccccc',
 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Page readback','Synthetic page package',
 'organic',true,false);
insert into public.campaign_manifest_versions
 (id,campaign_id,client_id,version,idempotency_key,acquisition_mode,plan_snapshot,plan_hash)
values ('dddddddd-dddd-4ddd-8ddd-dddddddddddd',
 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',1,'page-readback','organic','{}'::jsonb,
 repeat('a',32));
insert into public.github_app_installations
 (id,installation_id,account_login,account_type)
values ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',123,'AttractAcq-Sites','Organization');
insert into public.client_site_repositories
 (id,client_id,installation_id,github_repository_id,owner,repo,default_branch,pages_url,status)
values ('ffffffff-ffff-4fff-8fff-ffffffffffff',
 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',456,
 'AttractAcq-Sites','fixture-site','main','https://example.github.io/fixture-site/','ready');
insert into public.client_pages
 (id,client_id,page_type,title,html,current_revision)
values ('11111111-1111-4111-8111-111111111111',
 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','landing','Fixture offer',
 '<html><body>Exact fixture</body></html>',1);
insert into public.client_page_revisions
 (id,client_id,page_id,revision_number,html,source)
values ('22222222-2222-4222-8222-222222222222',
 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
 '11111111-1111-4111-8111-111111111111',1,
 '<html><body>Exact fixture</body></html>','initial_generation');
insert into public.campaign_artifacts
 (campaign_id,client_id,kind,page_id)
values ('cccccccc-cccc-4ccc-8ccc-cccccccccccc',
 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','landing_page',
 '11111111-1111-4111-8111-111111111111');

select set_config('request.jwt.claim.role','service_role',true);
select set_config('request.jwt.claims','{"role":"service_role"}',true);
do $request$
declare a public.campaign_action_approvals%rowtype;
begin
 a:=public.request_campaign_page_deploy_approval_v6(
  '11111111-1111-4111-8111-111111111111','fixture-page',
  'ffffffff-ffff-4fff-8fff-ffffffffffff','fixture-offer/index.html');
 if a.id is null or not exists(select 1 from public.campaign_page_approval_snapshots s
   where s.approval_id=a.id and s.site_path='fixture-offer/index.html') then
  raise exception 'Exact page request and snapshot were not created'; end if;
end $request$;
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true);
select set_config('request.jwt.claims',
 '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal2"}',true);
do $approve$
declare aid uuid;
begin
 select id into aid from public.campaign_action_approvals
  where action_key='page_deploy';
 perform public.decide_campaign_action_approval_v6(aid,'approved');
end $approve$;

select set_config('request.jwt.claim.role','service_role',true);
select set_config('request.jwt.claim.sub','',true);
select set_config('request.jwt.claims','{"role":"service_role"}',true);
do $uncertain$
declare a public.campaign_action_approvals%rowtype; eid uuid;
begin
 select * into a from public.campaign_action_approvals
  where action_key='page_deploy';
 insert into public.campaign_action_executions
  (approval_id,client_id,campaign_id,action_key,artifact_version_hash,
   manifest_id,status,attempts,claimed_at,lease_until)
 values (a.id,a.client_id,a.campaign_id,a.action_key,a.artifact_version_hash,
  a.manifest_id,'executing',1,now(),now()+interval '10 minutes')
 returning id into eid;
 perform public.record_campaign_action_uncertain_v6(eid,
  'Synthetic lost GitHub receipt',repeat('e',40),a.destination,
  jsonb_build_object('published_sha256',a.artifact_version_hash));
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
  perform public.request_campaign_page_readback_v6(eid);
  raise exception 'AAL1 requested page readback';
 exception when insufficient_privilege then null; end;
end $aal1$;
select set_config('request.jwt.claims',
 '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal2"}',true);
do $queue$
declare eid uuid; jid uuid;
begin
 select id into eid from public.campaign_action_executions limit 1;
 jid:=public.request_campaign_page_readback_v6(eid);
 if jid is null or jid is distinct from public.request_campaign_page_readback_v6(eid)
  then raise exception 'Page readback did not queue idempotently'; end if;
end $queue$;

select set_config('request.jwt.claim.role','service_role',true);
select set_config('request.jwt.claim.sub','',true);
select set_config('request.jwt.claims','{"role":"service_role"}',true);
do $observe$
declare eid uuid; target jsonb; result_value text;
begin
 select id into eid from public.campaign_action_executions limit 1;
 target:=public.campaign_page_readback_target_v6(eid,
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
 if target is null or target->>'repository_owner'<>'AttractAcq-Sites'
  or target->>'site_path'<>'fixture-offer/index.html'
  or target->>'checked_ref'<>repeat('e',40)
  or public.campaign_page_readback_target_v6(eid,
   '99999999-9999-4999-8999-999999999999') is not null then
  raise exception 'Page readback target was not frozen and client bound'; end if;
 begin
  perform public.record_campaign_page_readback_v6(eid,
   'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','wrong','fixture-site',
   'fixture-offer/index.html',repeat('e',40),target->>'expected_sha256');
  raise exception 'Wrong repository was recorded as a readback';
 exception when check_violation then null; end;
 result_value:=public.record_campaign_page_readback_v6(eid,
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','AttractAcq-Sites','fixture-site',
  'fixture-offer/index.html',repeat('e',40),target->>'expected_sha256');
 if result_value<>'matches_expected'
  or (select status from public.campaign_action_executions where id=eid)<>'uncertain' then
  raise exception 'Page readback changed execution truth or lost the observation'; end if;
 perform set_config('request.jwt.claim.role','authenticated',true);
 perform set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true);
 perform set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal2"}',true);
 if (select outcome from public.client_external_outcomes_v6
      where outcome_id=eid)<>'uncertain'
  or not exists(select 1 from public.campaign_page_readback_overview_v6
    where execution_id=eid and result='matches_expected') then
  raise exception 'Owner could not see uncertain page outcome and readback'; end if;
end $observe$;
rollback;

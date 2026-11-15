-- Rollback-only local integration proof for the 325 owned claim. This fixture
-- supplies synthetic exact preview evidence; it performs no external action.
begin;
-- Fixture setup exercises another approval class; bypass only the new
-- activation guard inside this rollback transaction.
alter table public.client_engine_settings disable trigger client_switch_activation_guard_v6;
insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','00000000-0000-0000-0000-000000000000',
  'authenticated','authenticated','claim-admin@example.invalid','',now(),now());
insert into public.profiles(id,role,email) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','admin','claim-admin@example.invalid');
insert into public.clients(id,name,initials) values
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Claim fixture','CF');
insert into public.client_campaigns(id,client_id,name,brief,acquisition_mode,runs_organic,runs_paid)
values ('cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Claim test','Synthetic package',
  'organic',true,false);
insert into public.campaign_manifest_versions
  (id,campaign_id,client_id,version,idempotency_key,acquisition_mode,plan_snapshot,plan_hash)
values ('dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',1,'claim-test','organic','{}'::jsonb,
  repeat('a',32));
insert into public.client_engine_settings(client_id,campaign_actions_enabled)
values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',false)
on conflict (client_id) do update set campaign_actions_enabled = false;

select set_config('request.jwt.claim.role','service_role',true);
select set_config('request.jwt.claim.sub','',true);
do $fixture$
declare v_action public.campaign_action_approvals%rowtype;
  v_request public.approval_requests_v6%rowtype;
begin
  v_action := public.request_campaign_action_approval_v6(
    'dddddddd-dddd-4ddd-8ddd-dddddddddddd','claim-one','proof_publish',
    'proof:approved_placements',repeat('b',64),
    '{"placements":[{"placement_id":"11111111-1111-4111-8111-111111111111","payload_hash":"bbbb"}]}'::jsonb);
  select * into v_request from public.approval_requests_v6
    where source_kind = 'campaign_action' and source_id = v_action.id::text;
  if not found then raise exception 'Source request was not mirrored'; end if;
  perform public.attach_approval_evidence_v6(v_request.id,v_request.source_version,
    'synthetic-fixture:' || v_action.id::text,jsonb_build_object(
      'artifact_hash',v_action.artifact_version_hash,
      'preview',v_request.preview || jsonb_build_object('exact_manifest','synthetic fixture'),
      'destination',v_action.destination,'account_ref',v_request.account_ref,
      'budget',v_request.budget,'scope',v_action.scope));
end $fixture$;

select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true);
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal2"}',true);
do $fixture$
declare v_action public.campaign_action_approvals%rowtype;
begin
  select * into v_action from public.campaign_action_approvals
    where campaign_id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  perform public.decide_campaign_action_approval_v6(v_action.id,'approved');
end $fixture$;

select set_config('request.jwt.claim.role','service_role',true);
select set_config('request.jwt.claim.sub','',true);
select set_config('request.jwt.claims','{"role":"service_role"}',true);
update public.campaign_action_executors set supported = true,
  handler_attested_sha = repeat('c',40),handler_attested_at = now()
where action_key in ('proof_publish','page_deploy','lead_message','budget_change');
insert into public.agent_runtime_heartbeats(worker_id,status,version,metadata)
values ('agent-runtime:1:eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee','healthy',
  repeat('c',40),jsonb_build_object('enabled',true,
    'controls',jsonb_build_object('campaignActions',true),
    'holds','{}'::jsonb,
    'handlers',jsonb_build_object('proof_publish','proof_distribution',
      'page_deploy','website_studio','lead_message','sales_os',
      'budget_change','meta_ads_studio')));

do $checks$
declare v_worker text := 'agent-runtime:1:eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  v_sha text := repeat('c',40);
  v_handlers jsonb := '{"proof_publish":"proof_distribution","page_deploy":"website_studio","lead_message":"sales_os","budget_change":"meta_ads_studio"}'::jsonb;
  v_claim record;
  v_page public.campaign_action_approvals%rowtype;
  v_page_execution uuid;
  v_revoke public.campaign_action_approvals%rowtype;
  v_revoke_request public.approval_requests_v6%rowtype;
  v_unknown public.campaign_action_approvals%rowtype;
  v_unknown_request public.approval_requests_v6%rowtype;
  v_unknown_claim record;
  v_release jsonb;
  v_proof_id uuid;
begin
  if has_function_privilege('service_role',
    'public.release_campaign_proof_placements(uuid)','execute')
    or has_function_privilege('service_role',
      'public.enrol_campaign_leads_in_sequence_v6(uuid)','execute') then
    raise exception 'Service role can bypass the owned internal action wrappers'; end if;
  if exists (select 1 from public.claim_campaign_actions_owned_v6(v_worker,v_sha,v_handlers,1))
    then raise exception 'Claim passed a disabled client switch'; end if;
  perform set_config('request.jwt.claim.role','authenticated',true);
  perform set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true);
  perform set_config('request.jwt.claims',
    '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal1"}',true);
  begin
    perform public.set_campaign_actions_enabled('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',true);
    raise exception 'AAL1 enabled outward campaign actions';
  exception when insufficient_privilege then null; end;
  perform set_config('request.jwt.claims',
    '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal2"}',true);
  perform public.set_campaign_actions_enabled('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',true);
  perform set_config('request.jwt.claim.role','service_role',true);
  perform set_config('request.jwt.claim.sub','',true);
  perform set_config('request.jwt.claims','{"role":"service_role"}',true);
  begin
    perform * from public.claim_campaign_actions_owned_v6(v_worker,v_sha,
      '{"meta_ad_build":"meta_ads_studio"}'::jsonb,1);
    raise exception 'Unsupported handler was accepted';
  exception when check_violation then null; end;
  select * into v_claim from public.claim_campaign_actions_owned_v6(v_worker,v_sha,v_handlers,1);
  if v_claim.action_key <> 'proof_publish' or v_claim.attempt <> 1
    or v_claim.artifact_version_hash <> repeat('b',64) then
    raise exception 'Owned claim did not bind the reviewed action'; end if;
  if exists (select 1 from public.claim_campaign_actions_owned_v6(v_worker,v_sha,v_handlers,1))
    then raise exception 'Duplicate in-flight claim succeeded'; end if;
  if not exists (select 1 from public.campaign_action_attempts_v6 a
    where a.execution_id = v_claim.execution_id and a.attempt_number = 1
      and a.status = 'executing' and a.legacy_inferred = false) then
    raise exception 'The first attempt has no started receipt'; end if;
  perform public.assert_campaign_action_prewrite_v6(
    v_claim.execution_id,v_worker,v_sha,'proof_publish');
  v_release := public.release_campaign_proof_placements_owned_v6(
    v_claim.execution_id,v_worker,v_sha);
  if v_release->>'released' <> '0' then
    raise exception 'Synthetic proof fixture unexpectedly released a placement'; end if;
  perform set_config('request.jwt.claim.role','authenticated',true);
  perform set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true);
  perform set_config('request.jwt.claims',
    '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal2"}',true);
  if not exists (select 1 from public.campaign_proof_release_observations_v6 o
      where o.execution_id=v_claim.execution_id
        and o.placement_ref='11111111-1111-4111-8111-111111111111'
        and o.placement_approval_status is null and o.placement_status is null) then
    raise exception 'Missing proof placement was hidden from the release source check'; end if;
  perform set_config('request.jwt.claim.role','service_role',true);
  perform set_config('request.jwt.claim.sub','',true);
  perform set_config('request.jwt.claims','{"role":"service_role"}',true);
  -- Add a linked local placement after the zero-release call, solely to test
  -- the readback. The frozen fixture scope deliberately has a stale hash.
  insert into public.client_proof_assets(client_id,media_type,title,body,source)
    values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','text',
      'Synthetic release source','Fixture only','Fixture') returning id into v_proof_id;
  insert into public.proof_placements(id,client_id,destination_key,proof_id,
    source_proof_id,payload_hash,idempotency_key)
    values ('11111111-1111-4111-8111-111111111111',
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','third_party_directory',
      v_proof_id,v_proof_id,repeat('c',64),'fixture-proof-source');
  insert into public.proof_placement_approvals(client_id,placement_id,
    destination_key,payload_hash,scope,campaign_action_approval_id)
    values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      '11111111-1111-4111-8111-111111111111',
      'third_party_directory',repeat('c',64),'{}'::jsonb,v_claim.approval_id);
  perform set_config('request.jwt.claim.role','authenticated',true);
  perform set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true);
  perform set_config('request.jwt.claims',
    '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal2"}',true);
  if not exists (select 1 from public.campaign_proof_release_observations_v6 o
      where o.execution_id=v_claim.execution_id
        and o.placement_approval_status='pending'
        and o.placement_status='drafted'
        and o.destination_key='third_party_directory'
        and o.payload_matches=false and o.external_url is null) then
    raise exception 'Linked proof release source or stale hash was not visible'; end if;
  perform set_config('request.jwt.claim.role','service_role',true);
  perform set_config('request.jwt.claim.sub','',true);
  perform set_config('request.jwt.claims','{"role":"service_role"}',true);
  begin
    perform public.enrol_campaign_leads_owned_v6(v_claim.execution_id,v_worker,v_sha);
    raise exception 'Lead wrapper accepted a proof execution';
  exception when check_violation then null; end;
  update public.client_engine_settings set campaign_actions_enabled = false
    where client_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  begin
    perform public.assert_campaign_action_prewrite_v6(
      v_claim.execution_id,v_worker,v_sha,'proof_publish');
    raise exception 'Prewrite passed after the client switch turned off';
  exception when check_violation then null; end;
  begin
    perform public.release_campaign_proof_placements_owned_v6(
      v_claim.execution_id,v_worker,v_sha);
    raise exception 'Owned proof effect passed after the client switch turned off';
  exception when check_violation then null; end;
  update public.client_engine_settings set campaign_actions_enabled = true
    where client_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  begin
    perform public.assert_campaign_action_prewrite_v6(
      v_claim.execution_id,v_worker,v_sha,'page_deploy');
    raise exception 'Prewrite accepted a different handler';
  exception when check_violation then null; end;
  perform public.record_campaign_action_failure(v_claim.execution_id,
    'Synthetic retryable provider timeout',true);
  select * into v_claim from public.claim_campaign_actions_owned_v6(v_worker,v_sha,v_handlers,1);
  if v_claim.attempt <> 2 or not exists (
    select 1 from public.campaign_action_attempts_v6 a
    where a.execution_id = v_claim.execution_id and a.attempt_number = 1
      and a.status = 'failed' and a.error = 'Synthetic retryable provider timeout')
    then raise exception 'Retry lost the first attempt outcome'; end if;
  perform public.record_campaign_action_executed(v_claim.execution_id,
    'synthetic-external-id',null,'{"fixture":true}'::jsonb);
  if not exists (select 1 from public.campaign_action_attempts_v6 a
    where a.execution_id = v_claim.execution_id and a.attempt_number = 2
      and a.status = 'executed' and a.external_id = 'synthetic-external-id')
    then raise exception 'Second attempt has no observed result receipt'; end if;
  if exists (select 1 from public.claim_campaign_actions_owned_v6(v_worker,v_sha,v_handlers,1))
    then raise exception 'Executed action was claimed again'; end if;

  v_unknown := public.request_campaign_action_approval_v6(
    'dddddddd-dddd-4ddd-8ddd-dddddddddddd','unknown-one','proof_publish',
    'proof:approved_placements',repeat('9',64),
    '{"placements":[{"placement_id":"uncertain","payload_hash":"9999"}]}'::jsonb);
  select * into v_unknown_request from public.approval_requests_v6
    where source_kind='campaign_action' and source_id=v_unknown.id::text;
  perform public.attach_approval_evidence_v6(v_unknown_request.id,v_unknown_request.source_version,
    'synthetic-fixture:'||v_unknown.id::text,jsonb_build_object(
      'artifact_hash',v_unknown.artifact_version_hash,
      'preview',v_unknown_request.preview||jsonb_build_object('exact_manifest','uncertain fixture'),
      'destination',v_unknown.destination,'account_ref',v_unknown_request.account_ref,
      'budget',v_unknown_request.budget,'scope',v_unknown.scope));
  perform set_config('request.jwt.claim.role','authenticated',true);
  perform set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true);
  perform set_config('request.jwt.claims',
    '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal2"}',true);
  perform public.decide_campaign_action_approval_v6(v_unknown.id,'approved');
  perform set_config('request.jwt.claim.role','service_role',true);
  perform set_config('request.jwt.claim.sub','',true);
  perform set_config('request.jwt.claims','{"role":"service_role"}',true);
  select * into v_unknown_claim from public.claim_campaign_actions_owned_v6(
    v_worker,v_sha,v_handlers,1);
  if v_unknown_claim.approval_id is distinct from v_unknown.id then
    raise exception 'Uncertain fixture action was not claimed'; end if;
  update public.campaign_action_executions set lease_until=now()-interval '1 minute'
    where id=v_unknown_claim.execution_id;
  if (select d.execution_status from public.campaign_action_due d
      where d.approval_id=v_unknown.id)<>'uncertain'
    or (select d.blocker from public.campaign_action_due d
      where d.approval_id=v_unknown.id) not like 'Execution lease expired;%'
    or (select o.outcome from public.client_external_outcomes_v6 o
      where o.outcome_id=v_unknown_claim.execution_id)<>'uncertain'
    or exists(select 1 from public.claim_campaign_actions_owned_v6(v_worker,v_sha,v_handlers,1)) then
    raise exception 'Expired action lease was hidden or could be reclaimed'; end if;
  perform public.record_campaign_action_uncertain_v6(v_unknown_claim.execution_id,
    'Provider write may have completed','fixture-unknown-id',null,
    '{"fixture":true}'::jsonb);
  if (select e.status from public.campaign_action_executions e
    where e.id=v_unknown_claim.execution_id)<>'uncertain'
    or not exists(select 1 from public.campaign_action_attempts_v6 t
      where t.execution_id=v_unknown_claim.execution_id and t.status='uncertain'
       and t.external_id='fixture-unknown-id')
    or (select d.blocker from public.campaign_action_due d
      where d.approval_id=v_unknown.id) not like 'Provider effect may have happened;%'
    or (select o.outcome from public.client_external_outcomes_v6 o
      where o.outcome_id=v_unknown_claim.execution_id)<>'uncertain' then
    raise exception 'Uncertain effect lost its attempt, queue or alert'; end if;
  if exists(select 1 from public.claim_campaign_actions_owned_v6(v_worker,v_sha,v_handlers,1))
    then raise exception 'Uncertain effect was claimed for a second write'; end if;

  v_revoke := public.request_campaign_action_approval_v6(
    'dddddddd-dddd-4ddd-8ddd-dddddddddddd','revoke-one','proof_publish',
    'proof:approved_placements',repeat('f',64),
    jsonb_build_object('placements',jsonb_build_array(
      jsonb_build_object('placement_id','22222222-2222-4222-8222-222222222222',
        'payload_hash',repeat('f',64)),
      jsonb_build_object('placement_id','33333333-3333-4333-8333-333333333333',
        'payload_hash',repeat('f',64)))));
  insert into public.proof_placements(id,client_id,destination_key,proof_id,
    source_proof_id,payload_hash,idempotency_key,status)
  values
    ('22222222-2222-4222-8222-222222222222',
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','third_party_directory',
      v_proof_id,v_proof_id,repeat('f',64),'fixture-proof-queued','queued'),
    ('33333333-3333-4333-8333-333333333333',
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','third_party_directory',
      v_proof_id,v_proof_id,repeat('f',64),'fixture-proof-placing','placing');
  insert into public.proof_placement_approvals(client_id,placement_id,
    destination_key,payload_hash,scope,campaign_action_approval_id)
  values
    ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      '22222222-2222-4222-8222-222222222222',
      'third_party_directory',repeat('f',64),'{}'::jsonb,v_revoke.id),
    ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      '33333333-3333-4333-8333-333333333333',
      'third_party_directory',repeat('f',64),'{}'::jsonb,v_revoke.id);
  select * into v_revoke_request from public.approval_requests_v6
    where source_kind = 'campaign_action' and source_id = v_revoke.id::text;
  perform public.attach_approval_evidence_v6(v_revoke_request.id,v_revoke_request.source_version,
    'synthetic-fixture:' || v_revoke.id::text,jsonb_build_object(
      'artifact_hash',v_revoke.artifact_version_hash,
      'preview',v_revoke_request.preview || jsonb_build_object('exact_manifest','withdrawn fixture'),
      'destination',v_revoke.destination,'account_ref',v_revoke_request.account_ref,
      'budget',v_revoke_request.budget,'scope',v_revoke.scope));
  perform set_config('request.jwt.claim.role','authenticated',true);
  perform set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true);
  perform set_config('request.jwt.claims',
    '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal2"}',true);
  perform public.decide_campaign_action_approval_v6(v_revoke.id,'approved');
  perform set_config('request.jwt.claims',
    '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal1"}',true);
  begin
    perform public.revoke_campaign_action_approval_v6(v_revoke.id,'Unassured withdrawal');
    raise exception 'AAL1 revoked an outward action';
  exception when insufficient_privilege then null; end;
  perform set_config('request.jwt.claims',
    '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal2"}',true);
  perform public.revoke_campaign_action_approval_v6(v_revoke.id,'Synthetic withdrawal');
  if (select count(*) from public.campaign_proof_retraction_demands_v6 d
      where d.approval_id=v_revoke.id)<>2
    or (select status from public.proof_placements
      where id='22222222-2222-4222-8222-222222222222')<>'retraction_required'
    or (select status from public.proof_placements
      where id='33333333-3333-4333-8333-333333333333')<>'placing'
    or not exists(select 1 from public.proof_placement_events e
      where e.placement_id='22222222-2222-4222-8222-222222222222'
        and e.event='retraction_required') then
    raise exception 'Withdrawal did not open exact proof removal demands'; end if;
  update public.proof_placements set status='placed',
    external_url='https://fixture.example/late-proof',placed_at=now()
    where id='33333333-3333-4333-8333-333333333333';
  insert into public.proof_placement_events
    (placement_id,client_id,event,actor,external_ref)
  values ('33333333-3333-4333-8333-333333333333',
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','placed','agent',
    'https://fixture.example/late-proof');
  set constraints campaign_proof_late_placement_retraction_v6 immediate;
  if (select status from public.proof_placements
      where id='33333333-3333-4333-8333-333333333333')<>'retraction_required'
    or not exists(select 1 from public.proof_placement_events
      where placement_id='33333333-3333-4333-8333-333333333333'
        and event='retraction_required') then
    raise exception 'Late provider placement was not routed into removal'; end if;
  begin
    perform public.revoke_campaign_action_approval_v6(v_revoke.id,'Duplicate withdrawal');
    raise exception 'The same action was revoked twice';
  exception when check_violation then null; end;
  if not exists (select 1 from public.approval_inbox_v6 i
    where i.id = v_revoke_request.id and i.status = 'revoked') then
    raise exception 'Canonical Inbox did not record the withdrawal'; end if;
  if not exists (select 1 from public.campaign_action_due d
    where d.approval_id = v_revoke.id and d.blocker like 'Approval revoked;%') then
    raise exception 'Owning queue did not expose the withdrawn action'; end if;
  perform set_config('request.jwt.claim.role','service_role',true);
  perform set_config('request.jwt.claim.sub','',true);
  perform set_config('request.jwt.claims','{"role":"service_role"}',true);
  if exists (select 1 from public.claim_campaign_actions_owned_v6(v_worker,v_sha,v_handlers,1))
    then raise exception 'Revoked action was claimed'; end if;

  -- An external action cannot be recorded as done without a provider ref.
  -- This deliberately inserts a synthetic lifecycle row to isolate the
  -- receipt invariant from the separate page publishing prerequisites.
  v_page := public.request_campaign_action_approval_v6(
    'dddddddd-dddd-4ddd-8ddd-dddddddddddd','receipt-only','page_deploy',
    'https://fixture.example/page',repeat('d',64),'{"page_id":"synthetic"}'::jsonb);
  insert into public.campaign_action_executions
    (approval_id,client_id,campaign_id,action_key,artifact_version_hash,
      manifest_id,status,attempts,claimed_at)
  values (v_page.id,v_page.client_id,v_page.campaign_id,v_page.action_key,
    v_page.artifact_version_hash,v_page.manifest_id,'executing',1,now())
  returning id into v_page_execution;
  begin
    perform public.record_campaign_action_executed(v_page_execution,null,null,null);
    raise exception 'External action was recorded without a provider reference';
  exception when check_violation then null; end;
  perform public.record_campaign_action_executed(v_page_execution,
    repeat('e',40),'https://fixture.example/page','{"fixture":true}'::jsonb);
  if not exists (select 1 from public.campaign_action_attempts_v6 a
    where a.execution_id = v_page_execution and a.status = 'executed'
      and a.external_url = 'https://fixture.example/page') then
    raise exception 'External outcome has no observed reference receipt'; end if;
end $checks$;
rollback;

-- Rollback-only local integration proof for the 325 owned claim. This fixture
-- supplies synthetic exact preview evidence; it performs no external action.
begin;
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
    '{"placements":[{"placement_id":"synthetic","payload_hash":"bbbb"}]}'::jsonb);
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
where action_key = 'proof_publish';
insert into public.agent_runtime_heartbeats(worker_id,status,version,metadata)
values ('agent-runtime:1:eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee','healthy',
  repeat('c',40),jsonb_build_object('enabled',true,
    'controls',jsonb_build_object('campaignActions',true),
    'holds','{}'::jsonb,
    'handlers',jsonb_build_object('proof_publish','proof_distribution')));

do $checks$
declare v_worker text := 'agent-runtime:1:eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  v_sha text := repeat('c',40);
  v_handlers jsonb := '{"proof_publish":"proof_distribution"}'::jsonb;
  v_claim record;
  v_page public.campaign_action_approvals%rowtype;
  v_page_execution uuid;
begin
  if exists (select 1 from public.claim_campaign_actions_owned_v6(v_worker,v_sha,v_handlers,1))
    then raise exception 'Claim passed a disabled client switch'; end if;
  update public.client_engine_settings set campaign_actions_enabled = true
    where client_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
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

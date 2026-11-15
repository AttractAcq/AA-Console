-- Rollback-only proof that a campaign lead sweep records its exact database
-- effect and refuses a second call or a changed sequence. No message is sent.
begin;
alter table public.client_engine_settings disable trigger client_switch_activation_guard_v6;
insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','00000000-0000-0000-0000-000000000000',
  'authenticated','authenticated','campaign-lead-admin@example.invalid','',now(),now());
insert into public.profiles(id,role,email) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','admin','campaign-lead-admin@example.invalid');
insert into public.clients(id,name,initials) values
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Campaign lead fixture','CL');
insert into public.client_campaigns(id,client_id,name,brief,acquisition_mode,runs_organic,runs_paid)
values ('cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Lead test','Synthetic package',
  'organic',true,false);
insert into public.campaign_manifest_versions
  (id,campaign_id,client_id,version,idempotency_key,acquisition_mode,plan_snapshot,plan_hash)
values ('dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',1,'lead-test','organic','{}'::jsonb,
  repeat('a',32));
insert into public.client_engine_settings(client_id,campaign_actions_enabled)
values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',true);
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true);
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal2"}',true);
insert into public.client_leads(id,client_id,name,email,consent_given_at,consent_wording,
  source_client_campaign_id,stage)
values ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Fixture lead',
  'campaign-lead@example.invalid',now(),'I agree to receive follow-up.',
  'cccccccc-cccc-4ccc-8ccc-cccccccccccc','profile_visit');

do $setup$
declare t public.message_templates%rowtype;
  v public.message_template_versions%rowtype;
  s public.nurture_sequences%rowtype;
  req uuid; source_id uuid;
begin
  t:=public.create_message_template_v6('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    'Campaign follow-up','magnet_follow_up','email',null);
  v:=public.add_message_template_version_v6(t.id,'Your guide',
    'Here is your guide.',array[]::text[]);
  req:=public.request_message_template_review_v6(v.id,'Lead requested follow-up');
  select id into source_id from public.message_template_review_requests_v6
    where canonical_request_id=req;
  perform public.decide_message_template_inbox_v6(source_id,req,true);
  insert into public.nurture_sequences(client_id,name,purpose,trigger_stage)
    values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      'Campaign follow-up','magnet_follow_up','profile_visit') returning * into s;
  insert into public.nurture_sequence_steps(sequence_id,client_id,position,delay_hours,template_version_id)
    values (s.id,s.client_id,1,24,v.id);
  req:=public.request_nurture_sequence_review_v6(s.id);
  select id into source_id from public.nurture_sequence_review_requests_v6
    where canonical_request_id=req;
  perform public.decide_nurture_sequence_inbox_v6(source_id,req,true);
  if not public.nurture_sequence_approval_current_v6(s.id) then
    raise exception 'Fixture sequence did not receive current approval'; end if;
end $setup$;

select set_config('request.jwt.claim.role','service_role',true);
select set_config('request.jwt.claim.sub','',true);
select set_config('request.jwt.claims','{"role":"service_role"}',true);
do $request$
declare v_action_id uuid; v_action public.campaign_action_approvals%rowtype;
  v_request public.approval_requests_v6%rowtype;
begin
  v_action_id:=public.request_campaign_lead_message_v6(
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    (select id from public.nurture_sequences where name='Campaign follow-up'),
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  select * into v_action from public.campaign_action_approvals where id=v_action_id;
  select * into v_request from public.approval_requests_v6
    where source_kind='campaign_action' and source_id=v_action.id::text;
  perform public.attach_approval_evidence_v6(v_request.id,v_request.source_version,
    'synthetic-fixture:'||v_action.id::text,jsonb_build_object(
      'artifact_hash',v_action.artifact_version_hash,
      'preview',v_request.preview||jsonb_build_object('exact_manifest','synthetic lead fixture'),
      'destination',v_action.destination,'account_ref',v_request.account_ref,
      'budget',v_request.budget,'scope',v_action.scope));
end $request$;

select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true);
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal2"}',true);
select public.decide_campaign_action_approval_v6(id,'approved')
from public.campaign_action_approvals where action_key='lead_message';

select set_config('request.jwt.claim.role','service_role',true);
select set_config('request.jwt.claim.sub','',true);
select set_config('request.jwt.claims','{"role":"service_role"}',true);
update public.campaign_action_executors set supported=true,
  handler_attested_sha=repeat('c',40),handler_attested_at=now()
where action_key='lead_message';
insert into public.agent_runtime_heartbeats(worker_id,status,version,metadata)
values ('agent-runtime:1:ffffffff-ffff-4fff-8fff-ffffffffffff','healthy',
  repeat('c',40),jsonb_build_object('enabled',true,
    'controls',jsonb_build_object('campaignActions',true),
    'holds','{}'::jsonb,
    'handlers',jsonb_build_object('lead_message','sales_os')));
do $checks$
declare v_worker text := 'agent-runtime:1:ffffffff-ffff-4fff-8fff-ffffffffffff';
  v_sha text := repeat('c',40);
  v_claim record; v_result jsonb; v_sequence uuid; v_review uuid; v_source uuid;
begin
  select * into v_claim from public.claim_campaign_actions_owned_v6(v_worker,v_sha,
    '{"lead_message":"sales_os"}'::jsonb,1);
  if v_claim.action_key <> 'lead_message' then
    raise exception 'Lead action was not claimed by its owner'; end if;
  v_result:=public.enrol_campaign_leads_owned_v6(v_claim.execution_id,v_worker,v_sha);
  if v_result->>'enrolled'<>'1'
    or (select observed_count from public.campaign_lead_enrolment_runs_v6
      where execution_id=v_claim.execution_id)<>1
    or not exists(select 1 from public.campaign_lead_enrolment_items_v6
      where execution_id=v_claim.execution_id and result='observed'
        and lead_id='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee') then
    raise exception 'Committed lead enrolment source was not recorded'; end if;
  begin
    perform public.enrol_campaign_leads_owned_v6(v_claim.execution_id,v_worker,v_sha);
    raise exception 'Duplicate effect call succeeded';
  exception when unique_violation then null; end;
  perform set_config('request.jwt.claim.role','authenticated',true);
  perform set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true);
  perform set_config('request.jwt.claims',
    '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal2"}',true);
  if not exists(select 1 from public.campaign_lead_enrolment_source_v6 s
      where s.execution_id=v_claim.execution_id and s.finished_at is not null
        and s.observed_count=1 and s.current_observation_rows=1) then
    raise exception 'Owner could not read the committed enrolment source'; end if;
  select sequence_id into v_sequence from public.campaign_lead_enrolment_runs_v6
    where execution_id=v_claim.execution_id;
  update public.nurture_sequence_steps set delay_hours=48
    where sequence_id=v_sequence;
  v_review:=public.request_nurture_sequence_review_v6(v_sequence);
  select id into v_source from public.nurture_sequence_review_requests_v6
    where canonical_request_id=v_review;
  perform public.decide_nurture_sequence_inbox_v6(v_source,v_review,true);
  if not public.nurture_sequence_approval_current_v6(v_sequence) then
    raise exception 'Edited sequence did not receive a new exact approval'; end if;
  perform set_config('request.jwt.claim.role','service_role',true);
  perform set_config('request.jwt.claim.sub','',true);
  perform set_config('request.jwt.claims','{"role":"service_role"}',true);
  begin
    perform public.enrol_campaign_leads_owned_v6(v_claim.execution_id,v_worker,v_sha);
    raise exception 'Changed sequence was accepted by campaign effect';
  exception when raise_exception then
    if sqlerrm<>'The sequence shape or words changed after campaign approval.' then raise; end if;
  end;
end $checks$;
rollback;

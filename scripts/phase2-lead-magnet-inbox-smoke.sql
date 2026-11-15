-- Rollback-only proof for the exact-file lead-magnet Inbox and delivery gate.
begin;
-- Fixture setup exercises another approval class; bypass only the new
-- activation guard inside this rollback transaction.
alter table public.client_engine_settings disable trigger client_switch_activation_guard_v6;
insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','00000000-0000-0000-0000-000000000000',
  'authenticated','authenticated','magnet-admin@example.invalid','',now(),now()),
  ('cccccccc-cccc-4ccc-8ccc-cccccccccccc','00000000-0000-0000-0000-000000000000',
  'authenticated','authenticated','magnet-outsider@example.invalid','',now(),now());
insert into public.profiles(id,role,email) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','admin','magnet-admin@example.invalid'),
  ('cccccccc-cccc-4ccc-8ccc-cccccccccccc','client','magnet-outsider@example.invalid');
insert into public.clients(id,name,initials) values
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Magnet fixture','MF');
select set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true);
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal1"}',true);

do $checks$
declare m public.lead_magnets%rowtype;
  v public.lead_magnet_versions%rowtype;
  a public.lead_magnet_approvals%rowtype;
  r public.approval_requests_v6%rowtype;
  a_id uuid;
  endpoint_id uuid;
  submission_id uuid;
  v_delivery_id uuid;
  second_delivery_id uuid;
  new_version_id uuid;
  replacement_id uuid;
  claimed_count integer;
  reaped_count integer;
begin
  insert into public.lead_magnets(client_id,name,objective,format)
  values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Fixture guide','Show the guide','pdf_guide')
  returning * into m;
  insert into public.lead_magnet_versions(magnet_id,client_id,version,storage_path,
    content_sha256,file_bytes,media_type,delivery_channel,delivery_subject,delivery_body)
  values (m.id,m.client_id,1,m.client_id::text || '/lead-magnets/fixture.pdf',
    repeat('a',64),16,'application/pdf','email','Your guide','Here is your guide')
  returning * into v;
  a_id := public.request_lead_magnet_approval_v6(v.id);
  select * into a from public.lead_magnet_approvals where id = a_id;
  select * into r from public.approval_requests_v6
    where source_kind = 'lead_magnet' and source_id = a.id::text;
  insert into public.lead_capture_endpoints(client_id,purpose,token_hash,
    consent_wording,expires_at,magnet_version_id)
  values (m.client_id,'magnet_optin',repeat('c',64),
    'I agree to receive the guide by email.',now() + interval '1 day',v.id)
  returning id into endpoint_id;
  insert into public.lead_submissions(client_id,endpoint_id,email,
    consent_wording,consent_given_at,idempotency_key,status)
  values (m.client_id,endpoint_id,'lead@example.invalid',
    'I agree to receive the guide by email.',now(),'fixture-optin','promoted')
  returning id into submission_id;
  insert into public.lead_magnet_deliveries(client_id,submission_id,
    magnet_version_id,channel,recipient)
  values (m.client_id,submission_id,v.id,'email','lead@example.invalid')
  returning id into v_delivery_id;
  if (select blocker from public.lead_magnet_due u where u.delivery_id = v_delivery_id) is null
    then raise exception 'Unapproved magnet became due'; end if;
  if not a.inbox_enforced_v6 or r.id is null or r.artifact_hash <> a.payload_hash
    or r.preview->>'delivery_subject' <> 'Your guide'
    or (select preview_blocker from public.approval_inbox_v6 where id = r.id) is null then
    raise exception 'Magnet request did not expose exact blocked preview: enforced %, request %, hash %, subject %, blocker %',
      a.inbox_enforced_v6,r.id,r.artifact_hash,r.preview->>'delivery_subject',
      (select preview_blocker from public.approval_inbox_v6 where id = r.id); end if;
  begin
    perform public.decide_lead_magnet_approval_v6(a.id,true);
    raise exception 'AAL1 or missing bytes approved';
  exception when insufficient_privilege then null; end;
  perform set_config('request.jwt.claim.role','service_role',true);
  perform set_config('request.jwt.claims','{"role":"service_role"}',true);
  begin
    perform public.attest_lead_magnet_bytes_v6(a.id,repeat('b',64),16);
    raise exception 'Wrong file bytes attested';
  exception when check_violation then null; end;
  perform public.attest_lead_magnet_bytes_v6(a.id,repeat('a',64),16);
  perform public.attest_lead_magnet_bytes_v6(a.id,repeat('a',64),16);
  perform set_config('request.jwt.claim.role','authenticated',true);
  perform set_config('request.jwt.claim.sub','cccccccc-cccc-4ccc-8ccc-cccccccccccc',true);
  perform set_config('request.jwt.claims',
    '{"sub":"cccccccc-cccc-4ccc-8ccc-cccccccccccc","role":"authenticated","aal":"aal2"}',true);
  begin
    perform public.decide_lead_magnet_approval_v6(a.id,true);
    raise exception 'Wrong-client actor approved';
  exception when raise_exception then
    if sqlerrm = 'Wrong-client actor approved' then raise; end if;
  end;
  perform set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true);
  perform set_config('request.jwt.claims',
    '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal2"}',true);
  perform public.decide_lead_magnet_approval_v6(a.id,true);
  if (select status from public.approval_inbox_v6 where id = r.id) <> 'approved'
    or not exists (select 1 from public.approval_decision_events_v6 d
      where d.request_id = r.id and d.decision = 'approved' and d.actor_aal = 'aal2') then
    raise exception 'Magnet source and Inbox decision diverged'; end if;
  if (select blocker from public.lead_magnet_due u where u.delivery_id = v_delivery_id)
    is distinct from 'Magnet delivery is off for this client.' then
    raise exception 'Disabled client switch did not block delivery'; end if;
  insert into public.client_engine_settings(client_id,lead_magnet_delivery_enabled)
  values (m.client_id,true) on conflict (client_id) do update
    set lead_magnet_delivery_enabled = excluded.lead_magnet_delivery_enabled;
  update public.lead_magnet_deliveries set recipient = 'other@example.invalid'
    where id = v_delivery_id;
  if (select blocker from public.lead_magnet_due u where u.delivery_id = v_delivery_id)
    is distinct from 'The same-client opt-in, consent, endpoint or recipient is unverified.'
    then raise exception 'Wrong recipient passed consent gate'; end if;
  update public.lead_magnet_deliveries set recipient = 'lead@example.invalid'
    where id = v_delivery_id;
  if (select blocker from public.lead_magnet_due u where u.delivery_id = v_delivery_id) is not null
    then raise exception 'Approved, enabled magnet remained blocked'; end if;
  begin
    perform public.decide_lead_magnet_approval_v6(a.id,true);
    raise exception 'Duplicate approval succeeded';
  exception when raise_exception then
    if sqlerrm = 'Duplicate approval succeeded' then raise; end if;
  end;
  insert into public.lead_submissions(client_id,endpoint_id,email,
    consent_wording,consent_given_at,idempotency_key,status)
  values (m.client_id,endpoint_id,'second@example.invalid',
    'I agree to receive the guide by email.',now(),'fixture-second-optin','promoted')
  returning id into submission_id;
  insert into public.lead_magnet_deliveries(client_id,submission_id,
    magnet_version_id,channel,recipient)
  values (m.client_id,submission_id,v.id,'email','second@example.invalid')
  returning id into second_delivery_id;
  perform set_config('request.jwt.claim.role','service_role',true);
  perform set_config('request.jwt.claims','{"role":"service_role"}',true);
  select count(*) into claimed_count from public.claim_lead_magnet_deliveries(5);
  if claimed_count<>2 or not public.lead_magnet_send_ready_v6(v_delivery_id,1)
    or (select count(*) from public.lead_magnet_delivery_attempts_v6
      where request_id=r.id and outcome='sending')<>2 then
    raise exception 'Courier claims were not bound to two exact approval attempts'; end if;
  update public.lead_magnet_deliveries set lease_until=now()-interval '1 minute'
    where id=second_delivery_id;
  reaped_count:=public.reap_stale_lead_magnet_deliveries();
  select count(*) into claimed_count from public.claim_lead_magnet_deliveries(5);
  if reaped_count<>1
    or (select status from public.lead_magnet_deliveries where id=second_delivery_id)<>'uncertain'
    or (select outcome from public.lead_magnet_delivery_attempts_v6
      where delivery_id=second_delivery_id)<>'uncertain'
    or claimed_count<>0 then
    raise exception 'Interrupted send quarantine failed (reaped %, delivery %, attempt %, reclaimed %)',
      reaped_count,
      (select status from public.lead_magnet_deliveries where id=second_delivery_id),
      (select outcome from public.lead_magnet_delivery_attempts_v6 where delivery_id=second_delivery_id),
      claimed_count; end if;
  perform set_config('request.jwt.claim.role','authenticated',true);
  perform set_config('request.jwt.claims',
    '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal2"}',true);
  perform public.revoke_lead_magnet_approval_v6(a.id,'Incorrect guide');
  if (select status from public.approval_inbox_v6 where id = r.id) <> 'revoked'
    then raise exception 'Revocation did not reach Inbox'; end if;
  if (select blocker from public.lead_magnet_due u where u.delivery_id = v_delivery_id)
    not like 'The approval was revoked:%'
    then raise exception 'Revoked magnet remained deliverable'; end if;
  replacement_id:=public.request_lead_magnet_approval_v6(v.id);
  perform set_config('request.jwt.claim.role','service_role',true);
  perform set_config('request.jwt.claims','{"role":"service_role"}',true);
  perform public.attest_lead_magnet_bytes_v6(replacement_id,repeat('a',64),16);
  perform set_config('request.jwt.claim.role','authenticated',true);
  perform set_config('request.jwt.claims',
    '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal2"}',true);
  perform public.decide_lead_magnet_approval_v6(replacement_id,true);
  perform set_config('request.jwt.claim.role','service_role',true);
  perform set_config('request.jwt.claims','{"role":"service_role"}',true);
  if (select count(*) from public.lead_magnet_due where delivery_id=v_delivery_id)<>1
    or public.lead_magnet_send_ready_v6(v_delivery_id,1) then
    raise exception 'New approval revived an in-flight send under the revoked request'; end if;
  perform public.record_lead_magnet_failure(v_delivery_id,'Revoked before provider call',false);
  if (select outcome from public.lead_magnet_delivery_attempts_v6
    where delivery_id=v_delivery_id)<>'failed' then
    raise exception 'Rejected pre-send attempt had no separate outcome'; end if;
  perform set_config('request.jwt.claim.role','authenticated',true);
  perform set_config('request.jwt.claims',
    '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal2"}',true);
  if not exists(select 1 from public.lead_magnet_approval_execution_evidence_v6 e
    where e.request_id=r.id and e.client_id=m.client_id
      and e.source_kind='lead_magnet' and e.state='uncertain'
      and e.detail like '2 attempt(s): 0 provider accepted, 1 failed, 1 uncertain.%')
    then raise exception 'Exact Inbox card did not show both courier outcomes'; end if;
  if (select count(*) from public.client_external_outcomes_v6 e
    where e.client_id=m.client_id and e.source_kind='lead_magnet'
      and e.outcome in ('failed','uncertain')
      and e.owning_path='/clients/'||m.client_id::text||'/delivery/lead-magnet-studio?magnet='||m.id::text)<>2
    then raise exception 'Failed or ambiguous courier attempts were absent from owning alerts'; end if;
  perform public.revoke_lead_magnet_approval_v6(replacement_id,'Fixture replacement retired');
  execute 'alter table public.lead_magnet_approvals disable trigger lead_magnet_inbox_cohort_insert_v6';
  insert into public.lead_magnet_approvals(client_id,magnet_version_id,
    payload_hash,scope,inbox_enforced_v6)
  values (m.client_id,v.id,public.lead_magnet_payload_hash_v6(v.id),
    '{}'::jsonb,false) returning * into a;
  execute 'alter table public.lead_magnet_approvals enable trigger lead_magnet_inbox_cohort_insert_v6';
  begin
    perform public.decide_lead_magnet_approval_v6(a.id,true);
    raise exception 'Legacy pending request bypassed the new Inbox gate';
  exception when check_violation then null; end;
  insert into public.lead_magnet_versions(magnet_id,client_id,version,storage_path,
    content_sha256,file_bytes,media_type,delivery_channel,delivery_subject,delivery_body)
  values (m.id,m.client_id,2,m.client_id::text || '/lead-magnets/fixture-v2.pdf',
    repeat('d',64),16,'application/pdf','email','Your new guide','Here is your new guide')
  returning id into new_version_id;
  insert into public.lead_magnet_approvals(client_id,magnet_version_id,
    payload_hash,scope,inbox_enforced_v6)
  values (m.client_id,new_version_id,public.lead_magnet_payload_hash_v6(new_version_id),
    '{}'::jsonb,false) returning * into a;
  if not a.inbox_enforced_v6 or not exists (select 1 from public.approval_requests_v6
    where source_kind = 'lead_magnet' and source_id = a.id::text) then
    raise exception 'New privileged insert escaped the Inbox cohort'; end if;
  begin
    update public.lead_magnet_approvals set inbox_enforced_v6 = false where id = a.id;
    raise exception 'Inbox cohort was mutable';
  exception when check_violation then null; end;
end $checks$;
rollback;

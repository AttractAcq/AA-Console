-- Rollback-only proof that outcome requests bind a real sale and separate consent.
begin;
insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','00000000-0000-0000-0000-000000000000',
  'authenticated','authenticated','outcome-admin@example.invalid','',now(),now());
insert into public.profiles(id,role,email)
values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','admin','outcome-admin@example.invalid');
insert into public.clients(id,name,initials)
values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Outcome fixture','OF');
select set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true);
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal2"}',true);

do $checks$
declare lead_id uuid; consent_id uuid; config_id uuid; link_id uuid;
  delivery public.proof_request_deliveries%rowtype; review public.proof_delivery_reviews_v6%rowtype;
  preview jsonb; request_id uuid;
begin
  insert into public.client_leads(client_id,name,email,stage,sale_value)
  values('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Customer','customer@example.invalid','lead',1000)
  returning id into lead_id;
  begin
    insert into public.proof_outcome_followup_consents_v7
      (client_id,lead_id,channel,recipient,consent_text,evidence_note,consented_at,recorded_by)
    values('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',lead_id,'email','customer@example.invalid',
      'Please contact me by email about a review.','Recorded in customer call notes.',now(),
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    raise exception 'Non-sale outcome consent was accepted' using errcode='XX000';
  exception when sqlstate '23514' then null; end;
  update public.client_leads set stage='sale' where id=lead_id;
  insert into public.proof_outcome_followup_consents_v7
    (client_id,lead_id,channel,recipient,consent_text,evidence_note,consented_at,recorded_by)
  values('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',lead_id,'email','customer@example.invalid',
    'Please contact me by email about a review.','Recorded in customer call notes.',now(),
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') returning id into consent_id;
  insert into public.proof_capture_configs(client_id,method,name,instructions,trigger_event,message_template)
  values('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','outcome_followup','Outcome request',
    'Ask only for a genuine account of the service.','sale','Please share your experience: {{capture_link}}')
  returning id into config_id;
  insert into public.proof_capture_links(client_id,config_id,token_hash,expires_at)
  values('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',config_id,repeat('f',64),now()+interval '14 days')
  returning id into link_id;
  insert into public.proof_request_deliveries(id,client_id,config_id,link_id,event_key,
    recipient,channel,subject,message,capture_url,outcome_lead_id,outcome_consent_id)
  values(gen_random_uuid(),'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',config_id,link_id,'outcome:test',
    'customer@example.invalid','email','Outcome request','Please share your experience',
    'https://example.invalid/proof',lead_id,consent_id) returning * into delivery;
  if not public.proof_outcome_followup_ready_v7(delivery) then
    raise exception 'Current outcome and consent were held'; end if;
  request_id:=public.request_proof_delivery_review_v6(delivery.id);
  select * into review from public.proof_delivery_reviews_v6
    where canonical_request_id=request_id;
  preview:=public.proof_delivery_preview_v6(review);
  if preview->>'outcome_lead_id' is distinct from lead_id::text
     or preview->>'outcome_consent_text' is null
     or preview->>'outcome_ready' <> 'true' then
    raise exception 'Inbox preview lost outcome or consent evidence'; end if;
  if public.proof_delivery_source_state_v6(request_id)<>'pending' then
    raise exception 'Current outcome request was not reviewable'; end if;
  update public.proof_outcome_followup_consents_v7 set withdrawn_at=now(),
    withdrawal_reason='Customer withdrew permission.' where id=consent_id;
  select * into delivery from public.proof_request_deliveries where id=delivery.id;
  if public.proof_outcome_followup_ready_v7(delivery)
     or public.proof_delivery_preview_v6(review)->>'outcome_ready'<>'false'
     or public.proof_delivery_source_state_v6(request_id)='pending' then
    raise exception 'Withdrawn consent remained send-ready'; end if;

  insert into public.proof_capture_configs(client_id,method,name,instructions,trigger_event,message_template)
  values('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','automated_requests','Legacy request',
    'Ask for direct evidence.','job_complete','Please share your experience: {{capture_link}}')
  returning id into config_id;
  insert into public.proof_capture_links(client_id,config_id,token_hash,expires_at)
  values('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',config_id,repeat('e',64),now()+interval '14 days')
  returning id into link_id;
  insert into public.proof_request_deliveries(id,client_id,config_id,link_id,event_key,
    recipient,channel,subject,message,capture_url)
  values(gen_random_uuid(),'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',config_id,link_id,'legacy:test',
    'customer@example.invalid','email','Legacy request','Please share your experience',
    'https://example.invalid/proof') returning * into delivery;
  insert into public.proof_delivery_reviews_v6(delivery_id,client_id)
  values(delivery.id,delivery.client_id) returning * into review;
  if public.proof_delivery_preview_v6(review) ? 'outcome_lead_id' then
    raise exception 'Existing proof request preview unexpectedly changed'; end if;
end $checks$;
rollback;

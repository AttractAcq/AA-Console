-- Rollback-only exact message approval, consent and courier gate fixture.
begin;
-- Fixture setup exercises another approval class; bypass only the new
-- activation guard inside this rollback transaction.
alter table public.client_engine_settings disable trigger client_switch_activation_guard_v6;
insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','00000000-0000-0000-0000-000000000000',
 'authenticated','authenticated','message-admin@example.invalid','',now(),now());
insert into public.profiles(id,role,email) values
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','admin','message-admin@example.invalid');
insert into public.clients(id,name,initials) values
 ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Message fixture','MF');
insert into public.client_engine_settings(client_id)
values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
select set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true);
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claims',
 '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal1"}',true);
insert into public.client_leads(id,client_id,name,email,consent_given_at,consent_wording)
values ('cccccccc-cccc-4ccc-8ccc-cccccccccccc','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
 'Priya','priya@example.invalid',now(),'I agree to receive a response to my enquiry.');
do $checks$
declare t public.message_templates%rowtype; v public.message_template_versions%rowtype;
 a public.message_template_approvals%rowtype; m public.outbound_messages%rowtype;
 req uuid; newer uuid; review_id uuid;
begin
 t:=public.create_message_template_v6('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  'Enquiry response','transactional','email',null);
 v:=public.add_message_template_version_v6(t.id,'Your enquiry','Hello Priya.',array[]::text[]);
 begin
  perform public.approve_message_template_v6(v.id,'Enquiry consent');
  raise exception 'Legacy direct approval succeeded';
 exception when insufficient_privilege then null; end;
 req:=public.request_message_template_review_v6(v.id,'Enquiry consent');
 select id into review_id from public.message_template_review_requests_v6
  where canonical_request_id=req;
 if req is null or public.request_message_template_review_v6(v.id,'Enquiry consent')<>req
  or (select status from public.approval_inbox_v6 where id=req)<>'pending' then
  raise exception 'Message request was not pending and deduplicated'; end if;
 begin
  perform public.decide_message_template_inbox_v6(review_id,req,true);
  raise exception 'AAL1 approved the message';
 exception when insufficient_privilege then null; end;
 update public.message_templates set purpose='booking' where id=t.id;
 if public.message_template_review_source_state_v6(req)<>'superseded' then
  raise exception 'Changed purpose did not supersede exact message review'; end if;
 update public.message_templates set purpose='transactional' where id=t.id;
 perform set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal2"}',true);
 begin
  perform public.decide_message_template_inbox_v6(review_id,req,true);
  raise exception 'Reverted old request was approved';
 exception when check_violation then null; end;
 newer:=public.request_message_template_review_v6(v.id,'Enquiry consent');
 select id into review_id from public.message_template_review_requests_v6
  where canonical_request_id=newer;
 perform public.decide_message_template_inbox_v6(review_id,newer,true);
 select * into a from public.message_template_approvals where template_version_id=v.id;
 if (select status from public.approval_inbox_v6 where id=newer)<>'approved'
  or not public.message_template_approval_current_v6(a.id) then
  raise exception 'Exact approved message is not current'; end if;
 m:=public.queue_lead_message_v6('cccccccc-cccc-4ccc-8ccc-cccccccccccc',v.id);
 if m.id is null then raise exception 'Approved consenting lead was not queued'; end if;
 begin
  update public.outbound_messages set rendered_body='Swapped words' where id=m.id;
  raise exception 'Queued words were mutable';
 exception when insufficient_privilege then null; end;
 perform set_config('request.jwt.claim.role','service_role',true);
 perform set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"service_role"}',true);
 if exists(select 1 from public.claim_outbound_messages(1)) then
  raise exception 'Client-off message was claimed'; end if;
 update public.client_engine_settings set outbound_messaging_enabled=true
  where client_id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
 if not exists(select 1 from public.claim_outbound_messages(1)) then
  raise exception 'Current approved message was not claimed'; end if;
 if not public.outbound_message_send_ready_v6(m.id) then
  raise exception 'Current consent was denied before provider call'; end if;
 update public.client_leads set consent_given_at=null,consent_wording=null where id=m.lead_id;
 if public.outbound_message_send_ready_v6(m.id) then
  raise exception 'Revoked consent was allowed before provider call'; end if;
 update public.client_leads set consent_given_at=m.consent_given_at,
  consent_wording=m.consent_wording where id=m.lead_id;
 update public.message_templates set name='Changed after approval' where id=t.id;
 if public.message_template_approval_current_v6(a.id)
  or public.outbound_message_send_ready_v6(m.id) then
  raise exception 'Stale message was allowed to send'; end if;
end $checks$;
rollback;

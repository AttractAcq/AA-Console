-- Rollback-only ordered-sequence Inbox review and enrolment gate.
begin;
insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','00000000-0000-0000-0000-000000000000',
 'authenticated','authenticated','sequence-admin@example.invalid','',now(),now());
insert into public.profiles(id,role,email) values
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','admin','sequence-admin@example.invalid');
insert into public.clients(id,name,initials) values
 ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Sequence fixture','SF');
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
 s public.nurture_sequences%rowtype; step_id uuid; req uuid; newer uuid; source_id uuid;
begin
 t:=public.create_message_template_v6('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  'Follow up','magnet_follow_up','email',null);
 v:=public.add_message_template_version_v6(t.id,'Your guide','Here is your guide.',array[]::text[]);
 req:=public.request_message_template_review_v6(v.id,'Lead requested guide follow-up');
 select id into source_id from public.message_template_review_requests_v6 where canonical_request_id=req;
 perform set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal2"}',true);
 perform public.decide_message_template_inbox_v6(source_id,req,true);
 insert into public.nurture_sequences(client_id,name,purpose,trigger_stage)
 values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Guide follow-up','magnet_follow_up','profile_visit')
 returning * into s;
 insert into public.nurture_sequence_steps(sequence_id,client_id,position,delay_hours,template_version_id)
 values(s.id,s.client_id,1,24,v.id) returning id into step_id;
 begin
  perform public.approve_nurture_sequence_v6(s.id);
  raise exception 'Direct sequence approval succeeded';
 exception when insufficient_privilege then null; end;
 req:=public.request_nurture_sequence_review_v6(s.id);
 select id into source_id from public.nurture_sequence_review_requests_v6 where canonical_request_id=req;
 if req is null or public.request_nurture_sequence_review_v6(s.id)<>req
  or (select status from public.approval_inbox_v6 where id=req)<>'pending' then
  raise exception 'Sequence review was not pending and deduplicated'; end if;
 perform set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal1"}',true);
 begin
  perform public.decide_nurture_sequence_inbox_v6(source_id,req,true);
  raise exception 'AAL1 approved sequence';
 exception when insufficient_privilege then null; end;
 update public.nurture_sequence_steps set delay_hours=48 where id=step_id;
 update public.nurture_sequence_steps set delay_hours=24 where id=step_id;
 if public.nurture_sequence_review_source_state_v6(req)<>'superseded' then
  raise exception 'Reverted step edit revived old review'; end if;
 perform set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal2"}',true);
 begin
  perform public.decide_nurture_sequence_inbox_v6(source_id,req,true);
  raise exception 'Stale sequence was approved';
 exception when check_violation then null; end;
 newer:=public.request_nurture_sequence_review_v6(s.id);
 select id into source_id from public.nurture_sequence_review_requests_v6 where canonical_request_id=newer;
 perform public.decide_nurture_sequence_inbox_v6(source_id,newer,true);
 if (select status from public.approval_inbox_v6 where id=newer)<>'approved'
  or not public.nurture_sequence_approval_current_v6(s.id) then
  raise exception 'Exact sequence approval was not current'; end if;
 if (public.enroll_lead_in_sequence_v6('cccccccc-cccc-4ccc-8ccc-cccccccccccc',s.id)).id is null then
  raise exception 'Approved sequence did not enrol consenting lead'; end if;
 update public.message_templates set name='Changed words context' where id=t.id;
 if public.nurture_sequence_approval_current_v6(s.id) then
  raise exception 'Stale step message still permits sequence enrolment'; end if;
 begin
  perform public.enroll_lead_in_sequence_v6('cccccccc-cccc-4ccc-8ccc-cccccccccccc',s.id);
  raise exception 'Stale sequence permitted enrolment';
 exception when raise_exception then
  if sqlerrm='Stale sequence permitted enrolment' then raise; end if;
 end;
end $checks$;
rollback;

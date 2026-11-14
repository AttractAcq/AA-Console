-- Rollback-only human idea selection and brief-boundary fixture.
begin;
insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','00000000-0000-0000-0000-000000000000',
 'authenticated','authenticated','idea-owner@example.invalid','',now(),now());
insert into public.profiles(id,role,email) values
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','admin','idea-owner@example.invalid');
insert into public.clients(id,name,initials) values
 ('dddddddd-dddd-4ddd-8ddd-dddddddddddd','Idea fixture','IF');
select set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true);
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claims',
 '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal1"}',true);
insert into public.client_ideas(id,client_id,title,body,source,status)
values ('ffffffff-ffff-4fff-8fff-ffffffffffff','dddddddd-dddd-4ddd-8ddd-dddddddddddd',
 'Service problem and buying trigger','A sourced idea for a helpful post','manual','draft'),
 ('11111111-1111-4111-8111-111111111111','dddddddd-dddd-4ddd-8ddd-dddddddddddd',
 'Another distinct buying trigger','A second sourced idea','manual','draft');
do $checks$
declare idea_id uuid:='ffffffff-ffff-4fff-8fff-ffffffffffff';
 second_id uuid:='11111111-1111-4111-8111-111111111111';
 policy_id uuid:='22222222-2222-4222-8222-222222222222';
 slot_id uuid:='33333333-3333-4333-8333-333333333333';
 human_slot_id uuid:='44444444-4444-4444-8444-444444444444';
 human_slot_idea uuid:='55555555-5555-4555-8555-555555555555';
 request_id uuid; review_id uuid; job_id uuid;
begin
 begin
  update public.client_ideas set status='approved' where id=idea_id;
  raise exception 'Direct idea approval succeeded';
 exception when insufficient_privilege then null; end;
 begin
  perform public.approve_idea_and_generate_brief(idea_id);
  raise exception 'Draft idea queued a brief without approval';
 exception when check_violation then null; end;
 begin
  perform public.enqueue_agent_job('brief','dddddddd-dddd-4ddd-8ddd-dddddddddddd',
   'client_ideas',idea_id);
  raise exception 'Direct brief job bypassed idea selection';
 exception when insufficient_privilege then null; end;
 request_id:=public.request_human_idea_review_v6(idea_id);
 select id into review_id from public.human_idea_review_requests_v6
  where canonical_request_id=request_id;
 if request_id is null or public.request_human_idea_review_v6(idea_id)<>request_id
  or (select status from public.approval_inbox_v6 where id=request_id)<>'pending' then
  raise exception 'Human idea request was not pending and deduplicated'; end if;
 begin
  perform public.decide_human_idea_inbox_v6(review_id,request_id,true);
  raise exception 'AAL1 approved an idea';
 exception when insufficient_privilege then null; end;
 update public.client_ideas set title='Edited idea' where id=idea_id;
 update public.client_ideas set title='Service problem and buying trigger' where id=idea_id;
 if public.human_idea_review_source_state_v6(request_id)<>'superseded' then
  raise exception 'Reverted idea edit revived old review'; end if;
 perform set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal2"}',true);
 begin
  perform public.decide_human_idea_inbox_v6(review_id,request_id,true);
  raise exception 'Stale idea review approved';
 exception when check_violation then null; end;
 request_id:=public.request_human_idea_review_v6(idea_id);
 select id into review_id from public.human_idea_review_requests_v6
  where canonical_request_id=request_id;
 perform public.decide_human_idea_inbox_v6(review_id,request_id,true);
 if not public.human_idea_approval_current_v6(idea_id) then
  raise exception 'Exact human idea approval was not current'; end if;
 begin
  perform public.decide_human_idea_inbox_v6(review_id,request_id,true);
  raise exception 'Duplicate idea decision succeeded';
 exception when check_violation then null; end;
 job_id:=public.approve_idea_and_generate_brief(idea_id);
 if job_id is null or (select i.status from public.client_ideas i where i.id=idea_id)<>'briefed'
  or (select i.job_id from public.client_ideas i where i.id=idea_id)<>job_id then
  raise exception 'Current idea approval did not queue the linked brief'; end if;
 if public.approve_idea_and_generate_brief(idea_id)<>job_id then
  raise exception 'Brief queue retry was not idempotent'; end if;
 insert into public.client_briefs(client_id,source_idea_id,title,job_id)
 values ('dddddddd-dddd-4ddd-8ddd-dddddddddddd',idea_id,'Current selected brief',job_id);
 update public.client_ideas set title='Changed after output' where id=idea_id;
 if public.brief_job_selection_current_v6(job_id) then
  raise exception 'Brief job retained current selection after idea edit'; end if;
 begin
  insert into public.client_briefs(client_id,source_idea_id,title,job_id)
  values ('dddddddd-dddd-4ddd-8ddd-dddddddddddd',idea_id,'Stale second output',job_id);
  raise exception 'Stale brief output was inserted';
 exception when insufficient_privilege then null; end;
 request_id:=public.request_human_idea_review_v6(second_id);
 select id into review_id from public.human_idea_review_requests_v6
  where canonical_request_id=request_id;
 perform public.decide_human_idea_inbox_v6(review_id,request_id,true);
 update public.client_ideas set body='Changed after approval' where id=second_id;
 if public.human_idea_approval_current_v6(second_id) then
  raise exception 'Edited approved idea retained current selection'; end if;
 begin
  perform public.approve_idea_and_generate_brief(second_id);
  raise exception 'Stale approved idea queued a brief';
 exception when insufficient_privilege then null; end;
 perform set_config('request.jwt.claim.role','service_role',true);
 insert into public.client_engine_settings(client_id,auto_approve_ideas)
 values ('dddddddd-dddd-4ddd-8ddd-dddddddddddd',true);
 insert into public.content_slots(id,client_id,platform,scheduled_at)
 values (slot_id,'dddddddd-dddd-4ddd-8ddd-dddddddddddd','instagram',now()+interval '1 day');
 perform public.advance_slot(slot_id,'ideating','engine');
 insert into public.client_ideas(id,client_id,title,source,status,slot_id)
 values (policy_id,'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  'Engine-selected idea','auto','draft',slot_id);
 perform public.approve_idea_by_policy(policy_id,slot_id,85,'["scored"]'::jsonb);
 if (select i.approved_request_id from public.client_ideas i where i.id=policy_id) is not null
  or not exists(select 1 from public.engine_decisions d
   where d.idea_id=policy_id and d.kind='idea_selected') then
  raise exception 'Policy selection was misattributed to a human'; end if;
 insert into public.agent_jobs(agent_key,client_id,input_table,input_id)
 values ('brief','dddddddd-dddd-4ddd-8ddd-dddddddddddd','client_ideas',policy_id);
 insert into public.content_slots(id,client_id,platform,scheduled_at)
 values (human_slot_id,'dddddddd-dddd-4ddd-8ddd-dddddddddddd','instagram',now()+interval '2 days');
 perform public.advance_slot(human_slot_id,'ideating','engine');
 perform set_config('request.jwt.claim.role','authenticated',true);
 insert into public.client_ideas(id,client_id,title,source,status,slot_id)
 values (human_slot_idea,'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  'Operator-selected slot idea','auto','draft',human_slot_id);
 request_id:=public.request_human_idea_review_v6(human_slot_idea);
 select id into review_id from public.human_idea_review_requests_v6
  where canonical_request_id=request_id;
 perform public.decide_human_idea_inbox_v6(review_id,request_id,true);
 if not exists(select 1 from public.content_slots s where s.id=human_slot_id
  and s.stage='idea_selected' and s.idea_id=human_slot_idea)
  or not exists(select 1 from public.slot_events e where e.slot_id=human_slot_id
   and e.actor='human' and e.to_stage='idea_selected') then
  raise exception 'Human selection did not advance the waiting Engine slot'; end if;
end $checks$;
rollback;

-- Rollback-only merchant-record reconciliation of one uncertain Google field write.
begin;
insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','00000000-0000-0000-0000-000000000000',
 'authenticated','authenticated','google-reconcile@example.invalid','',now(),now());
insert into public.profiles(id,role,email) values
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','admin','google-reconcile@example.invalid');
insert into public.clients(id,name,initials) values
 ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Google reconciliation fixture','GR');
insert into public.client_google_locations(id,client_id,location_ref,title,verification_state)
values ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
 'accounts/test_account/locations/test_location','Test location','verified');
insert into public.google_profile_changes(id,client_id,location_id,field,current_value,proposed_value,reason)
values ('cccccccc-cccc-4ccc-8ccc-cccccccccccc','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee','description','Old text','New text','Update wording');
select set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true);
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claims',
 '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal2"}',true);
do $test$
declare cid uuid:='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
 change_id uuid:='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
 iid uuid; rid uuid; qid uuid; profile_rid uuid; profile_qid uuid;
 claim jsonb; attempt_id uuid; claim_key uuid; job_id uuid; reconciliation text;
begin
 iid:=public.admin_store_integration_credential(cid,'google_business',
  'accounts/test_account','fixture-secret','write');
 rid:=public.request_integration_grant_v6(iid,false);
 select id into qid from public.integration_grant_reviews_v6 where canonical_request_id=rid;
 perform public.decide_integration_grant_v6(qid,rid,true);
 profile_rid:=public.request_google_profile_review_v6(change_id);
 select id into profile_qid from public.google_profile_review_requests_v6
  where canonical_request_id=profile_rid;
 perform public.decide_google_profile_inbox_v6(profile_qid,profile_rid,true);
 perform set_config('request.jwt.claim.role','service_role',true);
 claim:=public.claim_google_profile_execution_v6(change_id);
 attempt_id:=(claim->>'attempt_id')::uuid;
 claim_key:=(claim->>'claim_key')::uuid;
 if attempt_id is null then raise exception 'No one-shot attempt was reserved'; end if;
 if not public.begin_google_profile_write_v6(attempt_id,claim_key) then
  raise exception 'One-shot attempt did not begin'; end if;
 if not public.finish_google_profile_execution_v6(attempt_id,claim_key,
  'uncertain',null,null,'PATCH response lost') then
  raise exception 'Uncertain one-shot attempt was not recorded'; end if;
 if public.google_profile_reconciliation_target_v6(attempt_id,gen_random_uuid()) is not null then
  raise exception 'Wrong client read the uncertain location target'; end if;
 if public.google_profile_reconciliation_target_v6(attempt_id,cid)->>'field'<>'description' then
  raise exception 'Exact location target unavailable for read-only reconciliation'; end if;
 begin
  perform public.record_google_profile_reconciliation_v6(attempt_id,cid,'New text',
   'locations/wrong#description');
  raise exception 'Wrong location reference reconciled an attempt';
 exception when check_violation then null; end;
 reconciliation:=public.record_google_profile_reconciliation_v6(attempt_id,cid,'Still old',
  'locations/test_location#description');
 if reconciliation<>'different'
  or (select status from public.google_profile_changes where id=change_id)<>'approved'
  or (select o.outcome from public.client_external_outcomes_v6 o where o.outcome_id=attempt_id)<>'different' then
  raise exception 'Different readback did not leave source approved'; end if;
 perform set_config('request.jwt.claim.role','authenticated',true);
 perform set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal1"}',true);
 begin
  perform public.request_google_profile_reconciliation_v6(attempt_id);
  raise exception 'AAL1 queued location reconciliation';
 exception when insufficient_privilege then null; end;
 perform set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal2"}',true);
 job_id:=public.request_google_profile_reconciliation_v6(attempt_id);
 if job_id is null or public.request_google_profile_reconciliation_v6(attempt_id)<>job_id
  or not exists(select 1 from public.agent_jobs j where j.id=job_id
   and j.agent_key='google_profile_field_reconciler'
   and j.input_id=(claim->>'attempt_id')::uuid) then
  raise exception 'One owner-requested read-only job was not queued'; end if;
 perform set_config('request.jwt.claim.role','service_role',true);
 reconciliation:=public.record_google_profile_reconciliation_v6(attempt_id,cid,'New text',
  'locations/test_location#description');
 update public.google_profile_reconciliation_checks_v6 c
  set checked_at='2026-11-15T00:00:00Z'
  where c.attempt_id=(claim->>'attempt_id')::uuid;
 if reconciliation<>'matched'
  or (select status from public.google_profile_changes where id=change_id)<>'applied'
  or (select status from public.google_profile_execution_attempts_v6
   where id=(claim->>'attempt_id')::uuid)<>'uncertain'
  or (select v.reconciliation_result from public.google_profile_execution_overview_v6 v
    where v.attempt_id=(claim->>'attempt_id')::uuid)<>'matched'
  or (select o.outcome from public.client_external_outcomes_v6 o
   where o.outcome_id=(claim->>'attempt_id')::uuid)<>'confirmed' then
  raise exception 'Later match did not resolve source and alert'; end if;
 if public.claim_google_profile_execution_v6(change_id) is not null then
  raise exception 'Reconciled attempt allowed a second field write'; end if;
 perform set_config('request.jwt.claim.role','authenticated',true);
 begin
  perform public.request_google_profile_reconciliation_v6(attempt_id);
  raise exception 'Matched readback queued another reconciliation';
 exception when check_violation then null; end;
end $test$;
rollback;

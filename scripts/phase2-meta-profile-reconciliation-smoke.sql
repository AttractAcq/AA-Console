-- Rollback-only uncertain Facebook Page readback and source reconciliation.
-- No provider request occurs.
begin;
insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','00000000-0000-0000-0000-000000000000',
 'authenticated','authenticated','meta-reconcile@example.invalid','',now(),now());
insert into public.profiles(id,role,email) values
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','admin','meta-reconcile@example.invalid');
insert into public.clients(id,name,initials) values
 ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Meta reconciliation fixture','MR');
insert into public.meta_profile_changes(id,client_id,platform,field,current_value,proposed_value,reason)
values ('cccccccc-cccc-4ccc-8ccc-cccccccccccc','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
 'facebook','about','Old words','New words','Updated positioning');
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
 iid:=public.admin_store_integration_credential(cid,'meta','Facebook Page','fixture-secret','write');
 update public.client_integrations set meta_page_id='123456' where id=iid;
 rid:=public.request_integration_grant_v6(iid,false);
 select id into qid from public.integration_grant_reviews_v6 where canonical_request_id=rid;
 perform public.decide_integration_grant_v6(qid,rid,true);
 profile_rid:=public.request_meta_profile_review_v6(change_id);
 select id into profile_qid from public.meta_profile_review_requests_v6
  where canonical_request_id=profile_rid;
 perform public.decide_meta_profile_inbox_v6(profile_qid,profile_rid,true);
 perform set_config('request.jwt.claim.role','service_role',true);
 claim:=public.claim_meta_profile_execution_v6(change_id);
 attempt_id:=(claim->>'attempt_id')::uuid; claim_key:=(claim->>'claim_key')::uuid;
 if attempt_id is null or not public.begin_meta_profile_write_v6(attempt_id,claim_key)
  or not public.finish_meta_profile_execution_v6(attempt_id,claim_key,
   'uncertain',null,null,'POST response lost') then
  raise exception 'Uncertain one-shot attempt was not recorded'; end if;
 if public.meta_profile_reconciliation_target_v6(attempt_id,gen_random_uuid()) is not null then
  raise exception 'Wrong client read the uncertain Page target'; end if;
 if public.meta_profile_reconciliation_target_v6(attempt_id,cid)->>'page_id'<>'123456' then
  raise exception 'Exact Page target unavailable for read-only reconciliation'; end if;
 begin
  perform public.record_meta_profile_reconciliation_v6(attempt_id,cid,'New words','wrong-page');
  raise exception 'Wrong Page reference reconciled an attempt';
 exception when check_violation then null; end;
 reconciliation:=public.record_meta_profile_reconciliation_v6(attempt_id,cid,'Still old',
  'facebook_page:123456#about');
 if reconciliation<>'different'
  or (select status from public.meta_profile_changes where id=change_id)<>'approved'
  or (select o.outcome from public.client_external_outcomes_v6 o
    where o.outcome_id=(claim->>'attempt_id')::uuid)<>'different' then
  raise exception 'Different readback failed: result %, source %, projection %',
   reconciliation,
   (select status from public.meta_profile_changes where id=change_id),
   (select o.outcome from public.client_external_outcomes_v6 o
    where o.outcome_id=(claim->>'attempt_id')::uuid); end if;
 perform set_config('request.jwt.claim.role','authenticated',true);
 perform set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal1"}',true);
 begin
  perform public.request_meta_profile_reconciliation_v6(attempt_id);
  raise exception 'AAL1 queued Page reconciliation';
 exception when insufficient_privilege then null; end;
 perform set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal2"}',true);
 job_id:=public.request_meta_profile_reconciliation_v6(attempt_id);
 if job_id is null or public.request_meta_profile_reconciliation_v6(attempt_id)<>job_id
  or not exists(select 1 from public.agent_jobs where id=job_id
   and agent_key='meta_profile_field_reconciler' and input_id=attempt_id) then
  raise exception 'One owner-requested read-only job was not queued'; end if;
 perform set_config('request.jwt.claim.role','service_role',true);
 reconciliation:=public.record_meta_profile_reconciliation_v6(attempt_id,cid,'New words',
  'facebook_page:123456#about');
 -- Force equal timestamps: a matched resolution must win over a prior
 -- different observation regardless of UUID ordering.
 update public.meta_profile_reconciliation_checks_v6 c
  set checked_at='2026-11-15T00:00:00Z'
  where c.attempt_id=(claim->>'attempt_id')::uuid;
 if reconciliation<>'matched'
  or (select status from public.meta_profile_changes where id=change_id)<>'applied'
  or (select status from public.meta_profile_execution_attempts_v6 where id=attempt_id)<>'uncertain'
  or (select v.reconciliation_result from public.meta_profile_execution_overview_v6 v
   where v.attempt_id=(claim->>'attempt_id')::uuid)<>'matched'
  or (select o.outcome from public.client_external_outcomes_v6 o
   where o.outcome_id=(claim->>'attempt_id')::uuid)<>'confirmed' then
  raise exception 'Matched later readback failed: result %, source %, attempt %, overview %',
   reconciliation,
   (select status from public.meta_profile_changes where id=change_id),
   (select status from public.meta_profile_execution_attempts_v6 where id=attempt_id),
   (select v.reconciliation_result from public.meta_profile_execution_overview_v6 v
    where v.attempt_id=(claim->>'attempt_id')::uuid); end if;
 if public.claim_meta_profile_execution_v6(change_id) is not null then
  raise exception 'Reconciled attempt allowed a second Page write'; end if;
 perform set_config('request.jwt.claim.role','authenticated',true);
 begin
  perform public.request_meta_profile_reconciliation_v6(attempt_id);
  raise exception 'Matched Page readback queued another reconciliation';
 exception when check_violation then null; end;
end $test$;
rollback;

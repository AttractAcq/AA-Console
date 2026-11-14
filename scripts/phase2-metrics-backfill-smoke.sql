-- Rollback-only review of an exact manual provider quota pull.
begin;
insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','00000000-0000-0000-0000-000000000000',
 'authenticated','authenticated','backfill-admin@example.invalid','',now(),now());
insert into public.profiles(id,role,email) values
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','admin','backfill-admin@example.invalid');
insert into public.clients(id,name,initials) values
 ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Backfill fixture','BF');
select set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true);
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claims',
 '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal2"}',true);
do $test$
declare cid uuid:='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
 integration_id uuid; grant_request uuid; grant_review uuid;
 review_request uuid; review_id uuid; jobs uuid[]; old_request uuid;
 provider_key text;
begin
 for provider_key in select unnest(array['meta','instagram']) loop
  integration_id:=public.admin_store_integration_credential(
   cid,provider_key,'fixture-'||provider_key,'secret-'||provider_key,'read');
  grant_request:=public.request_integration_grant_v6(integration_id,false);
  select id into grant_review from public.integration_grant_reviews_v6
   where canonical_request_id=grant_request;
  perform public.decide_integration_grant_v6(grant_review,grant_request,true);
 end loop;
 select id into integration_id from public.client_integrations
  where client_id=cid and provider='meta';
 grant_request:=public.request_integration_grant_v6(integration_id,true);
 select id into grant_review from public.integration_grant_reviews_v6
  where canonical_request_id=grant_request;
 perform public.decide_integration_grant_v6(grant_review,grant_request,true);
 begin
  perform public.request_metrics_backfill(cid,'2026-10-01','2026-10-07',null);
  raise exception 'Direct manual backfill queued work';
 exception when insufficient_privilege then null; end;
 begin
  insert into public.agent_jobs(agent_key,client_id,params)
   values('metrics_ingest',cid,
    '{"backfill":true,"surface":"paid","since":"2026-10-01","until":"2026-10-07"}');
  raise exception 'Direct job insert bypassed backfill review';
 exception when insufficient_privilege then null; end;
 begin
  insert into public.agent_jobs(agent_key,client_id,params)
   values('metrics_ingest',cid,
    '{"surface":"paid","since":"2026-10-01","until":"2026-10-07"}');
  raise exception 'Admin disguised a manual backfill as an ordinary pull';
 exception when insufficient_privilege then null; end;
 perform set_config('request.jwt.claim.role','service_role',true);
 begin
  insert into public.agent_jobs(agent_key,client_id,params)
   values('metrics_ingest',cid,
    '{"surface":"paid","since":"2026-09-01","until":"2026-09-07"}');
  raise exception 'Service role bypassed the trusted daily scheduler';
 exception when insufficient_privilege then null; end;
 if public.enqueue_metrics_ingest_jobs(7)<>1 then
  raise exception 'Trusted daily scheduler could not queue its ordinary pull'; end if;
 perform set_config('request.jwt.claim.role','authenticated',true);
 review_request:=public.request_metrics_backfill_review_v6(
  cid,'2026-10-01','2026-10-07','both');
 select id into review_id from public.metrics_backfill_reviews_v6
  where canonical_request_id=review_request;
 if review_id is null or public.request_metrics_backfill_review_v6(
  cid,'2026-10-01','2026-10-07','both')<>review_request
  or (select status from public.approval_inbox_v6 where id=review_request)<>'pending'
  then raise exception 'Exact backfill card missing or not deduplicated'; end if;
 perform set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal1"}',true);
 begin
  perform public.decide_metrics_backfill_review_v6(review_id,review_request,true);
  raise exception 'AAL1 queued metrics work';
 exception when insufficient_privilege then null; end;
 perform set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal2"}',true);
 jobs:=public.decide_metrics_backfill_review_v6(review_id,review_request,true);
 if cardinality(jobs)<>2
  or (select count(*) from public.agent_jobs where id=any(jobs))<>2
  or (select status from public.approval_inbox_v6 where id=review_request)<>'approved'
  then raise exception 'Exact two-surface backfill did not queue'; end if;
 begin
  perform public.decide_metrics_backfill_review_v6(review_id,review_request,true);
  raise exception 'Duplicate backfill decision queued work';
 exception when check_violation then null; end;
 old_request:=public.request_metrics_backfill_review_v6(
  cid,'2026-10-08','2026-10-14','paid');
 update public.client_integrations set credential_label='changed-meta'
  where client_id=cid and provider='meta';
 if (select status from public.approval_inbox_v6 where id=old_request)<>'superseded' then
  raise exception 'Provider account change left a pending backfill current'; end if;
 update public.client_integrations set credential_label='fixture-meta'
  where client_id=cid and provider='meta';
 if (select status from public.approval_inbox_v6 where id=old_request)<>'superseded' then
  raise exception 'Reverted provider label revived a stale backfill card'; end if;
end $test$;
rollback;

-- Rollback-only exact access grant and daily-ingest authorization.
begin;
insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','00000000-0000-0000-0000-000000000000',
 'authenticated','authenticated','grant-admin@example.invalid','',now(),now());
insert into public.profiles(id,role,email) values
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','admin','grant-admin@example.invalid');
insert into public.clients(id,name,initials) values
 ('dddddddd-dddd-4ddd-8ddd-dddddddddddd','Grant fixture','GF'),
 ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee','Other grant fixture','OG');
select set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true);
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claims',
 '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal1"}',true);
do $checks$
declare cid uuid:='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
 integration_id uuid; request_id uuid; review_id uuid;
begin
 integration_id:=public.admin_store_integration_credential(cid,'meta','act_123','fixture-secret','read');
 if (select status from public.client_integrations where id=integration_id)<>'pending_grant'
  or (select ingest_enabled from public.client_integrations where id=integration_id)
  or public.integration_secret(cid,'meta') is not null then
  raise exception 'Stored credential was usable before access review'; end if;
 begin
  update public.client_integrations set status='connected' where id=integration_id;
  raise exception 'Direct status promotion succeeded';
 exception when insufficient_privilege then null; end;
 begin
  update public.client_integrations set ingest_enabled=true where id=integration_id;
  raise exception 'Direct ingest enable succeeded';
 exception when insufficient_privilege then null; end;
 update public.client_integrations set status='error' where id=integration_id;
 begin
  update public.client_integrations set status='connected' where id=integration_id;
  raise exception 'Pending-to-error-to-connected bypass succeeded';
 exception when insufficient_privilege then null; end;
 update public.client_integrations set status='pending_grant' where id=integration_id;
 request_id:=public.request_integration_grant_v6(integration_id,true);
 select id into review_id from public.integration_grant_reviews_v6 where canonical_request_id=request_id;
 if public.request_integration_grant_v6(integration_id,true)<>request_id
  or (select status from public.approval_inbox_v6 where id=request_id)<>'pending'
  or (select preview->>'credential_version_hash' from public.approval_inbox_v6 where id=request_id) is null
  or (select preview::text from public.approval_inbox_v6 where id=request_id) like '%fixture-secret%'
  then raise exception 'Grant request was not exact, deduplicated and secret-free'; end if;
 begin
  perform public.decide_integration_grant_v6(review_id,request_id,true);
  raise exception 'AAL1 granted provider access';
 exception when insufficient_privilege then null; end;
 begin
  update public.client_integrations set access_level='write' where id=integration_id;
  raise exception 'Direct access-level edit succeeded';
 exception when insufficient_privilege then null; end;
 update public.client_integrations set ad_account_id='act_999' where id=integration_id;
 update public.client_integrations set ad_account_id=null where id=integration_id;
 if public.integration_grant_source_state_v6(request_id)<>'superseded' then
  raise exception 'Reverting scope revived an old grant'; end if;
 perform set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal2"}',true);
 begin
  perform public.decide_integration_grant_v6(review_id,request_id,true);
  raise exception 'Stale grant was approved';
 exception when check_violation then null; end;
 request_id:=public.request_integration_grant_v6(integration_id,true);
 select id into review_id from public.integration_grant_reviews_v6 where canonical_request_id=request_id;
 perform public.decide_integration_grant_v6(review_id,request_id,true);
 if (select status from public.client_integrations where id=integration_id)<>'connected'
  or not (select ingest_enabled from public.client_integrations where id=integration_id)
  or public.integration_secret(cid,'meta')<>'fixture-secret'
  or (select status from public.approval_inbox_v6 where id=request_id)<>'approved'
  then raise exception 'Exact grant failed to release credential and daily ingest'; end if;
 begin
  perform public.decide_integration_grant_v6(review_id,request_id,true);
  raise exception 'Duplicate grant decision succeeded';
 exception when check_violation then null; end;
 update public.client_integrations set ingest_enabled=false where id=integration_id;
 if (select ingest_enabled from public.client_integrations where id=integration_id) then
  raise exception 'Daily ingest could not be stopped immediately'; end if;
 begin
  update public.client_integrations set ingest_enabled=true where id=integration_id;
  raise exception 'Old grant re-enabled ingest';
 exception when insufficient_privilege then null; end;
 update public.client_integrations set meta_page_id='123456' where id=integration_id;
 if (select status from public.client_integrations where id=integration_id)<>'pending_grant'
  or (select ingest_enabled from public.client_integrations where id=integration_id)
  or public.integration_secret(cid,'meta') is not null then
  raise exception 'Changing the approved account scope kept credential use live'; end if;
 request_id:=public.request_integration_grant_v6(integration_id,false);
 select id into review_id from public.integration_grant_reviews_v6 where canonical_request_id=request_id;
 perform public.decide_integration_grant_v6(review_id,request_id,true);
 if public.integration_secret(cid,'meta')<>'fixture-secret'
  or (select ingest_enabled from public.client_integrations where id=integration_id) then
  raise exception 'New exact scope grant did not restore read-only access'; end if;
end $checks$;
rollback;

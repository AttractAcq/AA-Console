-- Rollback-only budget credential gate; no Meta provider call.
begin;
insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','00000000-0000-0000-0000-000000000000',
 'authenticated','authenticated','meta-budget-grant@example.invalid','',now(),now());
insert into public.profiles(id,role,email) values
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','admin','meta-budget-grant@example.invalid');
insert into public.clients(id,name,initials) values
 ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Budget grant fixture','BG');
select set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true);
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claims',
 '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal2"}',true);
do $test$
declare cid uuid:='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
 iid uuid; rid uuid; qid uuid;
begin
 iid:=public.admin_store_integration_credential(cid,'meta','act_123','fixture-secret','write');
 update public.client_integrations set ad_account_id='act_123' where id=iid;
 perform set_config('request.jwt.claim.role','service_role',true);
 if public.meta_budget_credential_eligible_v6(cid) then
  raise exception 'Unreviewed Meta credential passed the spend gate'; end if;
 perform set_config('request.jwt.claim.role','authenticated',true);
 rid:=public.request_integration_grant_v6(iid,false);
 select id into qid from public.integration_grant_reviews_v6 where canonical_request_id=rid;
 perform public.decide_integration_grant_v6(qid,rid,true);
 if public.meta_budget_credential_eligible_v6(cid) then
  raise exception 'Authenticated caller received service-only credential authority'; end if;
 perform set_config('request.jwt.claim.role','service_role',true);
 if not public.meta_budget_credential_eligible_v6(cid) then
  raise exception 'Exact reviewed Meta write grant did not pass'; end if;
 update public.client_integrations set ad_account_id='act_456' where id=iid;
 if public.meta_budget_credential_eligible_v6(cid) then
  raise exception 'Changed account kept old spend authority'; end if;
end $test$;
rollback;

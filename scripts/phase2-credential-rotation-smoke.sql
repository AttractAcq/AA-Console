-- Rollback-only check: replacing a credential cannot silently resume daily ingest.
begin;
insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','00000000-0000-0000-0000-000000000000',
 'authenticated','authenticated','integration-admin@example.invalid','',now(),now());
insert into public.profiles(id,role,email) values
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','admin','integration-admin@example.invalid');
insert into public.clients(id,name,initials) values
 ('dddddddd-dddd-4ddd-8ddd-dddddddddddd','Integration fixture','IF');
select set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true);
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claims',
 '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal1"}',true);
do $checks$
declare cid uuid:='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
 integration_id uuid; old_secret uuid; new_secret uuid; request_id uuid; review_id uuid;
begin
 integration_id:=public.admin_store_integration_credential(cid,'meta','act_123','fixture-secret-one','read');
 select credential_secret_id into old_secret from public.client_integrations where id=integration_id;
 if old_secret is null or (select ingest_enabled from public.client_integrations where id=integration_id)
  or (select status from public.client_integrations where id=integration_id)<>'pending_grant' then
  raise exception 'New credential did not start with daily ingest off'; end if;
 request_id:=public.request_integration_grant_v6(integration_id,true);
 select id into review_id from public.integration_grant_reviews_v6 where canonical_request_id=request_id;
 perform set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal2"}',true);
 perform public.decide_integration_grant_v6(review_id,request_id,true);
 update public.client_integrations set last_checked_at=now(),status='active' where id=integration_id;
 if public.admin_store_integration_credential(cid,'meta','act_123','fixture-secret-two','read')<>integration_id then
  raise exception 'Credential replacement changed the integration identity'; end if;
 select credential_secret_id into new_secret from public.client_integrations where id=integration_id;
 if new_secret is null or new_secret=old_secret
  or (select decrypted_secret from vault.decrypted_secrets where id=new_secret)<>'fixture-secret-two'
  or (select decrypted_secret from vault.decrypted_secrets where id=old_secret)<>'fixture-secret-one'
  or (select ingest_enabled from public.client_integrations where id=integration_id)
  or (select last_checked_at from public.client_integrations where id=integration_id) is not null
  or (select status from public.client_integrations where id=integration_id)<>'pending_grant'
  or public.integration_secret(cid,'meta') is not null then
  raise exception 'Credential replacement retained an old ingest grant or health result'; end if;
end $checks$;
rollback;

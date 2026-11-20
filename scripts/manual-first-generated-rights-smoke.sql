-- Rollback-only generated creative rights and exact-review contract.
begin;
insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
values ('a1630000-0000-4000-8000-000000000001','00000000-0000-0000-0000-000000000000',
  'authenticated','authenticated','rights-admin@example.invalid','',now(),now());
insert into public.profiles(id,role,email) values
  ('a1630000-0000-4000-8000-000000000001','admin','rights-admin@example.invalid');
insert into public.clients(id,name,initials) values
  ('b1630000-0000-4000-8000-000000000001','Generated rights fixture','GR');
insert into public.client_media_assets
  (id,client_id,media_type,content_format,title,storage_path,edit_stage)
values ('c1630000-0000-4000-8000-000000000001',
  'b1630000-0000-4000-8000-000000000001','image','single','Generated image',
  'rights-fixture/generated.png','review_ready');
insert into storage.objects(id,bucket_id,name,version) values
  ('d1630000-0000-4000-8000-000000000001','client-media',
  'rights-fixture/generated.png','v1');
select set_config('request.jwt.claim.role','service_role',true);
select set_config('request.jwt.claims','{"role":"service_role"}',true);
select public.attest_creative_storage_bytes_v6(
  'c1630000-0000-4000-8000-000000000001','rights-fixture/generated.png',
  repeat('a',64),18,'d1630000-0000-4000-8000-000000000001','v1',
  (select updated_at from storage.objects where name='rights-fixture/generated.png'));
insert into public.creative_generations(id,client_id,media_type)
values ('e1630000-0000-4000-8000-000000000001',
  'b1630000-0000-4000-8000-000000000001','image');
insert into public.creative_renders(id,generation_id,client_id,status,asset_id)
values ('f1630000-0000-4000-8000-000000000001',
  'e1630000-0000-4000-8000-000000000001',
  'b1630000-0000-4000-8000-000000000001','done',
  'c1630000-0000-4000-8000-000000000001');
select set_config('request.jwt.claim.sub','a1630000-0000-4000-8000-000000000001',true);
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claims',
  '{"sub":"a1630000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal1"}',true);

do $checks$
declare aid uuid:='c1630000-0000-4000-8000-000000000001';
  did uuid; rid uuid; q public.ordinary_media_review_requests_v6%rowtype;
  v_preview jsonb;
begin
  begin
    perform public.request_ordinary_media_review_v6(aid);
    raise exception 'Generated file reached review without declared rights';
  exception when check_violation then null; end;
  begin
    perform public.declare_generated_creative_rights_v8(aid,'client_owned','Too short');
    raise exception 'Unsupported rights basis was accepted';
  exception when check_violation then null; end;
  did:=public.declare_generated_creative_rights_v8(aid,'agency_owned',
    'Agency owns the supplied source image and the generated output.');
  if did is null or (select usage_rights from public.client_media_assets where id=aid)<>'agency_owned'
    or public.generated_creative_rights_source_hash_v8(aid) is null then
    raise exception 'Exact rights declaration did not bind the current file'; end if;
  rid:=public.request_ordinary_media_review_v6(aid);
  select * into q from public.ordinary_media_review_requests_v6
    where canonical_request_id=rid;
  select preview into v_preview from public.approval_requests_v6 where id=rid;
  if q.rights_declaration_id is distinct from did
    or v_preview#>>'{rights_declaration,basis}'<>
      'Agency owns the supplied source image and the generated output.'
    or public.ordinary_media_review_source_state_v6(rid)<>'pending' then
    raise exception 'Creative review did not freeze human rights evidence'; end if;
  update storage.objects set version='v2' where name='rights-fixture/generated.png';
  if public.generated_creative_rights_source_hash_v8(aid) is not null
    or public.ordinary_media_review_source_state_v6(rid)='pending' then
    raise exception 'Replaced Storage object retained rights or review authority'; end if;
  begin
    perform public.declare_generated_creative_rights_v8(aid,'agency_owned',
      'Agency owns the supplied source image and the generated output.');
    raise exception 'Stale file was allowed a new declaration';
  exception when check_violation then null; end;
  if (select rights_declaration_id from public.ordinary_media_review_requests_v6
      where id=q.id) is distinct from did then
    raise exception 'Historical rights declaration binding was lost'; end if;
end $checks$;
rollback;

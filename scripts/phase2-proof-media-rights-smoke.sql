-- Rollback-only proof of trusted media identity, AAL2 clearance and storage revocation.
begin;
insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','00000000-0000-0000-0000-000000000000',
  'authenticated','authenticated','media-admin@example.invalid','',now(),now());
insert into public.profiles(id,role,email) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','admin','media-admin@example.invalid');
insert into public.clients(id,name,initials) values
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Media proof fixture','MP');
select set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true);
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal1"}',true);

do $checks$
declare p public.client_proof_assets%rowtype;
  o storage.objects%rowtype;
  request_id uuid;
  rights_id uuid;
  pending_id uuid;
  pending_source_id uuid;
  media_hash text := repeat('a',64);
begin
  insert into public.client_proof_assets(client_id,media_type,title,storage_path,source)
    values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','image','Customer photo',
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/media-proof/photo.png','Customer upload')
    returning * into p;
  insert into storage.objects(bucket_id,name,version)
    values ('proof',p.storage_path,'v1') returning * into o;
  begin
    perform public.proof_storage_identity_v6(p.id);
    raise exception 'Browser read private Storage identity';
  exception when insufficient_privilege then null; end;
  perform set_config('request.jwt.claim.role','service_role',true);
  begin
    perform public.request_proof_media_rights_v6(p.id,'Signed image release',null,
      media_hash,100,o.id,'wrong-version',o.updated_at,
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    raise exception 'Changed Storage identity made a rights request';
  exception when check_violation then null; end;
  request_id := public.request_proof_media_rights_v6(p.id,'Signed image release',null,
    media_hash,100,o.id,o.version,o.updated_at,
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  select id into rights_id from public.proof_rights_requests_v6
    where canonical_request_id=request_id;
  if rights_id is null or public.proof_rights_source_state_v6(request_id) <> 'pending'
    or (select preview->>'verified_storage_sha256' from public.approval_inbox_v6
      where id=request_id) <> media_hash then
    raise exception 'Media request lacks a verified exact-byte preview'; end if;
  perform set_config('request.jwt.claim.role','authenticated',true);
  begin
    perform public.approve_proof_rights_v6(rights_id,request_id);
    raise exception 'AAL1 cleared media rights';
  exception when insufficient_privilege then null; end;
  perform set_config('request.jwt.claims',
    '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal2"}',true);
  perform public.approve_proof_rights_v6(rights_id,request_id);
  if (select usage_rights from public.client_proof_assets where id=p.id) <> 'approved'
    or (select status from public.approval_inbox_v6 where id=request_id) <> 'approved'
    then raise exception 'Exact media decision did not clear rights'; end if;
  update storage.objects set metadata = jsonb_build_object('changed',true) where id=o.id;
  if (select usage_rights from public.client_proof_assets where id=p.id) <> 'not_cleared'
    or not exists (select 1 from public.proof_rights_storage_invalidations_v6
      where rights_request_id=rights_id)
    or (select status from public.approval_inbox_v6 where id=request_id) = 'approved'
    then raise exception 'Storage change retained media clearance'; end if;
  perform set_config('request.jwt.claim.role','service_role',true);
  select * into o from storage.objects where id=o.id;
  pending_id := public.request_proof_media_rights_v6(p.id,'Signed image release',null,
    repeat('b',64),101,o.id,o.version,o.updated_at,
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  select id into pending_source_id from public.proof_rights_requests_v6
    where canonical_request_id=pending_id;
  if pending_id = request_id or public.proof_rights_source_state_v6(pending_id) <> 'pending'
    then raise exception 'A fresh file could not form a new review epoch'; end if;
  update storage.objects set metadata = jsonb_build_object('changed',false) where id=o.id;
  if public.proof_rights_source_state_v6(pending_id) <> 'superseded'
    then raise exception 'A pending media request survived a Storage change'; end if;
  perform set_config('request.jwt.claim.role','authenticated',true);
  begin
    perform public.approve_proof_rights_v6(pending_source_id,pending_id);
    raise exception 'Stale media request was approved';
  exception when check_violation then null; end;
end $checks$;
rollback;

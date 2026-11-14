-- Rollback-only trusted creative-byte attestation fixture.
begin;
insert into public.clients(id,name,initials) values
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Creative attestation fixture','CA');
insert into public.client_media_assets
  (id,client_id,media_type,title,storage_path) values
  ('cccccccc-cccc-4ccc-8ccc-cccccccccccc',
   'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','image','Creative fixture',
   'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/creative.png');
insert into storage.objects(id,bucket_id,name,version) values
  ('dddddddd-dddd-4ddd-8ddd-dddddddddddd','client-media',
   'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/creative.png','v1');

do $checks$
declare identity jsonb;
  attested uuid;
begin
  perform set_config('request.jwt.claim.role','authenticated',true);
  begin
    perform public.creative_storage_identity_v6(
      'cccccccc-cccc-4ccc-8ccc-cccccccccccc');
    raise exception 'Browser read trusted creative Storage identity';
  exception when insufficient_privilege then null; end;
  perform set_config('request.jwt.claim.role','service_role',true);
  identity := public.creative_storage_identity_v6(
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc');
  if identity->>'client_id' <> 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    or identity->>'object_id' <> 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
    then raise exception 'Creative Storage identity was not bound to the asset'; end if;
  begin
    perform public.attest_creative_storage_bytes_v6(
      'cccccccc-cccc-4ccc-8ccc-cccccccccccc',identity->>'storage_path',
      repeat('a',64),14,'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      identity->>'object_version',(identity->>'object_updated_at')::timestamptz);
    raise exception 'Wrong Storage object identity was accepted';
  exception when check_violation then null; end;
  attested := public.attest_creative_storage_bytes_v6(
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc',identity->>'storage_path',
    repeat('a',64),14,(identity->>'object_id')::uuid,
    identity->>'object_version',(identity->>'object_updated_at')::timestamptz);
  if attested <> 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    or (select delivery_bytes_sha256 from public.client_media_assets
      where id=attested) <> repeat('a',64) then
    raise exception 'Trusted creative digest did not bind to the asset'; end if;
  update storage.objects set version='v2' where id='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  if (select delivery_bytes_sha256 from public.client_media_assets
    where id=attested) is not null then
    raise exception 'Storage mutation left the trusted digest current'; end if;
end $checks$;
rollback;

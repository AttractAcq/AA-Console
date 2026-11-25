-- Rollback-only, signed-in editor test for a stale revision, exclusion and retry.
begin;
insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','00000000-0000-0000-0000-000000000000',
  'authenticated','authenticated','proof-admin@example.invalid','',now(),now());
insert into public.profiles(id,role,email) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','admin','proof-admin@example.invalid');
insert into public.clients(id,name,initials) values
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Proof rights fixture','PR');
select set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true);
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal1"}',true);

insert into public.client_proof_assets(client_id,media_type,title,body,source)
  values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','text','Example fixture','Fixture','QA') returning id as proof_id \gset
insert into public.client_briefs(id,client_id,title,media_type,content_format,body,proof,proof_asset_id)
  values ('dddddddd-dddd-4ddd-8ddd-dddddddddddd','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Fixture',
    'image','single',E'## Script\n\nQuestion\n\n## Proof\n\nOld source\n\n## Visual direction\n\nFictional example','Old source',:'proof_id');
set local role authenticated;
do $fixture$
declare
  b public.client_briefs%rowtype;
  changed public.client_briefs%rowtype;
begin
  select * into strict b from public.client_briefs where id='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  begin
    perform public.exclude_brief_artwork_proof(b.client_id,b.id,b.updated_at-interval '1 second',b.proof_asset_id);
    raise exception 'Unexpected stale edit';
  exception when raise_exception then if sqlerrm like 'Unexpected%' then raise; end if; end;
  perform public.exclude_brief_artwork_proof(b.client_id,b.id,b.updated_at,b.proof_asset_id);
  perform public.exclude_brief_artwork_proof(b.client_id,b.id,b.updated_at,b.proof_asset_id);
  select * into strict changed from public.client_briefs where id=b.id;
  if changed.proof_asset_id is not null or changed.excluded_artwork_proof_id is distinct from b.proof_asset_id
     or changed.body is distinct from replace(b.body,b.proof,changed.proof)
     or changed.proof is distinct from 'Use an independent illustration. No proof asset supplies the artwork.'
     or changed.status <> 'draft' then raise exception 'Artwork source or brief changed unexpectedly.'; end if;
end $fixture$;
rollback;

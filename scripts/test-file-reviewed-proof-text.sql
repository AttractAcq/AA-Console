-- Rollback-only operator filing, using real rights decisions and storage identity.
begin;
insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','00000000-0000-0000-0000-000000000000',
  'authenticated','authenticated','proof-admin@example.invalid','',now(),now()),
  ('cccccccc-cccc-4ccc-8ccc-cccccccccccc','00000000-0000-0000-0000-000000000000',
  'authenticated','authenticated','proof-outsider@example.invalid','',now(),now());
insert into public.profiles(id,role,email) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','admin','proof-admin@example.invalid'),
  ('cccccccc-cccc-4ccc-8ccc-cccccccccccc','client','proof-outsider@example.invalid');
insert into public.clients(id,name,initials) values
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Proof rights fixture','PR');
select set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true);
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal1"}',true);

select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal2"}',true);
insert into public.client_proof_assets(client_id,media_type,title,body,source)
  values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','text','Synthetic test',
    E'Synthetic test — exact text.\n','QA') returning id as proof_id \gset
select public.request_proof_rights_v6(:'proof_id','Original fictional text, approved for exact use') as rights_id \gset
select public.approve_proof_rights_v6(id,canonical_request_id)
  from public.proof_rights_requests_v6 where canonical_request_id=:'rights_id';
select public.request_proof_production_v2('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',:'proof_id',null,'text','single','Use verbatim','Organic Social Media');
insert into public.client_briefs(id,client_id,title,body,script,media_type,source_idea_id,job_id,proof_asset_id)
select 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',r.client_id,'Synthetic fixture',p.body,p.body,
  'text',r.idea_id,r.job_id,p.id from public.proof_production_requests r
  join public.client_proof_assets p on p.id=r.source_proof_id where r.id='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
select set_config('request.jwt.claim.role','service_role',true);
select set_config('request.jwt.claims','{"role":"service_role"}',true);
set local role service_role;
do $fixture$
declare
  actor uuid := 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  client uuid := 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  req uuid := 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  b public.client_briefs%rowtype;
  rights uuid;
  prepared jsonb;
  identity jsonb;
  filed jsonb;
begin
  select * into strict b from public.client_briefs where id='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  select approved_rights_request_id into strict rights from public.client_proof_assets where id=b.proof_asset_id;
  if has_function_privilege('authenticated','public.file_reviewed_proof_text(uuid,uuid,uuid,timestamptz,uuid,uuid,jsonb)','execute')
    then raise exception 'Unexpected direct browser grant'; end if;
  begin
    perform public.file_reviewed_proof_text(client,req,b.id,b.updated_at,rights,'cccccccc-cccc-4ccc-8ccc-cccccccccccc');
    raise exception 'Unexpected reviewer access';
  exception when insufficient_privilege then null; end;
  begin
    perform public.file_reviewed_proof_text(client,req,b.id,b.updated_at-interval '1 second',rights,actor);
    raise exception 'Unexpected stale revision accepted';
  exception when raise_exception then if sqlerrm like 'Unexpected%' then raise; end if; end;
  begin
    update public.client_briefs set script=script||'extra' where id=b.id;
    perform public.file_reviewed_proof_text(client,req,b.id,b.updated_at,rights,actor);
    raise exception 'Unexpected non-verbatim filing';
  exception when raise_exception then
    if sqlerrm <> 'The reviewed Script must match the currently cleared raw text exactly.' then raise; end if;
  end;
  prepared:=public.file_reviewed_proof_text(client,req,b.id,b.updated_at,rights,actor);
  if prepared->>'script' is distinct from b.script then raise exception 'Script differs'; end if;
  insert into storage.objects(bucket_id,name,version) values ('client-media',prepared->>'path','v1');
  identity:=public.file_reviewed_proof_text(client,req,b.id,b.updated_at,rights,actor)->'object';
  begin
    perform public.file_reviewed_proof_text(client,req,b.id,b.updated_at,rights,actor,identity||'{"version":"changed"}');
    raise exception 'Unexpected storage identity accepted';
  exception when raise_exception then if sqlerrm like 'Unexpected%' then raise; end if; end;
  filed:=public.file_reviewed_proof_text(client,req,b.id,b.updated_at,rights,actor,identity);
  if filed->>'asset_id' is distinct from req::text
    or public.file_reviewed_proof_text(client,req,b.id,b.updated_at,rights,actor) is distinct from filed
    or not exists(select 1 from public.client_media_assets a where a.id=req and a.client_id=client
      and a.brief_id=b.id and a.review_status='pending' and a.uploaded_by=actor
      and a.delivery_bytes_sha256=encode(sha256(convert_to(b.script,'UTF8')),'hex'))
    or not exists(select 1 from public.proof_production_counts_v7 c where c.request_id=req
      and c.produced=1 and c.awaiting_review=1 and c.attempts=1 and c.render_cost_usd=0)
    then raise exception 'Filing, retry or Produced source receipt differs'; end if;
end $fixture$;
rollback;

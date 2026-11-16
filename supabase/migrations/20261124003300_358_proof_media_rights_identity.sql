-- The browser never supplies a media digest. The trusted runtime hashes the
-- stored object, then asks the database to bind that digest to the object's
-- current identity. Later Storage changes invalidate pending and approved use.
begin;
alter table public.proof_rights_requests_v6
  add column verified_storage_sha256 text check (
    verified_storage_sha256 is null or verified_storage_sha256 ~ '^[0-9a-f]{64}$'),
  add column verified_file_bytes bigint check (verified_file_bytes is null or verified_file_bytes > 0),
  add column verified_storage_path text,
  add column verified_storage_object_id uuid,
  add column verified_storage_object_version text,
  add column verified_storage_object_updated_at timestamptz,
  add constraint proof_media_verification_complete_v6 check (
    (verified_storage_sha256 is null and verified_file_bytes is null
      and verified_storage_path is null and verified_storage_object_id is null
      and verified_storage_object_version is null and verified_storage_object_updated_at is null)
    or (verified_storage_sha256 is not null and verified_file_bytes is not null
      and verified_storage_path is not null and verified_storage_object_id is not null
      and verified_storage_object_updated_at is not null));

create table public.proof_rights_storage_invalidations_v6 (
  rights_request_id uuid primary key references public.proof_rights_requests_v6(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  proof_id uuid not null references public.client_proof_assets(id) on delete cascade,
  storage_object_id uuid,
  reason text not null,
  invalidated_at timestamptz not null default now()
);
alter table public.proof_rights_storage_invalidations_v6 enable row level security;
revoke all on public.proof_rights_storage_invalidations_v6
  from public,anon,authenticated,service_role;

create function public.proof_storage_identity_v6(p_proof_id uuid)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, storage as $$
declare p public.client_proof_assets%rowtype;
  o storage.objects%rowtype;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Only the trusted verifier may read proof storage identity.'
      using errcode = '42501'; end if;
  select * into p from public.client_proof_assets where id = p_proof_id;
  if p.id is null or p.media_type not in ('image','video') or p.storage_path is null
    then raise exception 'Stored image or video proof is required.' using errcode = '23514'; end if;
  select * into o from storage.objects where bucket_id = 'proof' and name = p.storage_path;
  if o.id is null then raise exception 'Proof file is missing from Storage.' using errcode = '23514'; end if;
  return jsonb_build_object('proof_id',p.id,'client_id',p.client_id,
    'storage_path',p.storage_path,'object_id',o.id,
    'object_version',o.version,'object_updated_at',o.updated_at);
end $$;

create function public.invalidate_proof_media_rights_storage_v6()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public, storage set timezone = 'UTC' as $$
declare changed_path text;
begin
  if tg_op = 'DELETE' then
    if old.bucket_id <> 'proof' then return null; end if;
  elsif old.bucket_id <> 'proof' and new.bucket_id <> 'proof' then
    return null;
  end if;
  if tg_op = 'UPDATE' and new.bucket_id = 'proof' then changed_path := new.name; end if;
  insert into public.proof_rights_storage_invalidations_v6
    (rights_request_id,client_id,proof_id,storage_object_id,reason)
  select q.id,q.client_id,q.proof_id,old.id,
    'Stored proof file was changed or removed after byte verification.'
  from public.proof_rights_requests_v6 q
  where q.verified_storage_object_id = old.id
    or (q.verified_storage_path = old.name and old.bucket_id = 'proof')
    or (changed_path is not null and q.verified_storage_path = changed_path)
  on conflict do nothing;
  update public.client_proof_assets p set usage_rights = 'not_cleared'
  where p.usage_rights = 'approved' and p.storage_path is not null
    and (p.storage_path = old.name or p.storage_path = changed_path);
  return null;
end $$;
create trigger proof_media_rights_storage_changed_v6
  after update or delete on storage.objects for each row
  execute function public.invalidate_proof_media_rights_storage_v6();

revoke all on function public.proof_storage_identity_v6(uuid)
  from public,anon,authenticated;
grant execute on function public.proof_storage_identity_v6(uuid) to service_role;
revoke all on function public.invalidate_proof_media_rights_storage_v6()
  from public,anon,authenticated,service_role;
select public.lock_down_definer_functions();
commit;

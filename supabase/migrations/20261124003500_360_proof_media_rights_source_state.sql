-- File identity and invalidation are part of the review state.
begin;
create or replace function public.proof_rights_source_state_v6(p_canonical_id uuid)
returns text language plpgsql stable security definer
set search_path = pg_catalog, public, storage set timezone = 'UTC' as $$
declare r public.approval_requests_v6%rowtype;
  q public.proof_rights_requests_v6%rowtype;
  p public.client_proof_assets%rowtype;
  h text;
begin
  select * into r from public.approval_requests_v6 where id = p_canonical_id;
  if r.id is null then return 'unverified'; end if;
  if r.source_system is distinct from 'aa_console' then return 'unverified'; end if;
  if r.source_kind is distinct from 'proof_rights' then return 'unverified'; end if;
  if r.source_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then return 'unverified'; end if;
  if auth.role() is distinct from 'service_role' and
    (auth.role() is distinct from 'authenticated' or not
      public.can_review_approval_request_v6(r.client_id,r.owner_role))
    then return 'unverified'; end if;
  select * into q from public.proof_rights_requests_v6
    where id = r.source_id::uuid and client_id = r.client_id
      and canonical_request_id = r.id;
  if q.id is null then return 'cancelled'; end if;
  select * into p from public.client_proof_assets
    where id = q.proof_id and client_id = q.client_id;
  if p.id is null then return 'cancelled'; end if;
  if exists (select 1 from public.proof_rights_revocations_v6 v
      where v.canonical_request_id = r.id and v.client_id = r.client_id
        and v.proof_id = p.id) then return 'revoked'; end if;
  h := public.proof_rights_hash_v6(q);
  if q.artifact_hash is distinct from h or r.artifact_hash is distinct from h
    or r.source_version is distinct from h || ':' || q.request_token::text
    or r.preview is distinct from public.proof_rights_preview_v6(q)
    or r.scope is distinct from public.proof_rights_scope_v6(q)
    or r.destination is distinct from 'proof_bank:clear:' || p.id::text
    then return 'superseded'; end if;
  if q.requested_expiry < current_date then return 'source_held'; end if;
  if exists (select 1 from public.proof_rights_storage_invalidations_v6 i
      where i.rights_request_id = q.id) then return 'superseded'; end if;
  if p.media_type = 'text' then
    if p.storage_path is not null or nullif(btrim(coalesce(p.body,'')),'') is null
      or q.verified_storage_sha256 is not null then return 'source_held'; end if;
  elsif p.media_type in ('image','video') then
    if p.storage_path is null or q.verified_storage_sha256 is null
      or q.verified_file_bytes is null
      or q.verified_storage_path is distinct from p.storage_path
      or not exists (select 1 from storage.objects o
        where o.bucket_id = 'proof' and o.name = p.storage_path
          and o.id = q.verified_storage_object_id
          and o.version is not distinct from q.verified_storage_object_version
          and o.updated_at = q.verified_storage_object_updated_at)
      then return 'source_held'; end if;
  else return 'source_held'; end if;
  if p.usage_rights = 'approved' and p.approved_rights_request_id = r.id
    and p.approved_rights_content_hash = h
    and p.permission_basis = q.requested_basis
    and p.expires_on is not distinct from q.requested_expiry
    then return 'source_decided'; end if;
  if p.approved_rights_request_id is not null
    and p.approved_rights_request_id <> r.id
    and exists (select 1 from public.approval_decision_events_v6 d
      where d.request_id = r.id and d.decision = 'approved')
    then return 'superseded'; end if;
  return 'pending';
end $$;

select public.lock_down_definer_functions();
commit;

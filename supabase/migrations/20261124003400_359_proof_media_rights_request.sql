-- Trusted media requests carry the verified file digest in the same exact
-- preview and hash a human will decide. Text request hashes remain unchanged.
begin;
create or replace function public.proof_rights_preview_v6(p_request public.proof_rights_requests_v6)
returns jsonb language sql stable security definer
set search_path = pg_catalog, public as $$
  select jsonb_build_object(
    'client_id',p_request.client_id,'proof_id',p_request.proof_id,
    'request_token',p_request.request_token,
    'requested_rights','approved','permission_basis',p_request.requested_basis,
    'expires_on',p_request.requested_expiry,
    'proof',to_jsonb(p) - array['usage_rights','permission_basis','expires_on',
      'updated_at','approved_rights_request_id','approved_rights_content_hash'],
    'consequence','May support claims and be distributed only within recorded rights and expiry')
    || case when p_request.verified_storage_sha256 is not null then
      jsonb_build_object('verified_storage_sha256',p_request.verified_storage_sha256,
        'verified_file_bytes',p_request.verified_file_bytes,
        'verified_storage_path',p_request.verified_storage_path,
        'verified_storage_object_id',p_request.verified_storage_object_id,
        'verified_storage_object_version',p_request.verified_storage_object_version,
        'verified_storage_object_updated_at',p_request.verified_storage_object_updated_at)
      else '{}'::jsonb end
  from public.client_proof_assets p where p.id = p_request.proof_id
    and p.client_id = p_request.client_id;
$$;

create function public.request_proof_media_rights_v6(
  p_proof_id uuid,p_permission_basis text,p_expires_on date,
  p_sha256 text,p_file_bytes bigint,p_object_id uuid,
  p_object_version text,p_object_updated_at timestamptz,p_actor_id uuid)
returns uuid language plpgsql volatile security definer
set search_path = pg_catalog, public, storage set timezone = 'UTC' as $$
declare p public.client_proof_assets%rowtype;
  o storage.objects%rowtype;
  q public.proof_rights_requests_v6%rowtype;
  existing public.proof_rights_requests_v6%rowtype;
  h text;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Only the trusted verifier may request media rights.' using errcode = '42501'; end if;
  select * into p from public.client_proof_assets where id = p_proof_id for update;
  if p.id is null or p.media_type not in ('image','video') or p.storage_path is null
    or not exists (select 1 from public.profiles actor where actor.id = p_actor_id
      and (actor.role = 'admin'
        or p_actor_id = public.active_video_approval_manager(p.client_id))) then
    raise exception 'Stored proof or decision owner is unavailable.' using errcode = '42501'; end if;
  if nullif(btrim(coalesce(p_permission_basis,'')),'') is null
    or length(btrim(p_permission_basis)) > 2000
    or (p_expires_on is not null and p_expires_on < current_date)
    or p_sha256 !~ '^[0-9a-f]{64}$' or p_file_bytes <= 0
    or p_object_id is null or p_object_updated_at is null then
    raise exception 'Verified bytes and a current permission basis are required.'
      using errcode = '23514'; end if;
  select * into o from storage.objects where bucket_id = 'proof'
    and name = p.storage_path for share;
  if o.id is null or o.id is distinct from p_object_id
    or o.version is distinct from p_object_version
    or o.updated_at is distinct from p_object_updated_at then
    raise exception 'Storage changed during byte verification. Verify again.'
      using errcode = '23514'; end if;
  select * into existing from public.proof_rights_requests_v6 v
    where v.proof_id = p.id and v.client_id = p.client_id
      and v.requested_basis = btrim(p_permission_basis)
      and v.requested_expiry is not distinct from p_expires_on
      and v.verified_storage_sha256 = p_sha256
      and v.verified_file_bytes = p_file_bytes
      and v.verified_storage_object_id = o.id
      and v.verified_storage_object_version is not distinct from o.version
      and v.verified_storage_object_updated_at = o.updated_at
    order by v.created_at desc limit 1;
  if existing.id is not null and existing.canonical_request_id is not null
    and not exists (select 1 from public.proof_rights_storage_invalidations_v6 i
      where i.rights_request_id = existing.id)
    and existing.artifact_hash = public.proof_rights_hash_v6(existing)
    and public.proof_rights_source_state_v6(existing.canonical_request_id) = 'pending'
    and exists (select 1 from public.approval_inbox_v6 i
      where i.id = existing.canonical_request_id and i.status = 'pending')
    then return existing.canonical_request_id; end if;
  insert into public.proof_rights_requests_v6
    (proof_id,client_id,requested_basis,requested_expiry,
      verified_storage_sha256,verified_file_bytes,verified_storage_path,
      verified_storage_object_id,verified_storage_object_version,
      verified_storage_object_updated_at)
  values (p.id,p.client_id,btrim(p_permission_basis),p_expires_on,
    p_sha256,p_file_bytes,p.storage_path,o.id,o.version,o.updated_at)
  returning * into q;
  h := public.proof_rights_hash_v6(q);
  update public.proof_rights_requests_v6 set artifact_hash = h where id = q.id
    returning * into q;
  q.canonical_request_id := public.register_approval_request_v6(jsonb_build_object(
    'client_id',q.client_id,'source_system','aa_console',
    'source_kind','proof_rights','source_id',q.id::text,
    'source_version',h || ':' || q.request_token::text,
    'title','Clear proof rights: ' || coalesce(p.title,p.ref_number,p.id::text),
    'artifact_hash',h,'preview',public.proof_rights_preview_v6(q),
    'destination','proof_bank:clear:' || p.id::text,
    'scope',public.proof_rights_scope_v6(q),
    'owner_role','admin_or_active_client_manager',
    'requested_by',p_actor_id,'requester_kind','human',
    'expires_at',now() + interval '7 days',
    'owning_path','/clients/' || p.client_id::text ||
      '/delivery/proof-production-factory?proof=' || p.id::text));
  update public.proof_rights_requests_v6
    set canonical_request_id = q.canonical_request_id where id = q.id;
  return q.canonical_request_id;
end $$;

revoke all on function public.request_proof_media_rights_v6(
  uuid,text,date,text,bigint,uuid,text,timestamptz,uuid)
  from public,anon,authenticated;
grant execute on function public.request_proof_media_rights_v6(
  uuid,text,date,text,bigint,uuid,text,timestamptz,uuid) to service_role;
select public.lock_down_definer_functions();
commit;

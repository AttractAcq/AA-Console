-- Signoff is a decision on one immutable artifact, its source evidence and
-- current rights. It does not authorize publication at a destination.
begin;
alter table public.proof_artifact_signoffs
  add column approved_request_id uuid references public.approval_requests_v6(id),
  add column approved_content_hash text check (
    approved_content_hash is null or approved_content_hash ~ '^[0-9a-f]{64}$');

create table public.proof_artifact_review_requests_v6 (
  id uuid primary key default gen_random_uuid(),
  artifact_version_id uuid not null references public.proof_artifact_versions(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  request_token uuid not null default gen_random_uuid(),
  artifact_hash text check (artifact_hash ~ '^[0-9a-f]{64}$'),
  canonical_request_id uuid unique references public.approval_requests_v6(id),
  created_at timestamptz not null default now()
);
create index proof_artifact_review_latest_v6
  on public.proof_artifact_review_requests_v6(artifact_version_id,created_at desc);
alter table public.proof_artifact_review_requests_v6 enable row level security;
revoke all on public.proof_artifact_review_requests_v6
  from public,anon,authenticated,service_role;

create function public.proof_artifact_review_preview_v6(
  p_review public.proof_artifact_review_requests_v6)
returns jsonb language sql stable security definer
set search_path = pg_catalog, public as $$
  select jsonb_build_object(
    'client_id',p_review.client_id,'artifact_version_id',v.id,
    'request_token',p_review.request_token,
    'artifact',to_jsonb(v),
    'source_proof',to_jsonb(p) - array['updated_at'],
    'rights_request',case when q.id is not null then
      jsonb_build_object('id',q.id,'canonical_request_id',q.canonical_request_id,
        'artifact_hash',q.artifact_hash,'verified_storage_sha256',q.verified_storage_sha256,
        'verified_file_bytes',q.verified_file_bytes) else null end,
    'consequence','Confirms the source, claim and exact artifact words; destination placement requires a separate decision')
  from public.proof_artifact_versions v
  join public.client_proof_assets p on p.id = v.source_proof_id and p.client_id = v.client_id
  left join public.proof_rights_requests_v6 q on q.canonical_request_id = p.approved_rights_request_id
  where v.id = p_review.artifact_version_id and v.client_id = p_review.client_id;
$$;
create function public.proof_artifact_review_hash_v6(
  p_review public.proof_artifact_review_requests_v6)
returns text language sql stable security definer
set search_path = pg_catalog, public as $$
  select encode(sha256(convert_to(
    (public.proof_artifact_review_preview_v6(p_review) - 'request_token')::text,'UTF8')),'hex');
$$;
create function public.proof_artifact_review_scope_v6(
  p_review public.proof_artifact_review_requests_v6)
returns jsonb language sql stable security definer
set search_path = pg_catalog, public as $$
  select jsonb_build_object('client_id',p_review.client_id,
    'artifact_version_id',p_review.artifact_version_id,
    'review_id',p_review.id,'request_token',p_review.request_token,
    'content_hash',public.proof_artifact_review_hash_v6(p_review),
    'effect','source_and_claim_signoff');
$$;

create function public.proof_artifact_review_source_state_v6(p_request_id uuid)
returns text language plpgsql stable security definer
set search_path = pg_catalog, public set timezone = 'UTC' as $$
declare r public.approval_requests_v6%rowtype;
  q public.proof_artifact_review_requests_v6%rowtype;
  v public.proof_artifact_versions%rowtype;
  p public.client_proof_assets%rowtype;
  s public.proof_artifact_signoffs%rowtype;
  h text;
begin
  select * into r from public.approval_requests_v6 where id = p_request_id;
  if r.id is null or r.source_system <> 'aa_console' or r.source_kind <> 'proof_artifact'
    or r.source_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then return 'unverified'; end if;
  if auth.role() is distinct from 'service_role' and
    (auth.role() is distinct from 'authenticated' or not
      public.can_review_approval_request_v6(r.client_id,r.owner_role))
    then return 'unverified'; end if;
  select * into q from public.proof_artifact_review_requests_v6
    where id = r.source_id::uuid and client_id = r.client_id
      and canonical_request_id = r.id;
  if q.id is null then return 'cancelled'; end if;
  select * into v from public.proof_artifact_versions
    where id = q.artifact_version_id and client_id = q.client_id;
  select * into p from public.client_proof_assets
    where id = v.source_proof_id and client_id = v.client_id;
  if v.id is null or p.id is null then return 'cancelled'; end if;
  h := public.proof_artifact_review_hash_v6(q);
  if q.artifact_hash is distinct from h or r.artifact_hash is distinct from h
    or r.source_version is distinct from h || ':' || q.request_token::text
    or r.preview is distinct from public.proof_artifact_review_preview_v6(q)
    or r.scope is distinct from public.proof_artifact_review_scope_v6(q)
    or r.destination is distinct from 'proof_bank:artifact:' || v.id::text
    then return 'superseded'; end if;
  if p.usage_rights <> 'approved' or p.approved_rights_request_id is null
    or nullif(btrim(p.permission_basis),'') is null
    or (p.expires_on is not null and p.expires_on < current_date)
    or public.proof_rights_source_state_v6(p.approved_rights_request_id) <> 'source_decided'
    or not exists (select 1 from public.approval_inbox_v6 i
      where i.id = p.approved_rights_request_id and i.status = 'approved')
    or public.proof_snapshot_hash_v6(public.proof_source_snapshot_v6(p)) <> v.source_hash
    or public.proof_snapshot_hash_v6(jsonb_build_object(
      'source_hash',v.source_hash,'kind',v.artifact_kind,
      'claim',v.supported_claim,'excerpt',v.evidence_excerpt,
      'content',v.content)) <> v.content_hash
    then return 'source_held'; end if;
  select * into s from public.proof_artifact_signoffs where artifact_version_id = v.id;
  if s.artifact_version_id is not null and s.approved_request_id = r.id
    and s.approved_content_hash = h then return 'source_decided'; end if;
  if s.artifact_version_id is not null then return 'source_held'; end if;
  return 'pending';
end $$;

create function public.request_proof_artifact_signoff_v6(p_artifact_version_id uuid)
returns uuid language plpgsql volatile security definer
set search_path = pg_catalog, public set timezone = 'UTC' as $$
declare v public.proof_artifact_versions%rowtype;
  q public.proof_artifact_review_requests_v6%rowtype;
  h text;
begin
  if auth.role() <> 'authenticated' or auth.uid() is null
    or public.current_role_of() is null then
    raise exception 'A provisioned human must request artifact review.' using errcode = '42501'; end if;
  select * into v from public.proof_artifact_versions where id = p_artifact_version_id;
  if v.id is null or not (coalesce(public.is_admin(),false)
    or coalesce(auth.uid() = public.active_video_approval_manager(v.client_id),false)) then
    raise exception 'The artifact or decision owner is unavailable.' using errcode = '42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended('proof_artifact_review:' || v.id::text,0));
  select * into q from public.proof_artifact_review_requests_v6
    where artifact_version_id = v.id and client_id = v.client_id
    order by created_at desc limit 1;
  if q.id is not null and q.canonical_request_id is not null
    and q.artifact_hash = public.proof_artifact_review_hash_v6(q)
    and public.proof_artifact_review_source_state_v6(q.canonical_request_id) = 'pending'
    and exists (select 1 from public.approval_inbox_v6 i
      where i.id = q.canonical_request_id and i.status = 'pending')
    then return q.canonical_request_id; end if;
  if exists (select 1 from public.proof_artifact_signoffs s
    where s.artifact_version_id = v.id) then
    raise exception 'This artifact already has a signoff. Review its lineage or create a new version.'
      using errcode = '23514'; end if;
  insert into public.proof_artifact_review_requests_v6(artifact_version_id,client_id)
    values (v.id,v.client_id) returning * into q;
  h := public.proof_artifact_review_hash_v6(q);
  update public.proof_artifact_review_requests_v6 set artifact_hash = h
    where id = q.id returning * into q;
  -- Recheck the actual source before exposing a decision-ready card.
  if not exists (select 1 from public.client_proof_assets p
    where p.id = v.source_proof_id and p.client_id = v.client_id
      and p.usage_rights = 'approved' and p.approved_rights_request_id is not null
      and public.proof_snapshot_hash_v6(public.proof_source_snapshot_v6(p)) = v.source_hash
      and public.proof_rights_source_state_v6(p.approved_rights_request_id) = 'source_decided') then
    raise exception 'Clear and verify the unchanged proof source before review.'
      using errcode = '23514'; end if;
  q.canonical_request_id := public.register_approval_request_v6(jsonb_build_object(
    'client_id',q.client_id,'source_system','aa_console',
    'source_kind','proof_artifact','source_id',q.id::text,
    'source_version',h || ':' || q.request_token::text,
    'title','Sign off proof artifact: ' || v.artifact_kind || ' v' || v.version::text,
    'artifact_hash',h,'preview',public.proof_artifact_review_preview_v6(q),
    'destination','proof_bank:artifact:' || v.id::text,
    'scope',public.proof_artifact_review_scope_v6(q),
    'owner_role','admin_or_active_client_manager',
    'requested_by',auth.uid(),'requester_kind','human',
    'expires_at',now() + interval '7 days',
    'owning_path','/clients/' || v.client_id::text ||
      '/delivery/proof-production-factory?tab=artifacts'));
  update public.proof_artifact_review_requests_v6
    set canonical_request_id = q.canonical_request_id where id = q.id;
  return q.canonical_request_id;
end $$;

revoke all on function public.proof_artifact_review_preview_v6(public.proof_artifact_review_requests_v6)
  from public,anon,authenticated,service_role;
revoke all on function public.proof_artifact_review_hash_v6(public.proof_artifact_review_requests_v6)
  from public,anon,authenticated,service_role;
revoke all on function public.proof_artifact_review_scope_v6(public.proof_artifact_review_requests_v6)
  from public,anon,authenticated,service_role;
revoke all on function public.proof_artifact_review_source_state_v6(uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.proof_artifact_review_source_state_v6(uuid)
  to authenticated,service_role;
revoke all on function public.request_proof_artifact_signoff_v6(uuid)
  from public,anon,service_role;
grant execute on function public.request_proof_artifact_signoff_v6(uuid) to authenticated;
select public.lock_down_definer_functions();
commit;

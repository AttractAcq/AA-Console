-- Rights clearance is a separate decision on the exact source words, basis,
-- expiry and intended use. Stored media remains held until bytes can be
-- attested by a trusted verifier.
begin;
alter table public.client_proof_assets
  add column approved_rights_request_id uuid references public.approval_requests_v6(id),
  add column approved_rights_content_hash text check (
    approved_rights_content_hash is null or approved_rights_content_hash ~ '^[0-9a-f]{64}$');

create table public.proof_rights_requests_v6 (
  id uuid primary key default gen_random_uuid(),
  proof_id uuid not null references public.client_proof_assets(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  request_token uuid not null default gen_random_uuid(),
  requested_basis text not null check (length(btrim(requested_basis)) between 1 and 2000),
  requested_expiry date,
  artifact_hash text check (artifact_hash ~ '^[0-9a-f]{64}$'),
  canonical_request_id uuid unique references public.approval_requests_v6(id),
  created_at timestamptz not null default now(),
  unique (proof_id,request_token)
);
create index proof_rights_requests_latest_v6 on public.proof_rights_requests_v6(proof_id,created_at desc);
alter table public.proof_rights_requests_v6 enable row level security;
revoke all on public.proof_rights_requests_v6 from public,anon,authenticated,service_role;
create table public.proof_rights_revocations_v6 (
  canonical_request_id uuid primary key references public.approval_requests_v6(id) on delete restrict,
  client_id uuid not null references public.clients(id) on delete cascade,
  proof_id uuid not null references public.client_proof_assets(id) on delete cascade,
  actor_id uuid references public.profiles(id),
  reason text not null,
  revoked_at timestamptz not null default now()
);
alter table public.proof_rights_revocations_v6 enable row level security;
revoke all on public.proof_rights_revocations_v6 from public,anon,authenticated,service_role;

create function public.proof_rights_preview_v6(p_request public.proof_rights_requests_v6)
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
  from public.client_proof_assets p where p.id = p_request.proof_id
    and p.client_id = p_request.client_id;
$$;
create function public.proof_rights_hash_v6(p_request public.proof_rights_requests_v6)
returns text language sql stable security definer
set search_path = pg_catalog, public as $$
  select encode(sha256(convert_to(
    (public.proof_rights_preview_v6(p_request) - 'request_token')::text,'UTF8')),'hex');
$$;
create function public.proof_rights_scope_v6(p_request public.proof_rights_requests_v6)
returns jsonb language sql stable security definer
set search_path = pg_catalog, public as $$
  select jsonb_build_object('client_id',p_request.client_id,
    'proof_id',p_request.proof_id,'rights_request_id',p_request.id,
    'request_token',p_request.request_token,
    'content_hash',public.proof_rights_hash_v6(p_request),
    'requested_rights','approved','expires_on',p_request.requested_expiry);
$$;

create function public.proof_rights_source_state_v6(p_canonical_id uuid)
returns text language plpgsql stable security definer
set search_path = pg_catalog, public set timezone = 'UTC' as $$
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
  if p.media_type <> 'text' or p.storage_path is not null
    or nullif(btrim(coalesce(p.body,'')),'') is null
    or q.requested_expiry < current_date then return 'source_held'; end if;
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

create function public.request_proof_rights_v6(
  p_proof_id uuid,p_permission_basis text,p_expires_on date default null)
returns uuid language plpgsql volatile security definer
set search_path = pg_catalog, public set timezone = 'UTC' as $$
declare p public.client_proof_assets%rowtype;
  q public.proof_rights_requests_v6%rowtype;
  existing public.proof_rights_requests_v6%rowtype;
  h text;
begin
  if auth.role() is distinct from 'authenticated' or auth.uid() is null
    or public.current_role_of() is null then
    raise exception 'A provisioned human must request proof rights.' using errcode = '42501'; end if;
  select * into p from public.client_proof_assets where id = p_proof_id for update;
  if p.id is null or not (coalesce(public.is_admin(),false)
    or coalesce(auth.uid() = public.active_video_approval_manager(p.client_id),false)) then
    raise exception 'Proof or decision owner unavailable.' using errcode = '42501'; end if;
  if p.media_type <> 'text' or p.storage_path is not null
    or nullif(btrim(coalesce(p.body,'')),'') is null then
    raise exception 'Use nonempty text proof; stored media needs trusted file-byte attestation.'
      using errcode = '23514'; end if;
  if nullif(btrim(coalesce(p_permission_basis,'')),'') is null
    or length(btrim(p_permission_basis)) > 2000
    or (p_expires_on is not null and p_expires_on < current_date) then
    raise exception 'Record a current, specific permission basis and expiry.'
      using errcode = '23514'; end if;
  select * into existing from public.proof_rights_requests_v6 v
    where v.proof_id = p.id and v.client_id = p.client_id
      and v.requested_basis = btrim(p_permission_basis)
      and v.requested_expiry is not distinct from p_expires_on
    order by v.created_at desc limit 1;
  if existing.id is not null and existing.canonical_request_id is not null
    and existing.artifact_hash = public.proof_rights_hash_v6(existing)
    and public.proof_rights_source_state_v6(existing.canonical_request_id) = 'pending'
    and exists (select 1 from public.approval_inbox_v6 i
      where i.id = existing.canonical_request_id and i.status = 'pending')
    then return existing.canonical_request_id; end if;
  insert into public.proof_rights_requests_v6(proof_id,client_id,requested_basis,requested_expiry)
    values (p.id,p.client_id,btrim(p_permission_basis),p_expires_on)
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
    'requested_by',auth.uid(),'requester_kind','human',
    'expires_at',now() + interval '7 days',
    'owning_path','/clients/' || p.client_id::text ||
      '/delivery/proof-production-factory?proof=' || p.id::text));
  update public.proof_rights_requests_v6
    set canonical_request_id = q.canonical_request_id where id = q.id;
  return q.canonical_request_id;
end $$;

revoke all on function public.proof_rights_preview_v6(public.proof_rights_requests_v6) from public,anon,authenticated,service_role;
revoke all on function public.proof_rights_hash_v6(public.proof_rights_requests_v6) from public,anon,authenticated,service_role;
revoke all on function public.proof_rights_scope_v6(public.proof_rights_requests_v6) from public,anon,authenticated,service_role;
revoke all on function public.proof_rights_source_state_v6(uuid) from public,anon,authenticated,service_role;
grant execute on function public.proof_rights_source_state_v6(uuid) to authenticated,service_role;
revoke all on function public.request_proof_rights_v6(uuid,text,date) from public,anon,service_role;
grant execute on function public.request_proof_rights_v6(uuid,text,date) to authenticated;
select public.lock_down_definer_functions();
commit;

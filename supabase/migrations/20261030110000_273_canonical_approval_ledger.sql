-- B008 / 273: one cross-source, exact-version approval record.
-- This migration creates the ledger only. Source-specific request/decision
-- adapters and last-moment executor checks follow in later migrations.
-- No external-effect switch is changed here.

create table public.approval_requests_v6 (
  id uuid primary key default gen_random_uuid(),
  client_id uuid references public.clients(id) on delete restrict,
  source_system text not null check (length(btrim(source_system)) between 1 and 120),
  source_kind text not null check (length(btrim(source_kind)) between 1 and 120),
  source_id text not null check (length(btrim(source_id)) between 1 and 200),
  source_version text not null check (length(btrim(source_version)) between 1 and 200),
  title text not null check (length(btrim(title)) between 1 and 300),
  artifact_hash text check (artifact_hash ~ '^[0-9a-f]{64}$'),
  preview jsonb,
  destination text,
  account_ref text,
  budget jsonb,
  scope jsonb check (scope is null or jsonb_typeof(scope) = 'object'),
  owner_role text,
  expires_at timestamptz,
  preview_blocker text,
  owning_path text,
  requested_by uuid,
  requester_kind text not null check (requester_kind in
    ('human', 'service', 'agent', 'engine', 'policy', 'unknown')),
  requester_ref text check (requester_ref is null or
    length(btrim(requester_ref)) between 1 and 300),
  requested_at timestamptz not null default now(),
  payload_hash text not null check (payload_hash ~ '^[0-9a-f]{64}$'),
  check ((requester_kind = 'human' and requested_by is not null)
    or (requester_kind <> 'human' and requested_by is null)),
  check (requester_kind in ('human', 'unknown') or requester_ref is not null),
  unique (source_system, source_kind, source_id, source_version)
);
create index approval_requests_v6_client_time_idx
  on public.approval_requests_v6 (client_id, requested_at desc, id);

-- A source may have to insert its owning request before the immutable bytes
-- are available (page HTML is inserted after the action row). One verified
-- evidence attachment can complete that request without rewriting it.
create table public.approval_request_evidence_v6 (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null unique references public.approval_requests_v6(id) on delete restrict,
  source_version text not null,
  evidence_ref text not null check (length(btrim(evidence_ref)) between 1 and 300),
  artifact_hash text not null check (artifact_hash ~ '^[0-9a-f]{64}$'),
  preview jsonb not null check (jsonb_typeof(preview) = 'object' and preview <> '{}'::jsonb),
  destination text,
  account_ref text,
  budget jsonb,
  scope jsonb not null check (jsonb_typeof(scope) = 'object' and scope <> '{}'::jsonb),
  evidence_hash text not null check (evidence_hash ~ '^[0-9a-f]{64}$'),
  attached_at timestamptz not null default now()
);

create table public.approval_decision_events_v6 (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.approval_requests_v6(id) on delete restrict,
  decision text not null check (decision in ('approved', 'rejected', 'revoked')),
  actor_id uuid not null,
  actor_aal text not null check (actor_aal = 'aal2'),
  artifact_hash text check (artifact_hash ~ '^[0-9a-f]{64}$'),
  source_decision_ref text not null check (length(btrim(source_decision_ref)) between 1 and 300),
  reason text,
  decided_at timestamptz not null default now(),
  unique (request_id, source_decision_ref),
  check (decision = 'approved' or nullif(btrim(coalesce(reason, '')), '') is not null)
);
create index approval_decision_events_v6_latest_idx
  on public.approval_decision_events_v6 (request_id, decided_at desc, id desc);

-- Table owners retain DDL control for later migrations, but no existing row
-- may be revised or removed as part of an application action.
create function public.reject_approval_ledger_mutation_v6()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public as $$
begin
  raise exception 'Approval ledger records are append-only.' using errcode = '42501';
end;
$$;
create trigger approval_requests_v6_append_only
  before update or delete on public.approval_requests_v6
  for each row execute function public.reject_approval_ledger_mutation_v6();
create trigger approval_request_evidence_v6_append_only
  before update or delete on public.approval_request_evidence_v6
  for each row execute function public.reject_approval_ledger_mutation_v6();
create trigger approval_decision_events_v6_append_only
  before update or delete on public.approval_decision_events_v6
  for each row execute function public.reject_approval_ledger_mutation_v6();
create trigger approval_requests_v6_no_truncate
  before truncate on public.approval_requests_v6
  for each statement execute function public.reject_approval_ledger_mutation_v6();
create trigger approval_request_evidence_v6_no_truncate
  before truncate on public.approval_request_evidence_v6
  for each statement execute function public.reject_approval_ledger_mutation_v6();
create trigger approval_decision_events_v6_no_truncate
  before truncate on public.approval_decision_events_v6
  for each statement execute function public.reject_approval_ledger_mutation_v6();

alter table public.approval_requests_v6 enable row level security;
alter table public.approval_request_evidence_v6 enable row level security;
alter table public.approval_decision_events_v6 enable row level security;

-- A client relationship by itself is not permission to read a manager's
-- campaign scope or budget. Unknown future owner roles stay admin-only until
-- their source adapter adds a deliberately scoped reader rule.
create function public.can_review_approval_request_v6(
  p_client_id uuid, p_owner_role text
) returns boolean language sql stable security definer
set search_path = pg_catalog, public as $$
  select coalesce(public.is_admin(), false) or coalesce((
    p_client_id is not null
    and p_owner_role = 'admin_or_active_client_manager'
    and auth.uid() = public.active_video_approval_manager(p_client_id)
  ), false);
$$;
revoke execute on function public.can_review_approval_request_v6(uuid,text)
  from public, anon, service_role;
grant execute on function public.can_review_approval_request_v6(uuid,text)
  to authenticated;

create policy approval_requests_v6_scoped_read on public.approval_requests_v6
  for select to authenticated using (
    public.can_review_approval_request_v6(client_id, owner_role)
  );
create policy approval_request_evidence_v6_scoped_read on public.approval_request_evidence_v6
  for select to authenticated using (exists (
    select 1 from public.approval_requests_v6 r where r.id = request_id
  ));
create policy approval_decision_events_v6_scoped_read on public.approval_decision_events_v6
  for select to authenticated using (exists (
    select 1 from public.approval_requests_v6 r where r.id = request_id
  ));

revoke all on public.approval_requests_v6,
  public.approval_request_evidence_v6,
  public.approval_decision_events_v6 from public, anon, authenticated, service_role;
grant select on public.approval_requests_v6,
  public.approval_request_evidence_v6,
  public.approval_decision_events_v6 to authenticated, service_role;

-- Security-invoker means the view inherits the same per-client RLS as each
-- ledger table. An expired approval is never reported as currently approved.
create view public.approval_inbox_v6 with (security_invoker = true) as
select
  r.id, r.client_id, r.source_system, r.source_kind, r.source_id,
  r.source_version, r.title,
  case
    when d.decision = 'revoked' then 'revoked'
    when d.decision = 'rejected' then 'rejected'
    when r.expires_at is not null and r.expires_at <= now() then 'expired'
    when d.decision = 'approved' then 'approved'
    else 'pending'
  end as status,
  r.requested_at, r.requested_by, r.requester_kind, r.requester_ref,
  r.expires_at,
  coalesce(e.artifact_hash, r.artifact_hash) as artifact_hash,
  coalesce(e.preview, r.preview) as preview,
  coalesce(e.destination, r.destination) as destination,
  coalesce(e.account_ref, r.account_ref) as account_ref,
  coalesce(e.budget, r.budget) as budget,
  coalesce(e.scope, r.scope) as scope,
  r.owner_role,
  case
    when r.expires_at is null then 'An expiry is missing.'
    when nullif(btrim(coalesce(r.owner_role, '')), '') is null then 'The decision owner is missing.'
    when e.id is not null then null
    when nullif(btrim(coalesce(r.preview_blocker, '')), '') is not null then r.preview_blocker
    when r.artifact_hash is null then 'The exact artifact hash is missing.'
    when r.preview is null or jsonb_typeof(r.preview) <> 'object'
      or r.preview = '{}'::jsonb then 'The exact artifact preview is missing.'
    when r.scope is null or r.scope = '{}'::jsonb then 'The exact scope is missing.'
    else null
  end as preview_blocker,
  r.owning_path
from public.approval_requests_v6 r
left join public.approval_request_evidence_v6 e on e.request_id = r.id
left join lateral (
  select de.decision from public.approval_decision_events_v6 de
  where de.request_id = r.id
  order by de.decided_at desc, de.id desc limit 1
) d on true;
revoke all on public.approval_inbox_v6 from public, anon, authenticated, service_role;
grant select on public.approval_inbox_v6 to authenticated, service_role;

-- Only trusted source-owned SECURITY DEFINER code can call these helpers.
-- A browser or worker cannot mint a canonical card through PostgREST.
create function public.register_approval_request_v6(p_request jsonb)
returns uuid language plpgsql volatile security definer
set search_path = pg_catalog, public set timezone = 'UTC' as $$
declare
  v_client_id uuid;
  v_source_system text;
  v_source_kind text;
  v_source_id text;
  v_source_version text;
  v_title text;
  v_artifact_hash text;
  v_preview jsonb;
  v_destination text;
  v_account_ref text;
  v_budget jsonb;
  v_scope jsonb;
  v_owner_role text;
  v_expires_at timestamptz;
  v_preview_blocker text;
  v_owning_path text;
  v_requested_by uuid;
  v_requester_kind text;
  v_requester_ref text;
  v_payload_hash text;
  v_id uuid;
  v_existing_hash text;
begin
  if p_request is null or jsonb_typeof(p_request) <> 'object' then
    raise exception 'Approval request must be a JSON object.' using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_object_keys(p_request) k where k not in (
    'client_id','source_system','source_kind','source_id','source_version',
    'title','artifact_hash','preview','destination','account_ref','budget',
    'scope','owner_role','expires_at','preview_blocker','owning_path',
    'requested_by','requester_kind','requester_ref'
  )) then
    raise exception 'Approval request contains an unknown field.' using errcode = '22023';
  end if;

  v_client_id := nullif(p_request ->> 'client_id', '')::uuid;
  v_source_system := nullif(btrim(p_request ->> 'source_system'), '');
  v_source_kind := nullif(btrim(p_request ->> 'source_kind'), '');
  v_source_id := nullif(btrim(p_request ->> 'source_id'), '');
  v_source_version := nullif(btrim(p_request ->> 'source_version'), '');
  v_title := nullif(btrim(p_request ->> 'title'), '');
  v_artifact_hash := nullif(p_request ->> 'artifact_hash', '');
  v_preview := nullif(p_request -> 'preview', 'null'::jsonb);
  v_destination := nullif(btrim(p_request ->> 'destination'), '');
  v_account_ref := nullif(btrim(p_request ->> 'account_ref'), '');
  v_budget := nullif(p_request -> 'budget', 'null'::jsonb);
  v_scope := nullif(p_request -> 'scope', 'null'::jsonb);
  v_owner_role := nullif(btrim(p_request ->> 'owner_role'), '');
  v_expires_at := nullif(p_request ->> 'expires_at', '')::timestamptz;
  v_preview_blocker := nullif(btrim(p_request ->> 'preview_blocker'), '');
  v_owning_path := nullif(btrim(p_request ->> 'owning_path'), '');
  v_requested_by := nullif(p_request ->> 'requested_by', '')::uuid;
  v_requester_kind := nullif(btrim(p_request ->> 'requester_kind'), '');
  v_requester_ref := nullif(btrim(p_request ->> 'requester_ref'), '');
  -- A SECURITY DEFINER trigger may run with service-role or migration JWT
  -- context. Only the owning source adapter may supply the frozen human ID;
  -- never infer it from the caller executing a later idempotent replay.
  if v_requester_kind is null then
    if v_requested_by is not null then
      v_requester_kind := 'human';
    else
      v_requester_kind := 'unknown';
    end if;
  end if;
  if v_requester_kind not in ('human','service','agent','engine','policy','unknown')
    or (v_requester_kind = 'human' and v_requested_by is null)
    or (v_requester_kind <> 'human' and v_requested_by is not null)
    or (v_requester_kind not in ('human','unknown') and v_requester_ref is null)
    or length(v_requester_ref) > 300 then
    raise exception 'Approval requester provenance is inconsistent or incomplete.'
      using errcode = '22023';
  end if;

  if v_source_system is null or v_source_kind is null or v_source_id is null
    or v_source_version is null or v_title is null then
    raise exception 'Approval source identity, version and title are required.' using errcode = '22023';
  end if;
  if v_artifact_hash is not null and v_artifact_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'Approval artifact hash must be SHA-256 hex.' using errcode = '22023';
  end if;
  if v_preview is not null and jsonb_typeof(v_preview) <> 'object' then
    raise exception 'Approval preview must be a JSON object.' using errcode = '22023';
  end if;
  if v_scope is not null and jsonb_typeof(v_scope) <> 'object' then
    raise exception 'Approval scope must be a JSON object.' using errcode = '22023';
  end if;
  if (v_artifact_hash is null or v_preview is null or v_preview = '{}'::jsonb
      or v_scope is null or v_scope = '{}'::jsonb or v_expires_at is null
      or v_owner_role is null) and v_preview_blocker is null then
    v_preview_blocker := 'Exact approval evidence is incomplete.';
  end if;

  v_payload_hash := encode(sha256(convert_to(jsonb_build_object(
    'client_id',v_client_id,'source_system',v_source_system,
    'source_kind',v_source_kind,'source_id',v_source_id,
    'source_version',v_source_version,'title',v_title,
    'artifact_hash',v_artifact_hash,'preview',v_preview,
    'destination',v_destination,'account_ref',v_account_ref,
    'budget',v_budget,'scope',v_scope,'owner_role',v_owner_role,
    'expires_at',v_expires_at,'preview_blocker',v_preview_blocker,
    'owning_path',v_owning_path,'requested_by',v_requested_by,
    'requester_kind',v_requester_kind,'requester_ref',v_requester_ref
  )::text, 'UTF8')), 'hex');

  insert into public.approval_requests_v6 (
    client_id,source_system,source_kind,source_id,source_version,title,
    artifact_hash,preview,destination,account_ref,budget,scope,owner_role,
    expires_at,preview_blocker,owning_path,requested_by,requester_kind,
    requester_ref,payload_hash
  ) values (
    v_client_id,v_source_system,v_source_kind,v_source_id,v_source_version,v_title,
    v_artifact_hash,v_preview,v_destination,v_account_ref,v_budget,v_scope,v_owner_role,
    v_expires_at,v_preview_blocker,v_owning_path,v_requested_by,
    v_requester_kind,v_requester_ref,v_payload_hash
  ) on conflict (source_system,source_kind,source_id,source_version) do nothing
  returning id into v_id;
  if v_id is not null then return v_id; end if;

  select id,payload_hash into v_id,v_existing_hash
    from public.approval_requests_v6 where source_system = v_source_system
      and source_kind = v_source_kind and source_id = v_source_id
      and source_version = v_source_version;
  if v_existing_hash is distinct from v_payload_hash then
    raise exception 'Approval source version already has different frozen evidence.'
      using errcode = '23505';
  end if;
  return v_id;
end;
$$;

create function public.attach_approval_evidence_v6(
  p_request_id uuid, p_source_version text, p_evidence_ref text, p_evidence jsonb
) returns uuid language plpgsql volatile security definer
set search_path = pg_catalog, public set timezone = 'UTC' as $$
declare
  v_request public.approval_requests_v6%rowtype;
  v_artifact_hash text;
  v_preview jsonb;
  v_destination text;
  v_account_ref text;
  v_budget jsonb;
  v_scope jsonb;
  v_evidence_hash text;
  v_existing public.approval_request_evidence_v6%rowtype;
  v_id uuid;
begin
  if p_evidence is null or jsonb_typeof(p_evidence) <> 'object' then
    raise exception 'Approval evidence must be a JSON object.' using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_object_keys(p_evidence) k where k not in (
    'artifact_hash','preview','destination','account_ref','budget','scope'
  )) then
    raise exception 'Approval evidence contains an unknown field.' using errcode = '22023';
  end if;
  select * into v_request from public.approval_requests_v6
    where id = p_request_id for update;
  if not found then raise exception 'Approval request not found.' using errcode = 'P0002'; end if;
  if p_source_version is distinct from v_request.source_version then
    raise exception 'Approval source version changed.' using errcode = '23514';
  end if;
  if nullif(btrim(coalesce(p_evidence_ref, '')), '') is null then
    raise exception 'A source evidence reference is required.' using errcode = '22023';
  end if;
  v_artifact_hash := nullif(p_evidence ->> 'artifact_hash', '');
  v_preview := nullif(p_evidence -> 'preview', 'null'::jsonb);
  v_destination := nullif(btrim(p_evidence ->> 'destination'), '');
  v_account_ref := nullif(btrim(p_evidence ->> 'account_ref'), '');
  v_budget := nullif(p_evidence -> 'budget', 'null'::jsonb);
  v_scope := nullif(p_evidence -> 'scope', 'null'::jsonb);
  if v_artifact_hash is null or v_artifact_hash !~ '^[0-9a-f]{64}$'
    or v_preview is null or jsonb_typeof(v_preview) <> 'object'
    or v_preview = '{}'::jsonb or v_scope is null
    or jsonb_typeof(v_scope) <> 'object' or v_scope = '{}'::jsonb then
    raise exception 'Full exact-version evidence, hash and scope are required.'
      using errcode = '22023';
  end if;
  if v_request.artifact_hash is not null and v_request.artifact_hash <> v_artifact_hash
    or v_request.preview is not null and not (v_preview @> v_request.preview)
    or v_request.destination is not null and v_request.destination is distinct from v_destination
    or v_request.account_ref is not null and v_request.account_ref is distinct from v_account_ref
    or v_request.budget is not null and v_request.budget is distinct from v_budget
    or v_request.scope is not null and v_request.scope is distinct from v_scope then
    raise exception 'Evidence conflicts with the frozen approval request.' using errcode = '23514';
  end if;
  v_evidence_hash := encode(sha256(convert_to(jsonb_build_object(
    'request_id',p_request_id,'source_version',p_source_version,
    'evidence_ref',btrim(p_evidence_ref),'artifact_hash',v_artifact_hash,
    'preview',v_preview,'destination',v_destination,'account_ref',v_account_ref,
    'budget',v_budget,'scope',v_scope
  )::text, 'UTF8')), 'hex');
  select * into v_existing from public.approval_request_evidence_v6
    where request_id = p_request_id;
  if found then
    if v_existing.evidence_hash = v_evidence_hash then return v_existing.id; end if;
    raise exception 'Approval evidence is already frozen for this request.' using errcode = '23505';
  end if;
  if exists (select 1 from public.approval_decision_events_v6 where request_id = p_request_id) then
    raise exception 'Evidence cannot be attached after a decision.' using errcode = '23514';
  end if;
  insert into public.approval_request_evidence_v6 (
    request_id,source_version,evidence_ref,artifact_hash,preview,
    destination,account_ref,budget,scope,evidence_hash
  ) values (
    p_request_id,p_source_version,btrim(p_evidence_ref),v_artifact_hash,v_preview,
    v_destination,v_account_ref,v_budget,v_scope,v_evidence_hash
  ) returning id into v_id;
  return v_id;
end;
$$;

-- This is a recording gate, not the owning decision. An adapter calls it
-- after its source transition and while that transaction can still roll back.
create function public.record_approval_decision_v6(
  p_request_id uuid, p_decision text, p_artifact_hash text,
  p_source_decision_ref text, p_reason text default null
) returns uuid language plpgsql volatile security definer
set search_path = pg_catalog, public set timezone = 'UTC' as $$
declare
  v_request public.approval_requests_v6%rowtype;
  v_evidence public.approval_request_evidence_v6%rowtype;
  v_existing public.approval_decision_events_v6%rowtype;
  v_latest public.approval_decision_events_v6%rowtype;
  v_hash text;
  v_blocker text;
  v_id uuid;
begin
  if auth.role() is distinct from 'authenticated' or auth.uid() is null
    or public.current_role_of() is null
    or coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' then
    raise exception 'A provisioned human with AAL2 must decide this approval.'
      using errcode = '42501';
  end if;
  if p_decision not in ('approved','rejected','revoked') or p_decision is null
    or nullif(btrim(coalesce(p_source_decision_ref, '')), '') is null
    or (p_decision <> 'approved' and nullif(btrim(coalesce(p_reason, '')), '') is null) then
    raise exception 'A valid decision, source reference and reason are required.'
      using errcode = '22023';
  end if;
  select * into v_request from public.approval_requests_v6
    where id = p_request_id for update;
  if not found then raise exception 'Approval request not found.' using errcode = 'P0002'; end if;
  if v_request.client_id is null then
    if not coalesce(public.is_admin(), false) then
      raise exception 'Only an admin may decide agency-wide approvals.' using errcode = '42501';
    end if;
  elsif not public.can_review_approval_request_v6(v_request.client_id, v_request.owner_role) then
    raise exception 'Not the decision owner for this client.' using errcode = '42501';
  end if;

  select * into v_evidence from public.approval_request_evidence_v6
    where request_id = p_request_id;
  v_hash := coalesce(v_evidence.artifact_hash, v_request.artifact_hash);
  if p_artifact_hash is distinct from v_hash then
    raise exception 'The exact artifact hash changed; request a new approval.'
      using errcode = '23514';
  end if;

  select * into v_existing from public.approval_decision_events_v6
    where request_id = p_request_id and source_decision_ref = btrim(p_source_decision_ref);
  if found then
    if v_existing.decision = p_decision and v_existing.actor_id = auth.uid()
      and v_existing.artifact_hash is not distinct from p_artifact_hash
      and v_existing.reason is not distinct from nullif(btrim(p_reason), '') then
      return v_existing.id;
    end if;
    raise exception 'Source decision reference already belongs to another decision.'
      using errcode = '23505';
  end if;

  select * into v_latest from public.approval_decision_events_v6
    where request_id = p_request_id order by decided_at desc, id desc limit 1;
  if p_decision = 'revoked' then
    if v_latest.decision is distinct from 'approved' then
      raise exception 'Only an approved request can be revoked.' using errcode = '23514';
    end if;
  elsif v_latest.id is not null then
    raise exception 'This approval request has already been decided.' using errcode = '23514';
  elsif p_decision = 'approved'
    and v_request.expires_at is not null and v_request.expires_at <= now() then
    raise exception 'This approval request has expired.' using errcode = '23514';
  end if;

  if p_decision = 'approved' then
    select i.preview_blocker into v_blocker from public.approval_inbox_v6 i
      where i.id = p_request_id;
    if v_blocker is not null or v_request.expires_at is null then
      raise exception 'Incomplete exact-version evidence: %',
        coalesce(v_blocker, 'expiry missing') using errcode = '23514';
    end if;
  end if;
  insert into public.approval_decision_events_v6 (
    request_id,decision,actor_id,actor_aal,artifact_hash,
    source_decision_ref,reason
  ) values (
    p_request_id,p_decision,auth.uid(),'aal2',v_hash,
    btrim(p_source_decision_ref),nullif(btrim(p_reason), '')
  ) returning id into v_id;
  return v_id;
end;
$$;

revoke execute on function public.reject_approval_ledger_mutation_v6()
  from public, anon, authenticated, service_role;
revoke execute on function public.register_approval_request_v6(jsonb)
  from public, anon, authenticated, service_role;
revoke execute on function public.attach_approval_evidence_v6(uuid,text,text,jsonb)
  from public, anon, authenticated, service_role;
revoke execute on function public.record_approval_decision_v6(uuid,text,text,text,text)
  from public, anon, authenticated, service_role;

comment on table public.approval_requests_v6 is
  'Append-only canonical approval requests. A source-specific owning RPC must create the row in its transaction.';
comment on table public.approval_request_evidence_v6 is
  'At most one immutable evidence attachment completes a request whose source snapshot arrives later.';
comment on table public.approval_decision_events_v6 is
  'Append-only human AAL2 decision log, recorded by a source-specific owning RPC after its local transition.';

select public.lock_down_definer_functions();

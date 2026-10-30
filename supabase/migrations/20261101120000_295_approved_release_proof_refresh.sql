-- B008 / 295: retain a human's exact approved plan while refreshing the same
-- independently verified GitHub packet. No merge, SQL apply, deploy or switch
-- is performed by this migration.

create table public.production_release_approval_bindings_v6 (
  request_id uuid primary key references public.approval_requests_v6(id) on delete restrict,
  decision_id uuid not null unique references public.approval_decision_events_v6(id) on delete restrict,
  attestation_id uuid not null references public.production_release_attestations_v6(id) on delete restrict,
  source_version text not null check (source_version ~ '^[0-9a-f]{64}$'),
  packet_sha256 text not null check (packet_sha256 ~ '^[0-9a-f]{64}$'),
  bound_at timestamptz not null default clock_timestamp()
);
create trigger production_release_approval_bindings_v6_append_only
  before update or delete on public.production_release_approval_bindings_v6
  for each row execute function public.reject_approval_ledger_mutation_v6();
create trigger production_release_approval_bindings_v6_no_truncate
  before truncate on public.production_release_approval_bindings_v6
  for each statement execute function public.reject_approval_ledger_mutation_v6();
alter table public.production_release_approval_bindings_v6 enable row level security;
create policy production_release_approval_bindings_v6_admin_read
  on public.production_release_approval_bindings_v6 for select to authenticated
  using (coalesce(public.is_admin(),false));
revoke all on public.production_release_approval_bindings_v6
  from public, anon, authenticated, service_role;
grant select on public.production_release_approval_bindings_v6
  to authenticated, service_role;

-- The request-row lock in record_approval_decision_v6 serializes this trigger
-- with the proof writer. The latest proof is therefore the exact packet the
-- AAL2 admin saw when the approval event was appended.
create function public.bind_approved_production_release_packet_v6()
returns trigger language plpgsql volatile security definer
set search_path = pg_catalog, public set timezone = 'UTC' as $$
declare
  v_request public.approval_requests_v6%rowtype;
  v_proof public.production_release_attestations_v6%rowtype;
begin
  if new.decision is distinct from 'approved' then return new; end if;
  select * into v_request from public.approval_requests_v6
    where id = new.request_id;
  if not found or v_request.source_system is distinct from 'aa_console'
    or v_request.source_kind is distinct from 'production_release' then
    return new;
  end if;
  if auth.role() is distinct from 'authenticated'
    or auth.uid() is distinct from new.actor_id
    or coalesce(auth.jwt()->>'aal','') <> 'aal2'
    or new.actor_aal is distinct from 'aal2'
    or not coalesce(public.is_admin(),false)
    or v_request.source_version is distinct from new.artifact_hash
    or v_request.artifact_hash is distinct from new.artifact_hash then
    raise exception 'Only the exact human release decision can bind proof.'
      using errcode = '42501';
  end if;
  select * into v_proof from public.production_release_attestations_v6
    where request_id = new.request_id order by event_order desc limit 1;
  if not found or v_proof.source_version is distinct from v_request.source_version
    or v_proof.packet_sha256 is distinct from v_proof.packet->>'packetSha256'
    or v_proof.attested_at < clock_timestamp() - interval '15 minutes'
    or v_request.expires_at <= clock_timestamp() then
    raise exception 'The exact release proof is stale or mismatched.'
      using errcode = '23514';
  end if;
  insert into public.production_release_approval_bindings_v6 (
    request_id,decision_id,attestation_id,source_version,packet_sha256
  ) values (
    new.request_id,new.id,v_proof.id,v_request.source_version,v_proof.packet_sha256
  );
  return new;
end;
$$;
revoke execute on function public.bind_approved_production_release_packet_v6()
  from public, anon, authenticated, service_role;
create trigger approval_decision_events_v6_bind_production_release
  after insert on public.approval_decision_events_v6
  for each row execute function public.bind_approved_production_release_packet_v6();

-- Any approval created in a hypothetical gap between 293 and 295 must be
-- reviewed rather than guessed into a proof binding by timestamp. In normal
-- ordered rollout these migrations are held and no such decision exists.
do $$
begin
  if exists (
    select 1 from public.approval_decision_events_v6 d
    join public.approval_requests_v6 r on r.id = d.request_id
    where r.source_system = 'aa_console'
      and r.source_kind = 'production_release'
      and d.decision = 'approved'
  ) then
    raise exception 'Existing approved release decisions need explicit proof review before 295.'
      using errcode = '23514';
  end if;
end;
$$;

create function public.refresh_approved_production_release_attestation_v6(
  p_request_id uuid, p_packet jsonb
) returns uuid language plpgsql volatile security definer
set search_path = pg_catalog, public set timezone = 'UTC' as $$
declare
  v_request public.approval_requests_v6%rowtype;
  v_source public.production_release_candidates_v6%rowtype;
  v_decision public.approval_decision_events_v6%rowtype;
  v_binding public.production_release_approval_bindings_v6%rowtype;
  v_original public.production_release_attestations_v6%rowtype;
  v_latest public.production_release_attestations_v6%rowtype;
  v_hash text;
  v_id uuid;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the trusted release attester may refresh proof.'
      using errcode = '42501';
  end if;
  select * into v_request from public.approval_requests_v6
    where id = p_request_id for update;
  if not found or v_request.source_system is distinct from 'aa_console'
    or v_request.source_kind is distinct from 'production_release'
    or v_request.client_id is not null or v_request.owner_role is distinct from 'admin'
    or v_request.requester_kind is distinct from 'human'
    or v_request.source_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception 'Production release request is invalid.' using errcode = '23514';
  end if;
  select * into v_source from public.production_release_candidates_v6
    where id = v_request.source_id::uuid;
  if not found or v_source.submitted_by is distinct from v_request.requested_by
    or v_source.version_hash is distinct from v_request.source_version
    or v_request.artifact_hash is distinct from v_source.version_hash
    or v_request.preview is distinct from v_source.candidate
    or v_request.expires_at is distinct from v_source.expires_at
    or v_source.expires_at <= clock_timestamp() then
    raise exception 'Production release source changed or expired.'
      using errcode = '23514';
  end if;
  select * into v_decision from public.approval_decision_events_v6
    where request_id = p_request_id order by event_order desc limit 1;
  select * into v_binding from public.production_release_approval_bindings_v6
    where request_id = p_request_id;
  if v_decision.id is null or v_decision.decision is distinct from 'approved'
    or v_decision.actor_aal is distinct from 'aal2'
    or v_decision.artifact_hash is distinct from v_source.version_hash
    or v_binding.decision_id is distinct from v_decision.id
    or v_binding.source_version is distinct from v_source.version_hash then
    raise exception 'Latest exact AAL2 release approval is absent or revoked.'
      using errcode = '23514';
  end if;
  select * into v_original from public.production_release_attestations_v6
    where id = v_binding.attestation_id;
  if not found or v_original.request_id is distinct from p_request_id
    or v_original.source_version is distinct from v_binding.source_version
    or v_original.packet_sha256 is distinct from v_binding.packet_sha256
    or v_original.packet->>'packetSha256' is distinct from v_binding.packet_sha256 then
    raise exception 'Bound original GitHub proof is invalid.' using errcode = '23514';
  end if;
  if p_packet is null or jsonb_typeof(p_packet) is distinct from 'object'
    or length(p_packet::text) > 256000
    or p_packet is distinct from v_original.packet then
    raise exception 'New GitHub proof differs from the human-approved packet.'
      using errcode = '23514';
  end if;
  v_hash := encode(sha256(convert_to(public.canonical_release_json_v6(
    p_packet - 'packetSha256'), 'UTF8')), 'hex');
  if v_hash is distinct from v_binding.packet_sha256
    or p_packet->>'packetSha256' is distinct from v_hash then
    raise exception 'Refreshed GitHub proof digest is invalid.'
      using errcode = '23514';
  end if;
  select * into v_latest from public.production_release_attestations_v6
    where request_id = p_request_id order by event_order desc limit 1;
  if v_latest.id is not null
    and v_latest.packet_sha256 is distinct from v_binding.packet_sha256 then
    raise exception 'Latest GitHub proof differs from approved proof.'
      using errcode = '23514';
  end if;
  if v_latest.id is not null
    and v_latest.attested_at >= clock_timestamp() - interval '5 minutes' then
    return v_latest.id;
  end if;
  insert into public.production_release_attestations_v6 (
    request_id,source_version,packet,packet_sha256
  ) values (p_request_id,v_source.version_hash,p_packet,v_hash)
    returning id into v_id;
  return v_id;
end;
$$;
revoke execute on function public.refresh_approved_production_release_attestation_v6(uuid,jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.refresh_approved_production_release_attestation_v6(uuid,jsonb)
  to service_role;

insert into public.approval_class_coverage_versions_v6 (
  class_id,revision,class_key,title,source_state,source_evidence,
  decision_state,decision_evidence,executor_state,executor_evidence,blocker
) values (
  32,4,'production_release','Production release approval',
  'blocked','295 immutable approved packet binding and server-only proof refresh; live pilot pending',
  'blocked','Latest AAL2 decision remains required after refresh; revocation blocks it',
  'missing',null,
  'Mandatory protected check, trusted merge/effect lease, production SQL, Railway and Pages gates and live pilot remain.'
);

select public.lock_down_definer_functions();

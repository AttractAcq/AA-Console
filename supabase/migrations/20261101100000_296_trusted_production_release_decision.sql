-- B008 / 293: turn the held production-release source into a human-decidable
-- exact-version plan only after server-side GitHub verification. This does
-- not merge, apply SQL, deploy a service, publish Pages, or enable a switch.
-- The release effect gates and live deployment receipts remain separate.

create function public.canonical_release_json_v6(p_value jsonb)
returns text language plpgsql immutable strict
set search_path = pg_catalog, public as $$
declare
  v_key text;
  v_item jsonb;
  v_result text := '';
begin
  if jsonb_typeof(p_value) = 'object' then
    for v_key, v_item in
      select key, value from jsonb_each(p_value) order by key collate "C"
    loop
      if v_result <> '' then v_result := v_result || ','; end if;
      v_result := v_result || to_jsonb(v_key)::text || ':'
        || public.canonical_release_json_v6(v_item);
    end loop;
    return '{' || v_result || '}';
  elsif jsonb_typeof(p_value) = 'array' then
    for v_item in select value from jsonb_array_elements(p_value) with ordinality
      as item(value, ordinal) order by ordinal
    loop
      if v_result <> '' then v_result := v_result || ','; end if;
      v_result := v_result || public.canonical_release_json_v6(v_item);
    end loop;
    return '[' || v_result || ']';
  end if;
  return p_value::text;
end;
$$;
revoke execute on function public.canonical_release_json_v6(jsonb)
  from public, anon, authenticated, service_role;

create table public.production_release_attestations_v6 (
  id uuid primary key default gen_random_uuid(),
  event_order bigint generated always as identity unique,
  request_id uuid not null references public.approval_requests_v6(id) on delete restrict,
  source_version text not null check (source_version ~ '^[0-9a-f]{64}$'),
  packet jsonb not null check (jsonb_typeof(packet) = 'object'),
  packet_sha256 text not null check (packet_sha256 ~ '^[0-9a-f]{64}$'),
  attested_at timestamptz not null default clock_timestamp()
);
create index production_release_attestations_v6_latest_idx
  on public.production_release_attestations_v6(request_id,event_order desc);
create trigger production_release_attestations_v6_append_only
  before update or delete on public.production_release_attestations_v6
  for each row execute function public.reject_approval_ledger_mutation_v6();
create trigger production_release_attestations_v6_no_truncate
  before truncate on public.production_release_attestations_v6
  for each statement execute function public.reject_approval_ledger_mutation_v6();
alter table public.production_release_attestations_v6 enable row level security;
create policy production_release_attestations_v6_admin_read
  on public.production_release_attestations_v6 for select to authenticated
  using (coalesce(public.is_admin(),false));
revoke all on public.production_release_attestations_v6
  from public, anon, authenticated, service_role;
grant select on public.production_release_attestations_v6
  to authenticated, service_role;

create function public.record_trusted_production_release_attestation_v6(
  p_request_id uuid, p_packet jsonb
) returns uuid language plpgsql volatile security definer
set search_path = pg_catalog, public set timezone = 'UTC' as $$
declare
  v_request public.approval_requests_v6%rowtype;
  v_source public.production_release_candidates_v6%rowtype;
  v_claim jsonb;
  v_check jsonb;
  v_verified jsonb;
  v_hash text;
  v_id uuid;
begin
  -- This RPC is for a trusted server process that invokes the GitHub verifier
  -- itself. Caller-provided browser JSON has no execute grant. Service-key
  -- custody remains part of the security boundary.
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the release attester service may write this proof.'
      using errcode = '42501';
  end if;
  select * into v_request from public.approval_requests_v6
    where id = p_request_id for update;
  if not found or v_request.source_system is distinct from 'aa_console'
    or v_request.source_kind is distinct from 'production_release'
    or v_request.client_id is not null or v_request.owner_role is distinct from 'admin'
    or v_request.source_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception 'Production release request is invalid.' using errcode = '23514';
  end if;
  select * into v_source from public.production_release_candidates_v6
    where id = v_request.source_id::uuid;
  if not found or v_source.version_hash is distinct from v_request.source_version
    or v_request.artifact_hash is distinct from v_source.version_hash
    or v_request.preview is distinct from v_source.candidate
    or v_request.expires_at is distinct from v_source.expires_at
    or v_source.expires_at <= clock_timestamp() then
    raise exception 'Production release source changed or expired.' using errcode = '23514';
  end if;
  if exists (select 1 from public.approval_decision_events_v6 d
    where d.request_id = p_request_id) then
    raise exception 'A decided release candidate cannot be reattested.'
      using errcode = '23514';
  end if;
  if p_packet is null or jsonb_typeof(p_packet) is distinct from 'object'
    or length(p_packet::text) > 256000
    or p_packet->>'kind' is distinct from 'github_premerge_release_evidence'
    or p_packet->'schemaVersion' is distinct from '1'::jsonb
    or p_packet->'releaseAuthorized' is distinct from 'false'::jsonb
    or p_packet->'productionSchemaVerified' is distinct from 'false'::jsonb
    or p_packet->'futureDeploymentSha' is distinct from 'null'::jsonb
    or p_packet->>'premergePrHeadSha' is distinct from
      v_source.candidate->'pr'->>'head_sha'
    or not coalesce(p_packet->>'packetSha256' ~ '^[0-9a-f]{64}$',false) then
    raise exception 'GitHub premerge packet is malformed or overclaims release authority.'
      using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_object_keys(p_packet) k
    where k not in ('schemaVersion','kind','repository','pr','checks',
      'migrations','premergePrHeadSha','futureDeploymentSha',
      'productionSchemaVerified','releaseAuthorized','packetSha256')) then
    raise exception 'GitHub packet has unknown root fields.' using errcode = '22023';
  end if;
  v_hash := encode(sha256(convert_to(public.canonical_release_json_v6(
    p_packet - 'packetSha256'), 'UTF8')), 'hex');
  if v_hash is distinct from p_packet->>'packetSha256' then
    raise exception 'GitHub packet digest does not match its exact contents.'
      using errcode = '23514';
  end if;
  if p_packet->'repository'->>'fullName' is distinct from
      v_source.candidate->>'repository'
    or not coalesce((p_packet->'repository'->>'id') ~ '^[1-9][0-9]*$',false)
    or p_packet->'pr'->>'number' is distinct from
      v_source.candidate->'pr'->>'number'
    or p_packet->'pr'->>'url' is distinct from
      v_source.candidate->'pr'->>'url'
    or p_packet->'pr'->'head'->>'sha' is distinct from
      v_source.candidate->'pr'->>'head_sha'
    or p_packet->'pr'->'base'->>'sha' is distinct from
      v_source.candidate->'pr'->>'base_sha'
    or p_packet->'pr'->'head'->>'repositoryId' is distinct from
      p_packet->'repository'->>'id'
    or p_packet->'pr'->'base'->>'repositoryId' is distinct from
      p_packet->'repository'->>'id'
    or v_source.candidate->'deployment'->>'browser_pr_head_sha' is distinct from
      p_packet->'pr'->'head'->>'sha' then
    raise exception 'Verified GitHub repository or PR does not match the source card.'
      using errcode = '23514';
  end if;
  if p_packet->'checks'->>'workflowRunId' is null
    or not coalesce((p_packet->'checks'->>'workflowRunId') ~ '^[1-9][0-9]*$',false)
    or not coalesce((p_packet->'checks'->>'workflowSha256') ~ '^[0-9a-f]{64}$',false)
    or jsonb_typeof(p_packet->'checks'->'required') is distinct from 'array'
    or jsonb_array_length(p_packet->'checks'->'required') <> 4 then
    raise exception 'Verified CI run is incomplete.' using errcode = '23514';
  end if;
  for v_claim in select value from jsonb_array_elements(v_source.candidate->'checks')
  loop
    select value into v_verified from jsonb_array_elements(
      p_packet->'checks'->'required')
      where value->>'name' = v_claim->>'name';
    if not found or v_verified->>'headSha' is distinct from v_claim->>'head_sha'
      or v_verified->>'runId' is distinct from v_claim->>'run_id'
      or v_verified->>'runId' is distinct from
        p_packet->'checks'->>'workflowRunId'
      or not coalesce((v_verified->>'checkRunId') ~ '^[1-9][0-9]*$',false)
      or v_claim->>'conclusion' is distinct from 'success' then
      raise exception 'Verified CI job differs from the candidate.'
        using errcode = '23514';
    end if;
  end loop;
  if (select count(distinct value->>'name') from jsonb_array_elements(
        p_packet->'checks'->'required')) <> 4 then
    raise exception 'Verified CI jobs are duplicated.' using errcode = '23514';
  end if;
  if p_packet->'migrations'->>'sourceMarkerHead' is distinct from
      v_source.candidate->'schema'->>'current_head'
    or p_packet->'migrations'->>'targetHead' is distinct from
      v_source.candidate->'schema'->>'target_head'
    or p_packet->'migrations'->'pending' is distinct from
      v_source.candidate->'migrations' then
    raise exception 'Verified committed SQL differs from release migration plan.'
      using errcode = '23514';
  end if;
  insert into public.production_release_attestations_v6 (
    request_id,source_version,packet,packet_sha256
  ) values (p_request_id,v_source.version_hash,p_packet,v_hash)
    returning id into v_id;
  return v_id;
end;
$$;
revoke execute on function public.record_trusted_production_release_attestation_v6(uuid,jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.record_trusted_production_release_attestation_v6(uuid,jsonb)
  to service_role;

create or replace function public.production_release_source_state_v6(p_request_id uuid)
returns text language plpgsql volatile security definer
set search_path = pg_catalog, public set timezone = 'UTC' as $$
declare
  v_request public.approval_requests_v6%rowtype;
  v_source public.production_release_candidates_v6%rowtype;
  v_proof public.production_release_attestations_v6%rowtype;
begin
  select * into v_request from public.approval_requests_v6 where id = p_request_id;
  if not found or v_request.source_system is distinct from 'aa_console'
    or v_request.source_kind is distinct from 'production_release' then
    return 'unverified';
  end if;
  if auth.role() is distinct from 'service_role'
    and (auth.role() is distinct from 'authenticated'
      or not coalesce(public.is_admin(),false)
      or not public.can_review_approval_request_v6(
        v_request.client_id,v_request.owner_role)) then
    return 'unverified';
  end if;
  if v_request.source_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then return 'unverified'; end if;
  select * into v_source from public.production_release_candidates_v6
    where id = v_request.source_id::uuid;
  if not found then return 'cancelled'; end if;
  if v_request.client_id is not null or v_request.owner_role is distinct from 'admin'
    or v_request.requester_kind is distinct from 'human'
    or v_request.requested_by is distinct from v_source.submitted_by
    or v_request.source_version is distinct from v_source.version_hash
    or v_request.artifact_hash is distinct from v_source.version_hash
    or v_request.preview is distinct from v_source.candidate
    or v_request.expires_at is distinct from v_source.expires_at then
    return 'superseded';
  end if;
  select * into v_proof from public.production_release_attestations_v6
    where request_id = p_request_id order by event_order desc limit 1;
  if not found or v_proof.source_version is distinct from v_source.version_hash
    or v_proof.attested_at < clock_timestamp() - interval '15 minutes' then
    return 'source_held';
  end if;
  return 'pending';
end;
$$;

create function public.decide_production_release_candidate_v6(
  p_request_id uuid, p_expected_source_version text,
  p_expected_artifact_hash text, p_decision text,
  p_reason text default null
) returns uuid language plpgsql volatile security definer
set search_path = pg_catalog, public set timezone = 'UTC' as $$
declare
  v_request public.approval_requests_v6%rowtype;
  v_source public.production_release_candidates_v6%rowtype;
begin
  if auth.role() is distinct from 'authenticated' or auth.uid() is null
    or not coalesce(public.is_admin(),false)
    or coalesce(auth.jwt()->>'aal','') <> 'aal2' then
    raise exception 'Only a provisioned admin with AAL2 can decide a release.'
      using errcode = '42501';
  end if;
  if p_decision not in ('approved','rejected','revoked') or p_decision is null
    or (p_decision <> 'approved' and nullif(btrim(coalesce(p_reason,'')),'') is null) then
    raise exception 'A valid release decision and reason are required.'
      using errcode = '22023';
  end if;
  select * into v_request from public.approval_requests_v6
    where id = p_request_id for update;
  if not found or v_request.source_system is distinct from 'aa_console'
    or v_request.source_kind is distinct from 'production_release'
    or v_request.client_id is not null or v_request.owner_role is distinct from 'admin'
    or v_request.source_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception 'Production release request is invalid.' using errcode = '23514';
  end if;
  select * into v_source from public.production_release_candidates_v6
    where id = v_request.source_id::uuid;
  if not found or v_request.source_version is distinct from v_source.version_hash
    or v_request.artifact_hash is distinct from v_source.version_hash
    or v_request.preview is distinct from v_source.candidate
    or v_request.expires_at is distinct from v_source.expires_at
    or p_expected_source_version is distinct from v_source.version_hash
    or p_expected_artifact_hash is distinct from v_source.version_hash then
    raise exception 'Production release candidate version changed.' using errcode = '23514';
  end if;
  if p_decision = 'approved' and
      (v_source.expires_at <= clock_timestamp() or
       public.production_release_source_state_v6(p_request_id) <> 'pending') then
    raise exception 'Release evidence is stale, held or expired.' using errcode = '23514';
  end if;
  return public.record_approval_decision_v6(
    p_request_id,p_decision,v_source.version_hash,
    'production_release:' || p_request_id::text || ':' || p_decision,
    p_reason
  );
end;
$$;
revoke execute on function public.decide_production_release_candidate_v6(uuid,text,text,text,text)
  from public, anon, authenticated, service_role;
grant execute on function public.decide_production_release_candidate_v6(uuid,text,text,text,text)
  to authenticated;

-- Repeat the 292 view, preserving its column order and all non-release
-- adapters. The only release changes are the visible trusted packet, current
-- source-state blocker and decision status when a held card is rejected.
create or replace view public.approval_inbox_v6 with (security_invoker = true) as
select
  r.id, r.client_id, r.source_system, r.source_kind, r.source_id,
  r.source_version, r.title,
  case
    when r.source_system = 'aa_console' and r.source_kind = 'production_release'
      and d.decision in ('rejected','revoked') then d.decision
    when r.source_system = 'aa_console'
      and r.source_kind in ('production_release','recruitment_meta_build',
        'organic_publication')
      and s.source_state = 'source_held'
      and r.expires_at is not null and r.expires_at <= now() then 'expired'
    when s.source_state in ('cancelled','superseded','source_held','unverified')
      then s.source_state
    when d.decision = 'revoked' then 'revoked'
    when d.decision = 'rejected' then 'rejected'
    when r.expires_at is not null and r.expires_at <= now() then 'expired'
    when d.decision = 'approved' then 'approved'
    when s.source_state <> 'pending' then s.source_state
    else 'pending'
  end as status,
  r.requested_at, r.requested_by, r.requester_kind, r.requester_ref,
  r.expires_at,
  coalesce(e.artifact_hash,r.artifact_hash) as artifact_hash,
  case when r.source_system = 'aa_console'
      and r.source_kind = 'production_release' and a.id is not null
    then jsonb_build_object('candidate',r.preview,'trusted_github_evidence',a.packet)
    else coalesce(e.preview,r.preview) end as preview,
  coalesce(e.destination,r.destination) as destination,
  coalesce(e.account_ref,r.account_ref) as account_ref,
  coalesce(e.budget,r.budget) as budget,
  coalesce(e.scope,r.scope) as scope,
  r.owner_role,
  case
    when r.source_system = 'aa_console' and r.source_kind = 'production_release'
      then case when s.source_state = 'pending' then null
        else 'Release source and four checks are not independently attested. Refresh trusted GitHub evidence for this exact candidate; no release effect is authorized by this card alone.' end
    when r.source_system = 'aa_console'
      and r.source_kind = 'recruitment_meta_build' then coalesce(
        nullif(btrim(r.preview_blocker),''),
        'Recruitment Meta creation still lacks exact media bytes and an AAL2 prewrite gate.')
    when r.source_system = 'aa_console'
      and r.source_kind = 'organic_publication' then coalesce(
        nullif(btrim(r.preview_blocker),''),
        'Organic publication lacks rights provenance, exact AAL2 approval and prewrite attestation.')
    when r.expires_at is null then 'An expiry is missing.'
    when nullif(btrim(coalesce(r.owner_role,'')),'') is null then 'The decision owner is missing.'
    when e.id is not null then null
    when nullif(btrim(coalesce(r.preview_blocker,'')),'') is not null then r.preview_blocker
    when r.artifact_hash is null then 'The exact artifact hash is missing.'
    when r.preview is null or jsonb_typeof(r.preview) <> 'object'
      or r.preview = '{}'::jsonb then 'The exact artifact preview is missing.'
    when r.scope is null or r.scope = '{}'::jsonb then 'The exact scope is missing.'
    else null
  end as preview_blocker,
  r.owning_path,
  s.source_state
from public.approval_requests_v6 r
left join public.approval_request_evidence_v6 e on e.request_id = r.id
left join lateral (
  select de.decision from public.approval_decision_events_v6 de
  where de.request_id = r.id order by de.event_order desc limit 1
) d on true
left join lateral (
  select pa.id,pa.packet from public.production_release_attestations_v6 pa
  where pa.request_id = r.id order by pa.event_order desc limit 1
) a on true
cross join lateral (
  select case
    when r.source_system = 'aa_console' and r.source_kind = 'production_release'
      then public.production_release_source_state_v6(r.id)
    when r.source_system = 'aa_console' and r.source_kind = 'recruitment_meta_build'
      then public.recruitment_meta_build_source_state_v6(r.id)
    when r.source_system = 'aa_console' and r.source_kind = 'organic_publication'
      then public.organic_publication_source_state_v6(r.id)
    else public.approval_source_state_v6(r.id)
  end as source_state
) s;
revoke all on public.approval_inbox_v6 from public, anon, authenticated, service_role;
grant select on public.approval_inbox_v6 to authenticated, service_role;

insert into public.approval_class_coverage_versions_v6 (
  class_id,revision,class_key,title,source_state,source_evidence,
  decision_state,decision_evidence,executor_state,executor_evidence,blocker
) values (
  32,3,'production_release','Production release approval',
  'blocked','293 source candidate and trusted GitHub packet shown in one Inbox card',
  'blocked','293 exact AAL2 admin decision and revocation in canonical ledger; live pilot pending',
  'missing',null,
  'Merge, Supabase migration, Railway and Pages effects still need independent pre-effect approval/identity gates and deployed receipts.'
);

select public.lock_down_definer_functions();

-- B008 / 288: freeze a production release candidate into the agency Inbox.
-- This is deliberately a blocked source adapter. A human or Bot cannot turn
-- caller-supplied CI claims into an approved release; trusted GitHub,
-- migration and deployment attestation plus effect gates follow separately.
-- No switch, deployment or migration is changed by this source registration.

create table public.production_release_candidates_v6 (
  id uuid primary key default gen_random_uuid(),
  candidate jsonb not null check (jsonb_typeof(candidate) = 'object'),
  expires_at timestamptz not null,
  version_hash text not null unique check (version_hash ~ '^[0-9a-f]{64}$'),
  submitted_by uuid not null,
  submitted_at timestamptz not null default now()
);

create trigger production_release_candidates_v6_append_only
  before update or delete on public.production_release_candidates_v6
  for each row execute function public.reject_approval_ledger_mutation_v6();
create trigger production_release_candidates_v6_no_truncate
  before truncate on public.production_release_candidates_v6
  for each statement execute function public.reject_approval_ledger_mutation_v6();

alter table public.production_release_candidates_v6 enable row level security;
create policy production_release_candidates_v6_admin_read
  on public.production_release_candidates_v6 for select to authenticated
  using (coalesce(public.is_admin(), false));
revoke all on public.production_release_candidates_v6
  from public, anon, authenticated, service_role;
grant select on public.production_release_candidates_v6
  to authenticated, service_role;

create function public.submit_production_release_candidate_v6(
  p_candidate jsonb, p_expires_at timestamptz
) returns uuid language plpgsql volatile security definer
set search_path = pg_catalog, public set timezone = 'UTC' as $$
declare
  v_pr jsonb;
  v_checks jsonb;
  v_migrations jsonb;
  v_schema jsonb;
  v_deployment jsonb;
  v_head text;
  v_base text;
  v_pr_number text;
  v_version text;
  v_id uuid;
  v_check_names text[];
  v_migration_count integer;
  v_last_migration text;
begin
  if auth.role() is distinct from 'authenticated' or auth.uid() is null
    or not coalesce(public.is_admin(), false)
    or coalesce(auth.jwt()->>'aal', '') <> 'aal2' then
    raise exception 'Only a provisioned admin with AAL2 may submit a release candidate.'
      using errcode = '42501';
  end if;
  if p_expires_at is null or p_expires_at <= clock_timestamp() + interval '5 minutes'
    or p_expires_at > clock_timestamp() + interval '48 hours' then
    raise exception 'Release candidate expiry must be between 5 minutes and 48 hours.'
      using errcode = '22023';
  end if;
  if jsonb_typeof(p_candidate) is distinct from 'object' then
    raise exception 'Release candidate must be a JSON object.'
      using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_object_keys(p_candidate) k
    where k not in ('repository','pr','checks','migrations','schema',
      'deployment','switch_plan','rollback')
  ) then
    raise exception 'Release candidate has an invalid root shape.'
      using errcode = '22023';
  end if;
  v_pr := p_candidate->'pr';
  v_checks := p_candidate->'checks';
  v_migrations := p_candidate->'migrations';
  v_schema := p_candidate->'schema';
  v_deployment := p_candidate->'deployment';
  v_head := v_pr->>'head_sha';
  v_base := v_pr->>'base_sha';
  v_pr_number := v_pr->>'number';
  if jsonb_typeof(v_pr) is distinct from 'object' then
    raise exception 'Release candidate PR must be an object.'
      using errcode = '22023';
  end if;
  if p_candidate->>'repository' is distinct from 'AttractAcq/AA-Console'
    or exists (select 1 from jsonb_object_keys(v_pr) k
      where k not in ('number','url','head_sha','base_sha','merge_method'))
    or not coalesce(v_pr_number ~ '^[1-9][0-9]*$', false)
    or v_pr->>'url' is distinct from
      'https://github.com/AttractAcq/AA-Console/pull/' || v_pr_number
    or not coalesce(v_head ~ '^[0-9a-f]{40}$', false)
    or not coalesce(v_base ~ '^[0-9a-f]{40}$', false)
    or not coalesce(v_pr->>'merge_method' in ('squash','merge','rebase'), false) then
    raise exception 'Release candidate PR identity is incomplete or invalid.'
      using errcode = '22023';
  end if;
  if jsonb_typeof(v_checks) is distinct from 'array' then
    raise exception 'Release candidate checks must be an array.'
      using errcode = '22023';
  end if;
  if jsonb_array_length(v_checks) <> 4
    or exists (select 1 from jsonb_array_elements(v_checks) c
      where jsonb_typeof(c) is distinct from 'object'
        or c->>'head_sha' is distinct from v_head
        or c->>'conclusion' is distinct from 'success'
        or not coalesce(c->>'run_id' ~ '^[1-9][0-9]*$', false)) then
    raise exception 'Release candidate must name four successful checks on the exact PR head.'
      using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_array_elements(v_checks) c,
      lateral jsonb_object_keys(c) k
      where k not in ('name','head_sha','run_id','conclusion')) then
    raise exception 'Release candidate check contains an unknown field.'
      using errcode = '22023';
  end if;
  select array_agg(c->>'name' order by c->>'name') into v_check_names
    from jsonb_array_elements(v_checks) c;
  if v_check_names is distinct from array[
    'Agent runtime (typecheck, test, build)',
    'Frontend (lint, typecheck, test, build)',
    'MCP gateway (typecheck, test, build)',
    'Schema replay (clean, upgrade, catalog, types)'
  ]::text[] then
    raise exception 'Release candidate check names do not match protected CI.'
      using errcode = '22023';
  end if;
  if jsonb_typeof(v_migrations) is distinct from 'array'
    or jsonb_typeof(v_schema) is distinct from 'object' then
    raise exception 'Release candidate migrations and schema must have the required shape.'
      using errcode = '22023';
  end if;
  if not coalesce(v_schema->>'current_head' ~ '^[0-9]{14}$', false)
    or not coalesce(v_schema->>'target_head' ~ '^[0-9]{14}$', false)
    or exists (select 1 from jsonb_object_keys(v_schema) k
      where k not in ('current_head','target_head'))
    or exists (select 1 from jsonb_array_elements(v_migrations) m
      where jsonb_typeof(m) is distinct from 'object'
        or not coalesce(m->>'version' ~ '^[0-9]{14}$', false)
        or not coalesce(m->>'filename' ~ '^[0-9]{14}_[A-Za-z0-9_.-]+[.]sql$', false)
        or left(m->>'filename', 14) is distinct from m->>'version'
        or not coalesce(m->>'sha256' ~ '^[0-9a-f]{64}$', false)) then
    raise exception 'Release candidate migration plan is incomplete or invalid.'
      using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_array_elements(v_migrations) m,
      lateral jsonb_object_keys(m) k
      where k not in ('version','filename','sha256')) then
    raise exception 'Release candidate migration contains an unknown field.'
      using errcode = '22023';
  end if;
  select count(*)::integer, max(m->>'version')
    into v_migration_count, v_last_migration
    from jsonb_array_elements(v_migrations) m;
  if (v_migration_count = 0
      and v_schema->>'target_head' is distinct from v_schema->>'current_head')
    or (v_migration_count > 0 and (
      v_schema->>'target_head' is distinct from v_last_migration
      or v_migration_count <> (select count(distinct m->>'version')
        from jsonb_array_elements(v_migrations) m)
      or exists (select 1 from jsonb_array_elements(v_migrations) m
        where m->>'version' <= v_schema->>'current_head')
      or exists (select 1 from jsonb_array_elements(v_migrations)
        with ordinality m(value, ordinal)
        join jsonb_array_elements(v_migrations)
        with ordinality prior(value, ordinal)
          on prior.ordinal + 1 = m.ordinal
        where prior.value->>'version' >= m.value->>'version')
    )) then
    raise exception 'Release candidate migration versions must be distinct and ordered.'
      using errcode = '22023';
  end if;
  if jsonb_typeof(v_deployment) is distinct from 'object'
    or jsonb_typeof(p_candidate->'switch_plan') is distinct from 'array'
    or jsonb_typeof(p_candidate->'rollback') is distinct from 'object' then
    raise exception 'Release deployment, switches and rollback must have the required shape.'
      using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_object_keys(v_deployment) k
      where k not in ('browser_pr_head_sha','runtime_pin_sha','gateway_pin_sha',
        'railway_environment_id','runtime_service_id','gateway_service_id',
        'manifest_sha256'))
    or v_deployment->>'browser_pr_head_sha' is distinct from v_head
    or not coalesce(v_deployment->>'runtime_pin_sha' ~ '^[0-9a-f]{40}$', false)
    or not coalesce(v_deployment->>'gateway_pin_sha' ~ '^[0-9a-f]{40}$', false)
    or not coalesce(v_deployment->>'manifest_sha256' ~ '^[0-9a-f]{64}$', false)
    or nullif(btrim(v_deployment->>'railway_environment_id'), '') is null
    or nullif(btrim(v_deployment->>'runtime_service_id'), '') is null
    or nullif(btrim(v_deployment->>'gateway_service_id'), '') is null
    or jsonb_array_length(p_candidate->'switch_plan') <> 0
    or exists (select 1 from jsonb_object_keys(p_candidate->'rollback') k
      where k <> 'strategy')
    or not coalesce(p_candidate->'rollback'->>'strategy'
      in ('forward_fix','redeploy_prior_version'), false) then
    raise exception 'Release deployment and rollback scope is incomplete or unsupported.'
      using errcode = '22023';
  end if;

  -- PostgreSQL jsonb text has a deterministic key order. Include expiry in
  -- the hash so resubmitting the same plan with another expiry is a new card.
  v_version := encode(sha256(convert_to(jsonb_build_object(
    'candidate', p_candidate, 'expires_at', p_expires_at
  )::text, 'UTF8')), 'hex');
  insert into public.production_release_candidates_v6 (
    candidate, expires_at, version_hash, submitted_by
  ) values (p_candidate, p_expires_at, v_version, auth.uid())
    on conflict (version_hash) do nothing returning id into v_id;
  if v_id is null then
    select id into v_id from public.production_release_candidates_v6
      where version_hash = v_version;
    return v_id;
  end if;
  perform public.register_approval_request_v6(jsonb_build_object(
    'source_system', 'aa_console',
    'source_kind', 'production_release',
    'source_id', v_id::text,
    'source_version', v_version,
    'title', 'Production release PR #' || v_pr_number,
    'artifact_hash', v_version,
    'preview', p_candidate,
    'destination', 'AA-Console production release',
    'account_ref', v_deployment->>'railway_environment_id',
    'scope', jsonb_build_object(
      'repository', 'AttractAcq/AA-Console',
      'pr_head_sha', v_head,
      'base_sha', v_base,
      'migration_target_head', v_schema->>'target_head',
      'railway_environment_id', v_deployment->>'railway_environment_id',
      'switch_plan', p_candidate->'switch_plan'
    ),
    'owner_role', 'admin',
    'expires_at', p_expires_at,
    'preview_blocker',
      'Release source and four checks are not independently attested. No merge, migration, Railway or Pages effect gate is connected.',
    'requested_by', auth.uid(),
    'requester_kind', 'human'
  ));
  return v_id;
end;
$$;
revoke execute on function public.submit_production_release_candidate_v6(jsonb,timestamptz)
  from public, anon, authenticated, service_role;
grant execute on function public.submit_production_release_candidate_v6(jsonb,timestamptz)
  to authenticated;

-- The 279 source-state adapter deliberately treats new kinds as unverified.
-- Keep this new kind scoped: compare the immutable candidate with the frozen
-- request, but leave all earlier source adapters and their contracts intact.
create function public.production_release_source_state_v6(p_request_id uuid)
returns text language plpgsql stable security definer
set search_path = pg_catalog, public set timezone = 'UTC' as $$
declare
  v_request public.approval_requests_v6%rowtype;
  v_source public.production_release_candidates_v6%rowtype;
begin
  select * into v_request from public.approval_requests_v6 where id = p_request_id;
  if not found or v_request.source_system is distinct from 'aa_console'
    or v_request.source_kind is distinct from 'production_release' then
    return 'unverified';
  end if;
  if auth.role() is distinct from 'service_role'
    and (auth.role() is distinct from 'authenticated'
      or not coalesce(public.is_admin(), false)
      or not public.can_review_approval_request_v6(
        v_request.client_id, v_request.owner_role)) then
    return 'unverified';
  end if;
  if v_request.source_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then return 'unverified'; end if;
  select * into v_source from public.production_release_candidates_v6
    where id = v_request.source_id::uuid;
  if not found then return 'cancelled'; end if;
  if v_request.client_id is not null
    or v_request.owner_role is distinct from 'admin'
    or v_request.requester_kind is distinct from 'human'
    or v_request.requested_by is distinct from v_source.submitted_by
    or v_request.source_version is distinct from v_source.version_hash
    or v_request.artifact_hash is distinct from v_source.version_hash
    or v_request.preview is distinct from v_source.candidate
    or v_request.expires_at is distinct from v_source.expires_at then
    return 'superseded';
  end if;
  -- The candidate is an immutable source snapshot, not verified CI,
  -- deployment, schema or external-effect authority.
  return 'source_held';
end;
$$;
revoke all on function public.production_release_source_state_v6(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.production_release_source_state_v6(uuid)
  to authenticated, service_role;

-- Preserve the exact 279 column set, ordering, RLS and existing source-kind
-- behavior. A source attachment cannot erase this class's release blocker.
create or replace view public.approval_inbox_v6 with (security_invoker = true) as
select
  r.id, r.client_id, r.source_system, r.source_kind, r.source_id,
  r.source_version, r.title,
  case
    when r.source_system = 'aa_console'
      and r.source_kind = 'production_release'
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
  coalesce(e.artifact_hash, r.artifact_hash) as artifact_hash,
  coalesce(e.preview, r.preview) as preview,
  coalesce(e.destination, r.destination) as destination,
  coalesce(e.account_ref, r.account_ref) as account_ref,
  coalesce(e.budget, r.budget) as budget,
  coalesce(e.scope, r.scope) as scope,
  r.owner_role,
  case
    when r.source_system = 'aa_console'
      and r.source_kind = 'production_release' then coalesce(
        nullif(btrim(r.preview_blocker), ''),
        'Release source and external effects are not independently attested.')
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
  r.owning_path,
  s.source_state
from public.approval_requests_v6 r
left join public.approval_request_evidence_v6 e on e.request_id = r.id
left join lateral (
  select de.decision from public.approval_decision_events_v6 de
  where de.request_id = r.id
  order by de.event_order desc limit 1
) d on true
cross join lateral (
  select case
    when r.source_system = 'aa_console' and r.source_kind = 'production_release'
      then public.production_release_source_state_v6(r.id)
    else public.approval_source_state_v6(r.id)
  end as source_state
) s;
revoke all on public.approval_inbox_v6 from public, anon, authenticated, service_role;
grant select on public.approval_inbox_v6 to authenticated, service_role;

insert into public.approval_class_coverage_versions_v6 (
  class_id, revision, class_key, title,
  source_state, source_evidence, decision_state, decision_evidence,
  executor_state, executor_evidence, blocker
) values (
  32, 2, 'production_release', 'Production release approval',
  'blocked', '288 blocked source candidate and canonical Inbox card',
  'missing', null, 'missing', null,
  'Independent GitHub/schema/deployment attestation, human AAL2 decision and each external effect gate are absent.'
);

select public.lock_down_definer_functions();

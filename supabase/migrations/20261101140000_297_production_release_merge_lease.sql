-- B008 / 297: a held, server-only lease around the exact approved PR merge.
-- This migration performs no merge, deploy, SQL application or switch change.
-- There is deliberately no automatic lease expiry: an unknown GitHub merge
-- outcome must be reconciled before a revocation can become effective.

create table public.production_release_merge_leases_v6 (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.approval_requests_v6(id) on delete restrict,
  decision_id uuid not null references public.approval_decision_events_v6(id) on delete restrict,
  source_version text not null check (source_version ~ '^[0-9a-f]{64}$'),
  packet_sha256 text not null check (packet_sha256 ~ '^[0-9a-f]{64}$'),
  pr_number bigint not null check (pr_number > 0),
  head_sha text not null check (head_sha ~ '^[0-9a-f]{40}$'),
  base_sha text not null check (base_sha ~ '^[0-9a-f]{40}$'),
  merge_method text not null check (merge_method in ('squash','merge','rebase')),
  state text not null default 'active' check (state in ('active','dispatched','completed','aborted')),
  created_at timestamptz not null default clock_timestamp(),
  dispatched_at timestamptz,
  completed_at timestamptz,
  aborted_at timestamptz,
  observed_merge_sha text check (observed_merge_sha ~ '^[0-9a-f]{40}$'),
  abort_reason text,
  check ((state = 'active' and dispatched_at is null and completed_at is null
      and aborted_at is null and observed_merge_sha is null and abort_reason is null)
    or (state = 'dispatched' and dispatched_at is not null and completed_at is null
      and aborted_at is null and observed_merge_sha is null and abort_reason is null)
    or (state = 'completed' and dispatched_at is not null and completed_at is not null
      and aborted_at is null and observed_merge_sha is not null and abort_reason is null)
    or (state = 'aborted' and dispatched_at is null and completed_at is null
      and aborted_at is not null and observed_merge_sha is null
      and nullif(btrim(abort_reason),'') is not null))
);
create index production_release_merge_leases_v6_state_idx
  on public.production_release_merge_leases_v6(state,created_at);
-- A pre-dispatch abort is safely retryable after a new live verification.
-- Dispatched or completed attempts remain unique until their outcome is known.
create unique index production_release_merge_leases_v6_effect_once_idx
  on public.production_release_merge_leases_v6(request_id)
  where state in ('active','dispatched','completed');

create table public.production_release_merge_lease_events_v6 (
  id uuid primary key default gen_random_uuid(),
  event_order bigint generated always as identity unique,
  lease_id uuid not null references public.production_release_merge_leases_v6(id) on delete restrict,
  state text not null check (state in ('active','dispatched','completed','aborted')),
  observed_merge_sha text check (observed_merge_sha ~ '^[0-9a-f]{40}$'),
  reason text,
  recorded_at timestamptz not null default clock_timestamp()
);
create index production_release_merge_lease_events_v6_latest_idx
  on public.production_release_merge_lease_events_v6(lease_id,event_order desc);
create trigger production_release_merge_lease_events_v6_append_only
  before update or delete on public.production_release_merge_lease_events_v6
  for each row execute function public.reject_approval_ledger_mutation_v6();
create trigger production_release_merge_lease_events_v6_no_truncate
  before truncate on public.production_release_merge_lease_events_v6
  for each statement execute function public.reject_approval_ledger_mutation_v6();

create function public.enforce_release_merge_lease_transition_v6()
returns trigger language plpgsql volatile security definer
set search_path = pg_catalog, public set timezone = 'UTC' as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Release merge leases cannot be deleted.' using errcode = '42501';
  end if;
  if old.id is distinct from new.id or old.request_id is distinct from new.request_id
    or old.decision_id is distinct from new.decision_id
    or old.source_version is distinct from new.source_version
    or old.packet_sha256 is distinct from new.packet_sha256
    or old.pr_number is distinct from new.pr_number
    or old.head_sha is distinct from new.head_sha
    or old.base_sha is distinct from new.base_sha
    or old.merge_method is distinct from new.merge_method
    or old.created_at is distinct from new.created_at
    or not ((old.state = 'active' and new.state in ('dispatched','aborted'))
      or (old.state = 'dispatched' and new.state = 'completed')) then
    raise exception 'Release merge lease transition is invalid.' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke execute on function public.enforce_release_merge_lease_transition_v6()
  from public, anon, authenticated, service_role;
create trigger production_release_merge_leases_v6_transition
  before update or delete on public.production_release_merge_leases_v6
  for each row execute function public.enforce_release_merge_lease_transition_v6();
create trigger production_release_merge_leases_v6_no_truncate
  before truncate on public.production_release_merge_leases_v6
  for each statement execute function public.reject_approval_ledger_mutation_v6();

alter table public.production_release_merge_leases_v6 enable row level security;
alter table public.production_release_merge_lease_events_v6 enable row level security;
create policy production_release_merge_leases_v6_admin_read
  on public.production_release_merge_leases_v6 for select to authenticated
  using (coalesce(public.is_admin(),false));
create policy production_release_merge_lease_events_v6_admin_read
  on public.production_release_merge_lease_events_v6 for select to authenticated
  using (coalesce(public.is_admin(),false));
revoke all on public.production_release_merge_leases_v6,
  public.production_release_merge_lease_events_v6
  from public, anon, authenticated, service_role;
grant select on public.production_release_merge_leases_v6,
  public.production_release_merge_lease_events_v6 to authenticated, service_role;

-- record_approval_decision_v6 already locks the approval request row. Every
-- lease transition also takes that lock first, so a revocation either commits
-- before acquisition or is refused until the merge outcome is known.
create function public.block_release_revocation_during_merge_v6()
returns trigger language plpgsql volatile security definer
set search_path = pg_catalog, public set timezone = 'UTC' as $$
begin
  if new.decision = 'revoked' and exists (
    select 1 from public.production_release_merge_leases_v6 l
    where l.request_id = new.request_id and l.state in ('active','dispatched')
  ) then
    raise exception 'Release merge is in progress; reconcile its GitHub outcome before revocation.'
      using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke execute on function public.block_release_revocation_during_merge_v6()
  from public, anon, authenticated, service_role;
create trigger approval_decision_events_v6_block_release_merge_revocation
  before insert on public.approval_decision_events_v6
  for each row execute function public.block_release_revocation_during_merge_v6();

create function public.acquire_production_release_merge_lease_v6(
  p_request_id uuid, p_source_version text, p_packet_sha256 text,
  p_pr_number bigint, p_head_sha text, p_base_sha text, p_merge_method text
) returns uuid language plpgsql volatile security definer
set search_path = pg_catalog, public set timezone = 'UTC' as $$
declare
  v_request public.approval_requests_v6%rowtype;
  v_source public.production_release_candidates_v6%rowtype;
  v_decision public.approval_decision_events_v6%rowtype;
  v_binding public.production_release_approval_bindings_v6%rowtype;
  v_proof public.production_release_attestations_v6%rowtype;
  v_card record;
  v_id uuid;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the trusted release merger may acquire a lease.' using errcode = '42501';
  end if;
  select * into v_request from public.approval_requests_v6
    where id = p_request_id for update;
  if not found or v_request.source_system is distinct from 'aa_console'
    or v_request.source_kind is distinct from 'production_release'
    or v_request.client_id is not null or v_request.owner_role is distinct from 'admin'
    or v_request.requester_kind is distinct from 'human'
    or v_request.expires_at <= clock_timestamp() then
    raise exception 'Release request is missing, scoped incorrectly or expired.'
      using errcode = '23514';
  end if;
  select * into v_source from public.production_release_candidates_v6
    where id = v_request.source_id::uuid;
  if not found or v_source.submitted_by is distinct from v_request.requested_by
    or v_source.version_hash is distinct from v_request.source_version
    or v_request.artifact_hash is distinct from v_source.version_hash
    or v_request.preview is distinct from v_source.candidate
    or v_request.expires_at is distinct from v_source.expires_at
    or p_source_version is distinct from v_source.version_hash
    or p_pr_number::text is distinct from v_source.candidate->'pr'->>'number'
    or p_head_sha is distinct from v_source.candidate->'pr'->>'head_sha'
    or p_base_sha is distinct from v_source.candidate->'pr'->>'base_sha'
    or p_merge_method is distinct from v_source.candidate->'pr'->>'merge_method' then
    raise exception 'Release source or expected GitHub plan changed.' using errcode = '23514';
  end if;
  select * into v_decision from public.approval_decision_events_v6
    where request_id = p_request_id order by event_order desc limit 1;
  select * into v_binding from public.production_release_approval_bindings_v6
    where request_id = p_request_id;
  select * into v_proof from public.production_release_attestations_v6
    where request_id = p_request_id order by event_order desc limit 1;
  select status,source_state,preview_blocker into v_card
    from public.approval_inbox_v6 where id = p_request_id;
  if v_decision.id is null or v_decision.decision is distinct from 'approved'
    or v_decision.actor_aal is distinct from 'aal2'
    or v_decision.artifact_hash is distinct from v_source.version_hash
    or v_binding.decision_id is distinct from v_decision.id
    or v_binding.source_version is distinct from v_source.version_hash
    or v_binding.packet_sha256 is distinct from p_packet_sha256
    or v_proof.source_version is distinct from v_source.version_hash
    or v_proof.packet_sha256 is distinct from p_packet_sha256
    or v_proof.packet->>'packetSha256' is distinct from p_packet_sha256
    or v_proof.attested_at < clock_timestamp() - interval '15 minutes'
    or v_card.status is distinct from 'approved'
    or v_card.source_state is distinct from 'pending'
    or v_card.preview_blocker is not null then
    raise exception 'Latest exact AAL2 release approval or proof is not current.'
      using errcode = '23514';
  end if;
  if exists (select 1 from public.production_release_merge_leases_v6
    where request_id = p_request_id and state in ('active','dispatched','completed')) then
    raise exception 'Release request has an unresolved or completed merge attempt.'
      using errcode = '23514';
  end if;
  insert into public.production_release_merge_leases_v6 (
    request_id,decision_id,source_version,packet_sha256,
    pr_number,head_sha,base_sha,merge_method
  ) values (
    p_request_id,v_decision.id,v_source.version_hash,p_packet_sha256,
    p_pr_number,p_head_sha,p_base_sha,p_merge_method
  ) returning id into v_id;
  insert into public.production_release_merge_lease_events_v6(lease_id,state)
    values (v_id,'active');
  return v_id;
end;
$$;
revoke execute on function public.acquire_production_release_merge_lease_v6(uuid,text,text,bigint,text,text,text)
  from public, anon, authenticated, service_role;
grant execute on function public.acquire_production_release_merge_lease_v6(uuid,text,text,bigint,text,text,text)
  to service_role;

create function public.dispatch_production_release_merge_lease_v6(p_lease_id uuid)
returns uuid language plpgsql volatile security definer
set search_path = pg_catalog, public set timezone = 'UTC' as $$
declare
  v_request_id uuid;
  v_request public.approval_requests_v6%rowtype;
  v_lease public.production_release_merge_leases_v6%rowtype;
  v_decision public.approval_decision_events_v6%rowtype;
  v_proof public.production_release_attestations_v6%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the trusted release merger may dispatch.' using errcode = '42501';
  end if;
  select request_id into v_request_id from public.production_release_merge_leases_v6
    where id = p_lease_id;
  if not found then raise exception 'Release merge lease is missing.' using errcode = '23514'; end if;
  select * into v_request from public.approval_requests_v6
    where id = v_request_id for update;
  select * into v_lease from public.production_release_merge_leases_v6
    where id = p_lease_id for update;
  select * into v_decision from public.approval_decision_events_v6
    where request_id = v_request_id order by event_order desc limit 1;
  select * into v_proof from public.production_release_attestations_v6
    where request_id = v_request_id order by event_order desc limit 1;
  if v_lease.state is distinct from 'active'
    or v_decision.id is distinct from v_lease.decision_id
    or v_decision.decision is distinct from 'approved'
    or v_request.expires_at <= clock_timestamp()
    or v_proof.packet_sha256 is distinct from v_lease.packet_sha256
    or v_proof.attested_at < clock_timestamp() - interval '15 minutes'
    or public.production_release_source_state_v6(v_request_id) <> 'pending' then
    raise exception 'Release approval or proof changed before merge dispatch.'
      using errcode = '23514';
  end if;
  update public.production_release_merge_leases_v6
    set state = 'dispatched', dispatched_at = clock_timestamp()
    where id = p_lease_id;
  insert into public.production_release_merge_lease_events_v6(lease_id,state)
    values (p_lease_id,'dispatched');
  return p_lease_id;
end;
$$;
revoke execute on function public.dispatch_production_release_merge_lease_v6(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.dispatch_production_release_merge_lease_v6(uuid)
  to service_role;

create function public.abort_production_release_merge_lease_v6(
  p_lease_id uuid, p_reason text
) returns uuid language plpgsql volatile security definer
set search_path = pg_catalog, public set timezone = 'UTC' as $$
declare
  v_request_id uuid;
  v_lease public.production_release_merge_leases_v6%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the trusted release merger may abort.' using errcode = '42501';
  end if;
  if nullif(btrim(coalesce(p_reason,'')),'') is null then
    raise exception 'A pre-dispatch abort reason is required.' using errcode = '22023';
  end if;
  select request_id into v_request_id from public.production_release_merge_leases_v6
    where id = p_lease_id;
  if not found then raise exception 'Release merge lease is missing.' using errcode = '23514'; end if;
  perform 1 from public.approval_requests_v6 where id = v_request_id for update;
  select * into v_lease from public.production_release_merge_leases_v6
    where id = p_lease_id for update;
  if v_lease.state is distinct from 'active' then
    raise exception 'A dispatched merge cannot be aborted without GitHub reconciliation.'
      using errcode = '23514';
  end if;
  update public.production_release_merge_leases_v6
    set state = 'aborted', aborted_at = clock_timestamp(), abort_reason = btrim(p_reason)
    where id = p_lease_id;
  insert into public.production_release_merge_lease_events_v6(lease_id,state,reason)
    values (p_lease_id,'aborted',btrim(p_reason));
  return p_lease_id;
end;
$$;
revoke execute on function public.abort_production_release_merge_lease_v6(uuid,text)
  from public, anon, authenticated, service_role;
grant execute on function public.abort_production_release_merge_lease_v6(uuid,text)
  to service_role;

create function public.complete_production_release_merge_lease_v6(
  p_lease_id uuid, p_observed_merge_sha text
) returns uuid language plpgsql volatile security definer
set search_path = pg_catalog, public set timezone = 'UTC' as $$
declare
  v_request_id uuid;
  v_lease public.production_release_merge_leases_v6%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the trusted release merger may complete.' using errcode = '42501';
  end if;
  if not coalesce(p_observed_merge_sha ~ '^[0-9a-f]{40}$',false) then
    raise exception 'Observed merge commit SHA is invalid.' using errcode = '22023';
  end if;
  select request_id into v_request_id from public.production_release_merge_leases_v6
    where id = p_lease_id;
  if not found then raise exception 'Release merge lease is missing.' using errcode = '23514'; end if;
  perform 1 from public.approval_requests_v6 where id = v_request_id for update;
  select * into v_lease from public.production_release_merge_leases_v6
    where id = p_lease_id for update;
  if v_lease.state is distinct from 'dispatched' then
    raise exception 'Only a dispatched merge can receive a verified GitHub receipt.'
      using errcode = '23514';
  end if;
  update public.production_release_merge_leases_v6
    set state = 'completed', completed_at = clock_timestamp(),
      observed_merge_sha = p_observed_merge_sha
    where id = p_lease_id;
  insert into public.production_release_merge_lease_events_v6(
    lease_id,state,observed_merge_sha
  ) values (p_lease_id,'completed',p_observed_merge_sha);
  return p_lease_id;
end;
$$;
revoke execute on function public.complete_production_release_merge_lease_v6(uuid,text)
  from public, anon, authenticated, service_role;
grant execute on function public.complete_production_release_merge_lease_v6(uuid,text)
  to service_role;

insert into public.approval_class_coverage_versions_v6 (
  class_id,revision,class_key,title,source_state,source_evidence,
  decision_state,decision_evidence,executor_state,executor_evidence,blocker
) values (
  32,5,'production_release','Production release approval',
  'blocked','297 held merge lease binds the immutable AAL2-approved plan',
  'blocked','Revocation is serialized and refused during unresolved merge dispatch',
  'missing',null,
  'Scoped merger custody, mandatory protection, Railway/SQL/Pages effect gates and live pilot remain.'
);

select public.lock_down_definer_functions();

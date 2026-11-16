-- Phase 1: exact source dependencies. A decision may depend on several
-- versioned inputs; any one changing invalidates that decision. The old
-- approval event remains in the append-only ledger for audit.

create unique index if not exists approval_requests_v6_id_client_unique
  on public.approval_requests_v6 (id, client_id);

create table public.delivery_approval_dependencies_v6 (
  approval_request_id uuid not null,
  entity_version_id uuid not null,
  client_id uuid not null references public.clients(id) on delete cascade,
  bound_at timestamptz not null default now(),
  primary key (approval_request_id, entity_version_id),
  foreign key (approval_request_id, client_id)
    references public.approval_requests_v6(id, client_id) on delete restrict,
  foreign key (entity_version_id, client_id)
    references public.delivery_entity_versions_v6(id, client_id) on delete restrict
);

create table public.delivery_work_inputs_v6 (
  work_item_id uuid not null references public.delivery_work_items_v6(id)
    on delete cascade,
  entity_version_id uuid not null,
  client_id uuid not null references public.clients(id) on delete cascade,
  bound_at timestamptz not null default now(),
  primary key (work_item_id, entity_version_id),
  foreign key (entity_version_id, client_id)
    references public.delivery_entity_versions_v6(id, client_id) on delete restrict
);

create function public.guard_delivery_work_input_v6()
returns trigger language plpgsql
set search_path = pg_catalog, public as $$
declare w public.delivery_work_items_v6%rowtype;
begin
  if tg_op <> 'INSERT' then
    raise exception 'A work input is immutable. Create a new work version.';
  end if;
  select * into w from public.delivery_work_items_v6
    where id = new.work_item_id;
  if not found or w.client_id <> new.client_id or w.state <> 'draft' then
    raise exception 'Work inputs must be bound to a draft of the same client.';
  end if;
  return new;
end $$;
create trigger delivery_work_inputs_v6_guard
  before insert or update or delete on public.delivery_work_inputs_v6
  for each row execute function public.guard_delivery_work_input_v6();

create function public.bind_delivery_work_input_v6(
  p_work_item_id uuid, p_owner_module text, p_entity_version_id uuid
) returns void
language plpgsql volatile security definer
set search_path = pg_catalog, public
as $$
declare w public.delivery_work_items_v6%rowtype;
declare e public.delivery_entity_versions_v6%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'A trusted module worker is required.' using errcode = '42501';
  end if;
  select * into w from public.delivery_work_items_v6
    where id = p_work_item_id for update;
  select * into e from public.delivery_entity_versions_v6
    where id = p_entity_version_id;
  if w.id is null or e.id is null or w.client_id <> e.client_id
     or w.owner_module is distinct from p_owner_module then
    raise exception 'Input, client and owning module must match.';
  end if;
  if w.state <> 'draft' then
    raise exception 'Inputs can only be bound before work is prepared.';
  end if;
  insert into public.delivery_work_inputs_v6 (
    work_item_id, entity_version_id, client_id
  ) values (w.id, e.id, w.client_id)
  on conflict do nothing;
end $$;

create function public.bind_delivery_approval_dependency_v6(
  p_approval_request_id uuid, p_entity_version_id uuid
) returns void
language plpgsql volatile security definer
set search_path = pg_catalog, public
as $$
declare r public.approval_requests_v6%rowtype;
declare e public.delivery_entity_versions_v6%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'A trusted source adapter is required.' using errcode = '42501';
  end if;
  select * into r from public.approval_requests_v6
    where id = p_approval_request_id for update;
  select * into e from public.delivery_entity_versions_v6
    where id = p_entity_version_id;
  if r.id is null or e.id is null or r.client_id is null
     or r.client_id <> e.client_id then
    raise exception 'Approval and source version must belong to one client.';
  end if;
  if exists (select 1 from public.approval_decision_events_v6 d
    where d.request_id = r.id) then
    raise exception 'Dependencies cannot be added after a decision.';
  end if;
  if not exists (select 1 from public.delivery_entity_heads_v6 h
    where h.client_id = e.client_id and h.entity_kind = e.entity_kind
      and h.source_key = e.source_key and h.entity_version_id = e.id) then
    raise exception 'An approval cannot bind a stale source version.';
  end if;
  insert into public.delivery_approval_dependencies_v6 (
    approval_request_id, entity_version_id, client_id
  ) values (r.id, e.id, r.client_id)
  on conflict do nothing;
end $$;

-- Existing and new campaign-action cards are bound automatically to the
-- current campaign plan and selected offer. Source adapters bind additional
-- proof, destination and artifact versions using the narrow RPC above.
create function public.bind_campaign_action_sources_v6(p_request_id uuid)
returns void language plpgsql volatile security definer
set search_path = pg_catalog, public as $$
declare
  r public.approval_requests_v6%rowtype;
  a public.campaign_action_approvals%rowtype;
begin
  select * into r from public.approval_requests_v6 where id = p_request_id;
  if r.source_kind <> 'campaign_action' or r.client_id is null then
    return;
  end if;
  select * into a from public.campaign_action_approvals
    where id::text = r.source_id and client_id = r.client_id;
  if not found then return; end if;
  insert into public.delivery_approval_dependencies_v6 (
    approval_request_id, entity_version_id, client_id
  )
  select r.id, h.entity_version_id, r.client_id
  from public.delivery_entity_heads_v6 h
  where h.client_id = r.client_id and h.entity_kind = 'campaign'
    and h.source_key = a.campaign_id::text
  on conflict do nothing;
  insert into public.delivery_approval_dependencies_v6 (
    approval_request_id, entity_version_id, client_id
  )
  select r.id, h.entity_version_id, r.client_id
  from public.client_campaigns c
  join public.service_offer_versions v on v.id = c.offer_version_id
    and v.client_id = c.client_id
  join public.delivery_entity_heads_v6 h on h.client_id = c.client_id
    and ((h.entity_kind = 'offer_version' and h.source_key = v.id::text)
      or (h.entity_kind = 'offer' and h.source_key = v.offer_id::text))
  where c.id = a.campaign_id and c.client_id = r.client_id
  on conflict do nothing;
end $$;

create function public.bind_campaign_action_sources_trigger_v6()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public as $$
begin
  perform public.bind_campaign_action_sources_v6(new.id);
  return new;
end $$;
create trigger approval_campaign_sources_v6
  after insert on public.approval_requests_v6
  for each row when (new.source_kind = 'campaign_action')
  execute function public.bind_campaign_action_sources_trigger_v6();

do $$ declare r record;
begin
  for r in select id from public.approval_requests_v6
    where source_kind = 'campaign_action' and client_id is not null loop
    perform public.bind_campaign_action_sources_v6(r.id);
  end loop;
end $$;
revoke all on function public.bind_campaign_action_sources_v6(uuid)
  from public, anon, authenticated, service_role;

create table public.delivery_approval_invalidations_v6 (
  id uuid primary key default gen_random_uuid(),
  approval_request_id uuid not null references public.approval_requests_v6(id)
    on delete restrict,
  client_id uuid not null references public.clients(id) on delete cascade,
  old_entity_version_id uuid not null references public.delivery_entity_versions_v6(id)
    on delete restrict,
  new_entity_version_id uuid not null references public.delivery_entity_versions_v6(id)
    on delete restrict,
  reason text not null,
  invalidated_at timestamptz not null default now(),
  unique (approval_request_id, old_entity_version_id, new_entity_version_id)
);

create table public.delivery_remediation_tasks_v6 (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  approval_request_id uuid not null references public.approval_requests_v6(id)
    on delete restrict,
  invalidation_id uuid not null unique references public.delivery_approval_invalidations_v6(id)
    on delete restrict,
  external_use_kind text not null,
  external_use_id uuid not null,
  reason text not null,
  state text not null default 'open' check (state in ('open','resolved')),
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolution_note text,
  check ((state = 'open' and resolved_at is null)
    or (state = 'resolved' and resolved_at is not null
      and nullif(btrim(resolution_note),'') is not null))
);

create function public.invalidate_delivery_dependents_v6()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public
as $$
begin
  if new.entity_version_id is not distinct from old.entity_version_id then
    return null;
  end if;
  insert into public.delivery_approval_invalidations_v6 (
    approval_request_id, client_id, old_entity_version_id,
    new_entity_version_id, reason
  )
  select d.approval_request_id, d.client_id,
    old.entity_version_id, new.entity_version_id,
    'A bound ' || old.entity_kind || ' source changed after the request.'
  from public.delivery_approval_dependencies_v6 d
  where d.entity_version_id = old.entity_version_id
  on conflict do nothing;

  -- A completed external use of that exact campaign-action approval needs a
  -- person to inspect/retract it. This does not claim that an approved-but-
  -- unexecuted action reached a provider.
  insert into public.delivery_remediation_tasks_v6 (
    client_id, approval_request_id, invalidation_id,
    external_use_kind, external_use_id, reason
  )
  select i.client_id, i.approval_request_id, i.id,
    'campaign_action_execution', x.id,
    'Source changed after an externally executed campaign action; inspect its destination.'
  from public.delivery_approval_invalidations_v6 i
  join public.approval_requests_v6 r on r.id = i.approval_request_id
    and r.client_id = i.client_id
    and r.source_kind = 'campaign_action'
  join public.campaign_action_executions x on x.approval_id::text = r.source_id
    and x.client_id = i.client_id and x.status = 'executed'
  where i.old_entity_version_id = old.entity_version_id
    and i.new_entity_version_id = new.entity_version_id
  on conflict do nothing;
  return null;
end $$;
create trigger delivery_entity_head_invalidate_v6
  after update of entity_version_id on public.delivery_entity_heads_v6
  for each row execute function public.invalidate_delivery_dependents_v6();

-- A stale dependency cannot receive a new yes, even if a caller reaches the
-- source-specific decision function instead of reading the Inbox first.
create function public.guard_stale_delivery_decision_v6()
returns trigger language plpgsql
set search_path = pg_catalog, public as $$
begin
  if new.decision = 'approved' and exists (
    select 1 from public.delivery_approval_invalidations_v6 i
    where i.approval_request_id = new.request_id
  ) then
    raise exception 'A bound source changed. Request approval for the new version.';
  end if;
  return new;
end $$;
create trigger approval_decision_delivery_staleness_v6
  before insert on public.approval_decision_events_v6
  for each row execute function public.guard_stale_delivery_decision_v6();

-- Preserve every existing Inbox column and source-specific hold rule while
-- making a bound source change visible in the same canonical queue. This is
-- the latest view from migration 296 plus the two invalidation branches.
create or replace view public.approval_inbox_v6 with (security_invoker = true) as
select
  r.id, r.client_id, r.source_system, r.source_kind, r.source_id,
  r.source_version, r.title,
  case
    when r.source_system = 'aa_console' and r.source_kind = 'production_release'
      and d.decision in ('rejected','revoked') then d.decision
    when inv.id is not null
      and coalesce(d.decision,'') not in ('rejected','revoked') then 'stale'
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
    when inv.id is not null then
      'A bound source changed after this exact request. Create and review a new request.'
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
  select i.id from public.delivery_approval_invalidations_v6 i
  where i.approval_request_id = r.id
  order by i.invalidated_at desc limit 1
) inv on true
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

create view public.delivery_work_effective_v6 with (security_invoker = true) as
select w.*,
  case
    when w.state in ('externally_confirmed','archived','revoked') then w.state
    when exists (select 1 from public.delivery_work_inputs_v6 i
      join public.delivery_entity_versions_v6 e on e.id = i.entity_version_id
      left join public.delivery_entity_heads_v6 h
        on h.client_id = e.client_id and h.entity_kind = e.entity_kind
          and h.source_key = e.source_key
      where i.work_item_id = w.id
        and h.entity_version_id is distinct from e.id)
      then 'held'
    when exists (select 1 from public.delivery_work_outputs_v6 o
      join public.delivery_entity_versions_v6 e on e.id = o.entity_version_id
      left join public.delivery_entity_heads_v6 h
        on h.client_id = e.client_id and h.entity_kind = e.entity_kind
          and h.source_key = e.source_key
      where o.work_item_id = w.id
        and h.entity_version_id is distinct from e.id)
      then 'held'
    when exists (select 1 from public.delivery_approval_invalidations_v6 i
      where i.approval_request_id = w.approval_request_id)
      then 'held'
    else w.state
  end as effective_state,
  case
    when w.state = 'externally_confirmed' and (
      exists (select 1 from public.delivery_approval_invalidations_v6 i
        where i.approval_request_id = w.approval_request_id)
      or exists (select 1 from public.delivery_work_inputs_v6 i
        join public.delivery_entity_versions_v6 e on e.id = i.entity_version_id
        left join public.delivery_entity_heads_v6 h
          on h.client_id = e.client_id and h.entity_kind = e.entity_kind
            and h.source_key = e.source_key
        where i.work_item_id = w.id
          and h.entity_version_id is distinct from e.id)
      or exists (select 1 from public.delivery_work_outputs_v6 o
        join public.delivery_entity_versions_v6 e on e.id = o.entity_version_id
        left join public.delivery_entity_heads_v6 h
          on h.client_id = e.client_id and h.entity_kind = e.entity_kind
            and h.source_key = e.source_key
        where o.work_item_id = w.id
          and h.entity_version_id is distinct from e.id)
    ) then 'A confirmed external use has changed sources; inspect its remediation task.'
    when exists (select 1 from public.delivery_work_inputs_v6 i
      join public.delivery_entity_versions_v6 e on e.id = i.entity_version_id
      left join public.delivery_entity_heads_v6 h
        on h.client_id = e.client_id and h.entity_kind = e.entity_kind
          and h.source_key = e.source_key
      where i.work_item_id = w.id
        and h.entity_version_id is distinct from e.id)
      then 'An input version changed; create a new work version.'
    when exists (select 1 from public.delivery_work_outputs_v6 o
      join public.delivery_entity_versions_v6 e on e.id = o.entity_version_id
      left join public.delivery_entity_heads_v6 h
        on h.client_id = e.client_id and h.entity_kind = e.entity_kind
          and h.source_key = e.source_key
      where o.work_item_id = w.id
        and h.entity_version_id is distinct from e.id)
      then 'An output version changed; create a new work version.'
    when exists (select 1 from public.delivery_approval_invalidations_v6 i
      where i.approval_request_id = w.approval_request_id)
      then 'The approved source changed; request a new exact-version decision.'
    else w.blocker
  end as effective_blocker
from public.delivery_work_items_v6 w;

alter table public.delivery_approval_dependencies_v6 enable row level security;
alter table public.delivery_work_inputs_v6 enable row level security;
alter table public.delivery_approval_invalidations_v6 enable row level security;
alter table public.delivery_remediation_tasks_v6 enable row level security;
create policy delivery_approval_dependencies_v6_read
  on public.delivery_approval_dependencies_v6 for select to authenticated
  using (public.can_access_client(client_id));
create policy delivery_work_inputs_v6_read
  on public.delivery_work_inputs_v6 for select to authenticated
  using (public.can_access_client(client_id));
create policy delivery_approval_invalidations_v6_read
  on public.delivery_approval_invalidations_v6 for select to authenticated
  using (public.can_access_client(client_id));
create policy delivery_remediation_tasks_v6_read
  on public.delivery_remediation_tasks_v6 for select to authenticated
  using (public.can_access_client(client_id));
revoke all on public.delivery_approval_dependencies_v6,
  public.delivery_work_inputs_v6, public.delivery_approval_invalidations_v6,
  public.delivery_remediation_tasks_v6 from public, anon, authenticated;
grant select on public.delivery_approval_dependencies_v6,
  public.delivery_work_inputs_v6, public.delivery_approval_invalidations_v6,
  public.delivery_remediation_tasks_v6 to authenticated;
grant all on public.delivery_approval_dependencies_v6,
  public.delivery_work_inputs_v6, public.delivery_approval_invalidations_v6,
  public.delivery_remediation_tasks_v6 to service_role;
revoke insert, update, delete on public.delivery_approval_dependencies_v6,
  public.delivery_work_inputs_v6, public.delivery_approval_invalidations_v6,
  public.delivery_remediation_tasks_v6 from service_role;
revoke all on public.delivery_work_effective_v6 from public, anon, authenticated;
grant select on public.delivery_work_effective_v6 to authenticated, service_role;

revoke all on function public.bind_delivery_work_input_v6(uuid,text,uuid),
  public.bind_delivery_approval_dependency_v6(uuid,uuid)
  from public, anon, authenticated;
grant execute on function public.bind_delivery_work_input_v6(uuid,text,uuid),
  public.bind_delivery_approval_dependency_v6(uuid,uuid)
  to service_role;

select public.lock_down_definer_functions();

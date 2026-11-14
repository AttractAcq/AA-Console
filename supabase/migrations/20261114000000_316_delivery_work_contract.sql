-- Phase 1: route identity and evidence-backed delivery work.
-- This adds an operational record beside the immutable campaign manifest.
-- It does not turn on an executor or infer that an old `live` badge is proof.

create unique index if not exists client_campaigns_id_client_unique_v6
  on public.client_campaigns (id, client_id);

create table public.campaign_route_packages_v6 (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null,
  campaign_id uuid not null,
  route text not null check (route in ('organic', 'paid')),
  paid_platform text,
  version integer not null check (version > 0),
  plan_fingerprint text not null check (plan_fingerprint ~ '^[0-9a-f]{32}$'),
  created_at timestamptz not null default now(),
  foreign key (campaign_id, client_id)
    references public.client_campaigns (id, client_id) on delete cascade,
  check ((route = 'organic' and paid_platform is null)
    or (route = 'paid' and paid_platform in ('meta', 'google'))),
  unique (campaign_id, route, version),
  unique (id, client_id),
  unique (id, campaign_id, client_id)
);

comment on table public.campaign_route_packages_v6 is
  'One versioned organic or paid work package beneath a commercial campaign. A both-route campaign has one of each; neither route inherits the other route''s approvals.';

create function public.guard_campaign_route_package_v6()
returns trigger language plpgsql
set search_path = pg_catalog, public as $$
declare c public.client_campaigns%rowtype;
begin
  if tg_op = 'UPDATE' or tg_op = 'DELETE' then
    raise exception 'A route package is immutable. Create a new version.';
  end if;
  select * into c from public.client_campaigns
    where id = new.campaign_id and client_id = new.client_id;
  if not found then raise exception 'Campaign and client do not match.'; end if;
  if (new.route = 'organic' and not c.runs_organic)
     or (new.route = 'paid' and (not c.runs_paid
       or new.paid_platform is distinct from c.paid_platform)) then
    raise exception 'Route package does not match the campaign route.';
  end if;
  if new.plan_fingerprint <> public.campaign_plan_fingerprint(c) then
    raise exception 'Route package must fingerprint the current plan.';
  end if;
  if new.version <> coalesce((select max(p.version) + 1
    from public.campaign_route_packages_v6 p
    where p.campaign_id = new.campaign_id and p.route = new.route), 1) then
    raise exception 'Route package versions must be consecutive.';
  end if;
  return new;
end $$;

create trigger campaign_route_packages_v6_guard
  before insert or update or delete on public.campaign_route_packages_v6
  for each row execute function public.guard_campaign_route_package_v6();

-- Existing route-aware campaigns receive package 1 without changing their
-- campaign row or its status. Legacy campaigns have no known route and remain
-- readable without a fabricated package.
insert into public.campaign_route_packages_v6 (
  client_id, campaign_id, route, paid_platform, version, plan_fingerprint
)
select c.client_id, c.id, r.route,
  case when r.route = 'paid' then c.paid_platform else null end,
  1, public.campaign_plan_fingerprint(c)
from public.client_campaigns c
cross join lateral (values
  ('organic'::text, c.runs_organic), ('paid'::text, c.runs_paid)
) r(route, enabled)
where r.enabled;

create index campaign_route_packages_v6_client_idx
  on public.campaign_route_packages_v6 (client_id, campaign_id, route, version desc);

alter table public.campaign_route_packages_v6 enable row level security;
create policy campaign_route_packages_v6_read on public.campaign_route_packages_v6
  for select to authenticated using (public.can_access_client(client_id));
revoke all on public.campaign_route_packages_v6 from public, anon, authenticated;
grant select on public.campaign_route_packages_v6 to authenticated;
grant all on public.campaign_route_packages_v6 to service_role;

-- A mutable record of what a module has actually produced. An immutable
-- manifest item may seed it, but a manifest item itself is never updated.
create table public.delivery_work_items_v6 (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null,
  campaign_id uuid not null,
  route_package_id uuid,
  route_key text not null default 'shared'
    check (route_key in ('shared', 'organic', 'paid')),
  manifest_id uuid,
  manifest_item_key text,
  item_key text not null check (length(btrim(item_key)) between 1 and 120),
  work_version integer not null default 1 check (work_version > 0),
  owner_module text not null check (owner_module in (
    'intelligence_os', 'market_opportunities', 'offer_studio',
    'proof_production_factory', 'content_production_factory',
    'website_studio', 'sales_os', 'lead_magnet_studio',
    'proof_distribution', 'content_distribution', 'meta_ads_studio',
    'google_ads_studio', 'attribution_os', 'archive'
  )),
  required boolean not null,
  input_snapshot jsonb not null default '{}'::jsonb
    check (jsonb_typeof(input_snapshot) = 'object'),
  input_fingerprint text not null check (input_fingerprint ~ '^[0-9a-f]{64}$'),
  expected_output jsonb not null default '{}'::jsonb
    check (jsonb_typeof(expected_output) = 'object'),
  output_refs jsonb not null default '[]'::jsonb
    check (jsonb_typeof(output_refs) = 'array'),
  output_fingerprint text check (output_fingerprint ~ '^[0-9a-f]{64}$'),
  job_id uuid references public.agent_jobs(id) on delete set null,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  cost_usd numeric not null default 0 check (cost_usd >= 0),
  qa_state text not null default 'not_run'
    check (qa_state in ('not_run', 'passed', 'failed')),
  blocker text,
  approval_request_id uuid references public.approval_requests_v6(id) on delete restrict,
  external_result jsonb check (external_result is null
    or jsonb_typeof(external_result) = 'object'),
  retry_after timestamptz,
  remediation text,
  state text not null default 'draft' check (state in (
    'draft', 'prepared', 'ready_for_review', 'approved',
    'execution_due', 'attempted', 'externally_confirmed',
    'held', 'failed', 'revoked', 'archived'
  )),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (campaign_id, client_id)
    references public.client_campaigns(id, client_id) on delete cascade,
  foreign key (route_package_id, campaign_id, client_id)
    references public.campaign_route_packages_v6(id, campaign_id, client_id)
    on delete restrict,
  foreign key (manifest_id, manifest_item_key)
    references public.campaign_manifest_items(manifest_id, item_key)
    on delete restrict,
  check ((route_key = 'shared' and route_package_id is null)
    or (route_key in ('organic', 'paid') and route_package_id is not null)),
  check ((manifest_id is null and manifest_item_key is null)
    or (manifest_id is not null and manifest_item_key is not null)),
  check (state not in ('ready_for_review', 'approved', 'execution_due',
    'attempted', 'externally_confirmed') or output_fingerprint is not null),
  check (state not in ('approved', 'execution_due', 'attempted',
    'externally_confirmed') or approval_request_id is not null),
  check (state not in ('attempted', 'externally_confirmed')
    or attempt_count > 0),
  check (state <> 'externally_confirmed' or external_result is not null)
);

create unique index delivery_work_items_v6_identity
  on public.delivery_work_items_v6 (campaign_id, item_key, route_key, work_version);
create index delivery_work_items_v6_client_state
  on public.delivery_work_items_v6 (client_id, state, updated_at desc);

create function public.guard_delivery_work_item_v6()
returns trigger language plpgsql
set search_path = pg_catalog, public as $$
declare
  v_route text;
  v_manifest_client uuid;
  v_manifest_campaign uuid;
  v_manifest_module text;
  v_manifest_required boolean;
  v_approval_client uuid;
begin
  if new.route_package_id is not null then
    select route into v_route from public.campaign_route_packages_v6
      where id = new.route_package_id and campaign_id = new.campaign_id
        and client_id = new.client_id;
    if v_route is distinct from new.route_key then
      raise exception 'Work item route and route package disagree.';
    end if;
  end if;
  if new.manifest_id is not null then
    select m.client_id, m.campaign_id, i.module_key, i.required
      into v_manifest_client, v_manifest_campaign,
           v_manifest_module, v_manifest_required
    from public.campaign_manifest_versions m
    join public.campaign_manifest_items i on i.manifest_id = m.id
      and i.item_key = new.manifest_item_key
    where m.id = new.manifest_id;
    if v_manifest_client is distinct from new.client_id
       or v_manifest_campaign is distinct from new.campaign_id
       or v_manifest_module is distinct from new.owner_module
       or v_manifest_required is distinct from new.required then
      raise exception 'Work item must match its immutable manifest item.';
    end if;
  end if;
  if new.approval_request_id is not null then
    select client_id into v_approval_client from public.approval_requests_v6
      where id = new.approval_request_id;
    if v_approval_client is distinct from new.client_id then
      raise exception 'Work item approval belongs to another client.';
    end if;
  end if;
  if tg_op = 'UPDATE' then
    if (new.client_id, new.campaign_id, new.route_package_id,
        new.route_key, new.manifest_id, new.manifest_item_key,
        new.item_key, new.work_version, new.owner_module, new.required, new.input_fingerprint)
       is distinct from
       (old.client_id, old.campaign_id, old.route_package_id,
        old.route_key, old.manifest_id, old.manifest_item_key,
        old.item_key, old.work_version, old.owner_module, old.required, old.input_fingerprint) then
      raise exception 'Work item identity and input fingerprint are immutable.';
    end if;
    if new.state is distinct from old.state and not (
      (old.state, new.state) in (
        ('draft','prepared'), ('prepared','ready_for_review'),
        ('ready_for_review','approved'), ('approved','execution_due'),
        ('execution_due','attempted'), ('attempted','externally_confirmed'),
        ('held','prepared'), ('failed','prepared'),
        ('ready_for_review','prepared'), ('approved','revoked'),
        ('execution_due','revoked'), ('attempted','failed'),
        ('attempted','held'), ('prepared','held'),
        ('execution_due','held'), ('draft','archived'),
        ('prepared','archived'), ('ready_for_review','archived'),
        ('approved','archived'), ('externally_confirmed','archived'),
        ('failed','archived'), ('held','archived'), ('revoked','archived'))
    ) then
      raise exception 'Work item cannot move from % to %.', old.state, new.state;
    end if;
  end if;
  new.updated_at := now();
  return new;
end $$;

create trigger delivery_work_items_v6_guard
  before insert or update on public.delivery_work_items_v6
  for each row execute function public.guard_delivery_work_item_v6();

create table public.delivery_work_events_v6 (
  id uuid primary key default gen_random_uuid(),
  work_item_id uuid not null references public.delivery_work_items_v6(id)
    on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  owner_module text not null,
  from_state text,
  to_state text not null,
  evidence jsonb not null default '{}'::jsonb
    check (jsonb_typeof(evidence) = 'object'),
  occurred_at timestamptz not null default now()
);
create index delivery_work_events_v6_item_time
  on public.delivery_work_events_v6 (work_item_id, occurred_at desc);

create function public.record_delivery_work_event_v6()
returns trigger language plpgsql
set search_path = pg_catalog, public as $$
begin
  if tg_op = 'INSERT' or new.state is distinct from old.state then
    insert into public.delivery_work_events_v6 (
      work_item_id, client_id, owner_module, from_state, to_state, evidence
    ) values (
      new.id, new.client_id, new.owner_module,
      case when tg_op = 'INSERT' then null else old.state end,
      new.state, jsonb_build_object(
        'input_fingerprint', new.input_fingerprint,
        'output_fingerprint', new.output_fingerprint,
        'approval_request_id', new.approval_request_id,
        'job_id', new.job_id,
        'attempt_count', new.attempt_count,
        'qa_state', new.qa_state,
        'blocker', new.blocker,
        'external_result', new.external_result
      )
    );
  end if;
  return null;
end $$;
create trigger delivery_work_items_v6_event
  after insert or update on public.delivery_work_items_v6
  for each row execute function public.record_delivery_work_event_v6();

-- The old manifest items were immutable requirements, not progress. Seed a
-- truthful draft work record for each existing item; never infer completion
-- from an old campaign status or a queued job.
insert into public.delivery_work_items_v6 (
  client_id, campaign_id, route_package_id, route_key,
  manifest_id, manifest_item_key, item_key, work_version,
  owner_module, required, input_snapshot, input_fingerprint,
  expected_output
)
select m.client_id, m.campaign_id, p.id, p.route,
  m.id, i.item_key, i.item_key, m.version,
  i.module_key, i.required, src.snapshot,
  encode(sha256(convert_to(src.snapshot::text, 'UTF8')), 'hex'),
  jsonb_build_object('item_key', i.item_key,
    'external_activation', i.external_activation,
    'depends_on', i.depends_on)
from public.campaign_manifest_versions m
join public.campaign_manifest_items i on i.manifest_id = m.id
join public.campaign_route_packages_v6 p
  on p.campaign_id = m.campaign_id and p.client_id = m.client_id
    and p.route = m.acquisition_mode and p.version = 1
cross join lateral (select jsonb_build_object(
  'manifest_id', m.id, 'manifest_version', m.version,
  'plan_hash', m.plan_hash, 'item_key', i.item_key
) as snapshot) src;

create function public.reject_delivery_work_event_mutation_v6()
returns trigger language plpgsql
set search_path = pg_catalog, public as $$
begin
  raise exception 'Delivery work events are append-only.';
end $$;
create trigger delivery_work_events_v6_append_only
  before update or delete on public.delivery_work_events_v6
  for each row execute function public.reject_delivery_work_event_mutation_v6();

alter table public.delivery_work_items_v6 enable row level security;
alter table public.delivery_work_events_v6 enable row level security;
create policy delivery_work_items_v6_read on public.delivery_work_items_v6
  for select to authenticated using (public.can_access_client(client_id));
create policy delivery_work_events_v6_read on public.delivery_work_events_v6
  for select to authenticated using (public.can_access_client(client_id));
revoke all on public.delivery_work_items_v6, public.delivery_work_events_v6
  from public, anon, authenticated;
grant select on public.delivery_work_items_v6, public.delivery_work_events_v6
  to authenticated;
grant all on public.delivery_work_items_v6, public.delivery_work_events_v6
  to service_role;

-- Runtime producers use this narrow entry point; the request key is the
-- campaign/item/route/version tuple. A changed input needs a new version.
create function public.create_delivery_work_item_v6(
  p_campaign_id uuid,
  p_route_package_id uuid,
  p_manifest_id uuid,
  p_manifest_item_key text,
  p_item_key text,
  p_work_version integer,
  p_owner_module text,
  p_required boolean,
  p_input_snapshot jsonb,
  p_expected_output jsonb
) returns public.delivery_work_items_v6
language plpgsql volatile security definer
set search_path = pg_catalog, public
as $$
declare
  c public.client_campaigns%rowtype;
  p public.campaign_route_packages_v6%rowtype;
  v_existing public.delivery_work_items_v6%rowtype;
  v_input_hash text;
  v_route_key text := 'shared';
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'A trusted module worker is required.' using errcode = '42501';
  end if;
  if p_input_snapshot is null or jsonb_typeof(p_input_snapshot) <> 'object'
     or p_expected_output is null or jsonb_typeof(p_expected_output) <> 'object'
     or p_work_version is null or p_work_version < 1 then
    raise exception 'Version, input and expected output are required.';
  end if;
  select * into c from public.client_campaigns where id = p_campaign_id;
  if not found then raise exception 'Campaign not found.'; end if;
  if p_route_package_id is not null then
    select * into p from public.campaign_route_packages_v6
      where id = p_route_package_id and campaign_id = c.id
        and client_id = c.client_id;
    if not found then raise exception 'Route package does not belong to this campaign.'; end if;
    v_route_key := p.route;
  end if;
  v_input_hash := encode(sha256(convert_to(p_input_snapshot::text, 'UTF8')), 'hex');
  select * into v_existing from public.delivery_work_items_v6
    where campaign_id = c.id and item_key = p_item_key
      and route_key = v_route_key and work_version = p_work_version;
  if found then
    if v_existing.input_fingerprint <> v_input_hash
       or v_existing.owner_module is distinct from p_owner_module
       or v_existing.route_package_id is distinct from p_route_package_id
       or v_existing.manifest_id is distinct from p_manifest_id
       or v_existing.manifest_item_key is distinct from p_manifest_item_key
       or v_existing.required is distinct from p_required
       or v_existing.expected_output is distinct from p_expected_output then
      raise exception 'Work item key belongs to different inputs or ownership.';
    end if;
    return v_existing;
  end if;
  insert into public.delivery_work_items_v6 (
    client_id, campaign_id, route_package_id, route_key,
    manifest_id, manifest_item_key, item_key, work_version,
    owner_module, required, input_snapshot, input_fingerprint, expected_output
  ) values (
    c.client_id, c.id, p_route_package_id, v_route_key,
    p_manifest_id, p_manifest_item_key, p_item_key, p_work_version,
    p_owner_module, p_required, p_input_snapshot, v_input_hash, p_expected_output
  ) returning * into v_existing;
  return v_existing;
end $$;

revoke all on function public.create_delivery_work_item_v6(
  uuid,uuid,uuid,text,text,integer,text,boolean,jsonb,jsonb)
  from public, anon, authenticated;
grant execute on function public.create_delivery_work_item_v6(
  uuid,uuid,uuid,text,text,integer,text,boolean,jsonb,jsonb)
  to service_role;

-- The transition function is the only writer needed by module runtimes. It
-- rejects fields outside the evidence contract and checks the owning module.
create function public.advance_delivery_work_item_v6(
  p_work_item_id uuid,
  p_owner_module text,
  p_next_state text,
  p_evidence jsonb default '{}'::jsonb
) returns public.delivery_work_items_v6
language plpgsql volatile security definer
set search_path = pg_catalog, public
as $$
declare
  w public.delivery_work_items_v6%rowtype;
  v_approval record;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'A trusted module worker is required.' using errcode = '42501';
  end if;
  if p_evidence is null or jsonb_typeof(p_evidence) <> 'object' or exists (
    select 1 from jsonb_object_keys(p_evidence) k where k not in (
      'job_id', 'attempt_count', 'cost_usd', 'qa_state', 'blocker',
      'approval_request_id', 'external_result', 'retry_after',
      'remediation', 'output_refs', 'output_fingerprint'
    )
  ) then
    raise exception 'Unknown or invalid work evidence.';
  end if;
  select * into w from public.delivery_work_items_v6
    where id = p_work_item_id for update;
  if not found then raise exception 'Work item not found.'; end if;
  if w.owner_module is distinct from p_owner_module then
    raise exception 'Only the owning module may advance this work item.';
  end if;

  update public.delivery_work_items_v6 set
    state = p_next_state,
    job_id = case when p_evidence ? 'job_id'
      then nullif(p_evidence->>'job_id','')::uuid else job_id end,
    attempt_count = case when p_evidence ? 'attempt_count'
      then (p_evidence->>'attempt_count')::integer else attempt_count end,
    cost_usd = case when p_evidence ? 'cost_usd'
      then (p_evidence->>'cost_usd')::numeric else cost_usd end,
    qa_state = case when p_evidence ? 'qa_state'
      then p_evidence->>'qa_state' else qa_state end,
    blocker = case when p_evidence ? 'blocker'
      then nullif(p_evidence->>'blocker','') else blocker end,
    approval_request_id = case when p_evidence ? 'approval_request_id'
      then nullif(p_evidence->>'approval_request_id','')::uuid
      else approval_request_id end,
    external_result = case when p_evidence ? 'external_result'
      then p_evidence->'external_result' else external_result end,
    retry_after = case when p_evidence ? 'retry_after'
      then nullif(p_evidence->>'retry_after','')::timestamptz else retry_after end,
    remediation = case when p_evidence ? 'remediation'
      then nullif(p_evidence->>'remediation','') else remediation end,
    output_refs = case when p_evidence ? 'output_refs'
      then p_evidence->'output_refs' else output_refs end,
    output_fingerprint = case when p_evidence ? 'output_fingerprint'
      then nullif(p_evidence->>'output_fingerprint','') else output_fingerprint end
  where id = p_work_item_id returning * into w;

  if p_next_state = 'ready_for_review' and w.qa_state <> 'passed' then
    raise exception 'Internal QA must pass before human review.';
  end if;
  if p_next_state in ('approved','execution_due','attempted','externally_confirmed') then
    select status, artifact_hash into v_approval
    from public.approval_inbox_v6 where id = w.approval_request_id;
    if not found or v_approval.status <> 'approved'
       or v_approval.artifact_hash is distinct from w.output_fingerprint then
      raise exception 'An approved exact-version request is required.';
    end if;
  end if;
  if p_next_state = 'externally_confirmed'
     and nullif(w.external_result->>'external_id','') is null
     and nullif(w.external_result->>'external_url','') is null then
    raise exception 'External confirmation needs a provider ID or URL.';
  end if;
  if p_next_state in ('held','failed')
     and nullif(btrim(coalesce(w.blocker,'')), '') is null then
    raise exception 'Held or failed work needs a blocker.';
  end if;
  return w;
end $$;

revoke all on function public.advance_delivery_work_item_v6(
  uuid,text,text,jsonb) from public, anon, authenticated;
grant execute on function public.advance_delivery_work_item_v6(
  uuid,text,text,jsonb) to service_role;

-- Service workers use the two RPCs above. Revoke table writes so a client or
-- accidental direct runtime query cannot bypass the state/evidence checks.
revoke insert, update, delete on public.delivery_work_items_v6,
  public.delivery_work_events_v6 from service_role;

select public.lock_down_definer_functions();

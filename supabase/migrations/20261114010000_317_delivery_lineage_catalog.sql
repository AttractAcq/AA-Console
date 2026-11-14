-- Phase 1: an evidence catalog across delivery modules. A catalog entry is
-- a fingerprinted observation of a real source row, not a second editable
-- copy of that row. Historical versions remain after a source changes.

create view public.delivery_source_catalog_v6 with (security_invoker = true) as
select 'opportunity'::text as entity_kind, o.id::text as source_key,
  o.client_id, null::uuid as campaign_id,
  encode(sha256(convert_to((to_jsonb(o) - array[
    'updated_at','status','status_note','archived_at'
  ])::text, 'UTF8')), 'hex') as fingerprint
from public.market_opportunities o
union all
select 'source_model', r.id::text, r.client_id, null::uuid,
  encode(sha256(convert_to((to_jsonb(r) - array[
    'updated_at','created_at','job_id'
  ])::text, 'UTF8')), 'hex')
from public.client_agent_records r
union all
select 'offer', o.id::text, o.client_id, null::uuid,
  encode(sha256(convert_to(jsonb_build_object(
    'service_name', o.service_name,
    'latest_version', v.id,
    'latest_hash', v.content_hash
  )::text, 'UTF8')), 'hex')
from public.service_offers o
left join lateral (
  select id, content_hash from public.service_offer_versions v
  where v.offer_id = o.id and v.client_id = o.client_id
  order by v.version desc limit 1
) v on true
union all
select 'offer_version', v.id::text, v.client_id, null::uuid,
  v.content_hash
from public.service_offer_versions v
union all
select 'campaign', c.id::text, c.client_id, c.id,
  encode(sha256(convert_to(public.campaign_plan_fingerprint(c) || ':' ||
    coalesce(c.offer_version_id::text,''), 'UTF8')), 'hex')
from public.client_campaigns c
union all
select 'route_package', p.id::text, p.client_id, p.campaign_id,
  encode(sha256(convert_to(p.plan_fingerprint || ':' || p.route || ':' ||
    coalesce(p.paid_platform,''), 'UTF8')), 'hex')
from public.campaign_route_packages_v6 p
union all
select 'content_asset', a.id::text, a.client_id, null::uuid,
  encode(sha256(convert_to((to_jsonb(a) - array[
    'updated_at','created_at','review_status','archived_at','job_id'
  ])::text, 'UTF8')), 'hex')
from public.client_media_assets a
union all
select 'proof_source', p.id::text, p.client_id, null::uuid,
  encode(sha256(convert_to(jsonb_build_object(
    'source', to_jsonb(p) - array['created_at','updated_at'],
    'usage_rights', p.usage_rights,
    'expires_on', p.expires_on,
    'permission_basis', p.permission_basis
  )::text, 'UTF8')), 'hex')
from public.client_proof_assets p
union all
select 'proof_artifact', v.id::text, v.client_id, null::uuid,
  v.content_hash
from public.proof_artifact_versions v
union all
select 'destination', d.client_id::text || ':' || d.destination_key,
  d.client_id, null::uuid,
  encode(sha256(convert_to(jsonb_build_object(
    'key', d.destination_key, 'enabled', d.enabled,
    'account_ref', d.account_ref
  )::text, 'UTF8')), 'hex')
from public.client_proof_destinations d
union all
select 'page', p.id::text, p.client_id, null::uuid,
  encode(sha256(convert_to((to_jsonb(p) - array[
    'updated_at','created_at','status','published_url','job_id','archived_at'
  ])::text, 'UTF8')), 'hex')
from public.client_pages p
union all
select 'magnet_version', v.id::text, v.client_id, m.campaign_id,
  v.content_sha256
from public.lead_magnet_versions v
join public.lead_magnets m on m.id = v.magnet_id and m.client_id = v.client_id
union all
select 'sales_agent', a.id::text, a.client_id, null::uuid,
  encode(sha256(convert_to((to_jsonb(a) - array[
    'updated_at','created_at','status','archived_at','job_id'
  ])::text, 'UTF8')), 'hex')
from public.client_sales_agents a
union all
select 'approval', r.id::text, r.client_id, null::uuid,
  r.payload_hash
from public.approval_requests_v6 r where r.client_id is not null
union all
select 'distribution_attempt', x.id::text, x.client_id, x.campaign_id,
  encode(sha256(convert_to(jsonb_build_object(
    'approval_id', x.approval_id, 'version', x.artifact_version_hash,
    'action', x.action_key, 'manifest_id', x.manifest_id
  )::text, 'UTF8')), 'hex')
from public.campaign_action_executions x
union all
select 'lead', l.id::text, l.client_id, l.source_client_campaign_id,
  encode(sha256(convert_to(jsonb_build_object(
    'id', l.id, 'source_client_campaign_id', l.source_client_campaign_id,
    'source_post_id', l.source_post_id, 'source_click_id', l.source_click_id,
    'source_utm', l.source_utm, 'consent_given_at', l.consent_given_at
  )::text, 'UTF8')), 'hex')
from public.client_leads l
union all
select 'outcome', e.id::text, e.client_id, l.source_client_campaign_id,
  encode(sha256(convert_to(jsonb_build_object(
    'lead_id', e.lead_id, 'kind', e.kind, 'body', e.body,
    'occurred_at', e.occurred_at
  )::text, 'UTF8')), 'hex')
from public.lead_events e
join public.client_leads l on l.id = e.lead_id and l.client_id = e.client_id
where e.kind = 'outcome';

comment on view public.delivery_source_catalog_v6 is
  'Current source fingerprints for delivery lineage. It stores no lead contact or raw approval preview; version history lives in delivery_entity_versions_v6.';

create table public.delivery_entity_versions_v6 (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  entity_kind text not null check (entity_kind in (
    'opportunity','source_model','offer','offer_version','campaign','route_package',
    'content_asset','proof_source','proof_artifact','destination','page',
    'magnet_version','sales_agent','approval','distribution_attempt',
    'lead','outcome'
  )),
  source_key text not null check (length(btrim(source_key)) between 1 and 300),
  fingerprint text not null check (fingerprint ~ '^[0-9a-f]{64}$'),
  campaign_id uuid,
  observed_at timestamptz not null default now(),
  unique (client_id, entity_kind, source_key, fingerprint),
  unique (id, client_id)
);

create table public.delivery_entity_heads_v6 (
  client_id uuid not null references public.clients(id) on delete cascade,
  entity_kind text not null,
  source_key text not null,
  entity_version_id uuid not null,
  fingerprint text not null check (fingerprint ~ '^[0-9a-f]{64}$'),
  updated_at timestamptz not null default now(),
  primary key (client_id, entity_kind, source_key),
  foreign key (entity_version_id, client_id)
    references public.delivery_entity_versions_v6(id, client_id)
    on delete restrict
);

create function public.guard_delivery_entity_v6()
returns trigger language plpgsql
set search_path = pg_catalog, public as $$
declare v_source record;
begin
  if tg_op = 'UPDATE' or tg_op = 'DELETE' then
    raise exception 'Delivery entity versions are immutable.';
  end if;
  select * into v_source from public.delivery_source_catalog_v6
    where entity_kind = new.entity_kind and source_key = new.source_key
      and client_id = new.client_id;
  if not found or v_source.fingerprint is distinct from new.fingerprint
     or v_source.campaign_id is distinct from new.campaign_id then
    raise exception 'Delivery entity does not match its current source.';
  end if;
  return new;
end $$;
create trigger delivery_entity_versions_v6_guard
  before insert or update or delete on public.delivery_entity_versions_v6
  for each row execute function public.guard_delivery_entity_v6();

-- A source update creates a new immutable observation and moves only the
-- current pointer. Historical links keep naming the exact old version.
create function public.refresh_delivery_entity_v6(
  p_kind text, p_source_key text, p_client_id uuid
) returns uuid
language plpgsql volatile security definer
set search_path = pg_catalog, public
as $$
declare
  s record;
  v_id uuid;
begin
  select * into s from public.delivery_source_catalog_v6
    where entity_kind = p_kind and source_key = p_source_key
      and client_id = p_client_id;
  if not found then raise exception 'Delivery source not found.'; end if;
  insert into public.delivery_entity_versions_v6 (
    client_id, entity_kind, source_key, fingerprint, campaign_id
  ) values (s.client_id, s.entity_kind, s.source_key,
    s.fingerprint, s.campaign_id)
  on conflict (client_id, entity_kind, source_key, fingerprint) do nothing;
  select id into v_id from public.delivery_entity_versions_v6
    where client_id = s.client_id and entity_kind = s.entity_kind
      and source_key = s.source_key and fingerprint = s.fingerprint;
  insert into public.delivery_entity_heads_v6 (
    client_id, entity_kind, source_key, entity_version_id, fingerprint
  ) values (s.client_id, s.entity_kind, s.source_key, v_id, s.fingerprint)
  on conflict (client_id, entity_kind, source_key) do update
    set entity_version_id = excluded.entity_version_id,
        fingerprint = excluded.fingerprint, updated_at = now()
  where public.delivery_entity_heads_v6.entity_version_id
    is distinct from excluded.entity_version_id;
  return v_id;
end $$;

revoke all on function public.refresh_delivery_entity_v6(text,text,uuid)
  from public, anon, authenticated;
grant execute on function public.refresh_delivery_entity_v6(text,text,uuid)
  to service_role;

-- Register all existing records without assigning them a stronger workflow
-- state. This does not mutate a source row, including legacy campaigns.
insert into public.delivery_entity_versions_v6 (
  client_id, entity_kind, source_key, fingerprint, campaign_id
)
select client_id, entity_kind, source_key, fingerprint, campaign_id
from public.delivery_source_catalog_v6;

insert into public.delivery_entity_heads_v6 (
  client_id, entity_kind, source_key, entity_version_id, fingerprint
)
select client_id, entity_kind, source_key, id, fingerprint
from public.delivery_entity_versions_v6;

-- Freshness hooks cover every mutable source that matters to a decision.
-- Immutable version tables need INSERT hooks because a replacement is a new
-- ID, and existing approvals remain tied to the old source version.
create function public.refresh_delivery_entity_trigger_v6()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare
  v_row jsonb := to_jsonb(new);
  v_key text;
begin
  if tg_argv[0] = 'destination' then
    v_key := (v_row->>'client_id') || ':' || (v_row->>'destination_key');
  else
    v_key := v_row->>'id';
  end if;
  perform public.refresh_delivery_entity_v6(
    tg_argv[0], v_key, (v_row->>'client_id')::uuid);
  if tg_argv[0] = 'offer_version' then
    perform public.refresh_delivery_entity_v6(
      'offer', v_row->>'offer_id', (v_row->>'client_id')::uuid);
  end if;
  return new;
end $$;

create trigger delivery_opportunity_version_v6
  after insert or update on public.market_opportunities
  for each row execute function public.refresh_delivery_entity_trigger_v6('opportunity');
create trigger delivery_source_model_version_v6
  after insert or update on public.client_agent_records
  for each row execute function public.refresh_delivery_entity_trigger_v6('source_model');
create trigger delivery_offer_version_v6
  after insert on public.service_offer_versions
  for each row execute function public.refresh_delivery_entity_trigger_v6('offer_version');
create trigger delivery_offer_head_v6
  after insert or update on public.service_offers
  for each row execute function public.refresh_delivery_entity_trigger_v6('offer');
create trigger delivery_campaign_version_v6
  after insert or update on public.client_campaigns
  for each row execute function public.refresh_delivery_entity_trigger_v6('campaign');
create trigger delivery_route_package_version_v6
  after insert on public.campaign_route_packages_v6
  for each row execute function public.refresh_delivery_entity_trigger_v6('route_package');
create trigger delivery_content_version_v6
  after insert or update on public.client_media_assets
  for each row execute function public.refresh_delivery_entity_trigger_v6('content_asset');
create trigger delivery_proof_source_version_v6
  after insert or update on public.client_proof_assets
  for each row execute function public.refresh_delivery_entity_trigger_v6('proof_source');
create trigger delivery_proof_artifact_version_v6
  after insert on public.proof_artifact_versions
  for each row execute function public.refresh_delivery_entity_trigger_v6('proof_artifact');
create trigger delivery_destination_version_v6
  after insert or update on public.client_proof_destinations
  for each row execute function public.refresh_delivery_entity_trigger_v6('destination');
create trigger delivery_page_version_v6
  after insert or update on public.client_pages
  for each row execute function public.refresh_delivery_entity_trigger_v6('page');
create trigger delivery_magnet_version_v6
  after insert on public.lead_magnet_versions
  for each row execute function public.refresh_delivery_entity_trigger_v6('magnet_version');
create trigger delivery_sales_agent_version_v6
  after insert or update on public.client_sales_agents
  for each row execute function public.refresh_delivery_entity_trigger_v6('sales_agent');
create trigger delivery_approval_version_v6
  after insert on public.approval_requests_v6
  for each row execute function public.refresh_delivery_entity_trigger_v6('approval');
create trigger delivery_distribution_attempt_version_v6
  after insert or update on public.campaign_action_executions
  for each row execute function public.refresh_delivery_entity_trigger_v6('distribution_attempt');
create trigger delivery_lead_version_v6
  after insert or update on public.client_leads
  for each row execute function public.refresh_delivery_entity_trigger_v6('lead');
create trigger delivery_outcome_version_v6
  after insert on public.lead_events
  for each row when (new.kind = 'outcome')
  execute function public.refresh_delivery_entity_trigger_v6('outcome');

alter table public.delivery_entity_versions_v6 enable row level security;
alter table public.delivery_entity_heads_v6 enable row level security;
create policy delivery_entity_versions_v6_read on public.delivery_entity_versions_v6
  for select to authenticated using (public.can_access_client(client_id));
create policy delivery_entity_heads_v6_read on public.delivery_entity_heads_v6
  for select to authenticated using (public.can_access_client(client_id));
revoke all on public.delivery_entity_versions_v6, public.delivery_entity_heads_v6
  from public, anon, authenticated;
grant select on public.delivery_entity_versions_v6, public.delivery_entity_heads_v6
  to authenticated;
grant all on public.delivery_entity_versions_v6, public.delivery_entity_heads_v6
  to service_role;
revoke all on public.delivery_source_catalog_v6 from public, anon, authenticated;
grant select on public.delivery_source_catalog_v6 to service_role;

select public.lock_down_definer_functions();

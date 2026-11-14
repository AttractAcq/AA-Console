-- Phase 1: relational lineage. The two endpoints share client_id through
-- composite FKs, so an arbitrary UUID cannot link another client's record.

create table public.delivery_lineage_links_v6 (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  source_version_id uuid not null,
  derived_version_id uuid not null,
  relationship text not null check (relationship in (
    'informed', 'selected_offer', 'route_of', 'produced',
    'derived_proof', 'captured', 'recorded_outcome',
    'approved_action', 'used_destination'
  )),
  created_at timestamptz not null default now(),
  foreign key (source_version_id, client_id)
    references public.delivery_entity_versions_v6(id, client_id) on delete restrict,
  foreign key (derived_version_id, client_id)
    references public.delivery_entity_versions_v6(id, client_id) on delete restrict,
  check (source_version_id <> derived_version_id),
  unique (source_version_id, derived_version_id, relationship)
);
create index delivery_lineage_links_v6_derived
  on public.delivery_lineage_links_v6 (derived_version_id, relationship);

create function public.reject_delivery_lineage_mutation_v6()
returns trigger language plpgsql
set search_path = pg_catalog, public as $$
begin
  raise exception 'Lineage links are append-only. Add a new version and link.';
end $$;
create trigger delivery_lineage_links_v6_append_only
  before update or delete on public.delivery_lineage_links_v6
  for each row execute function public.reject_delivery_lineage_mutation_v6();

-- A work item has typed, relational outputs. output_refs on the work item is
-- display metadata only; readiness must inspect these links and the source.
create table public.delivery_work_outputs_v6 (
  work_item_id uuid not null references public.delivery_work_items_v6(id)
    on delete cascade,
  entity_version_id uuid not null,
  client_id uuid not null references public.clients(id) on delete cascade,
  linked_at timestamptz not null default now(),
  primary key (work_item_id, entity_version_id),
  foreign key (entity_version_id, client_id)
    references public.delivery_entity_versions_v6(id, client_id) on delete restrict
);

create function public.guard_delivery_work_output_v6()
returns trigger language plpgsql
set search_path = pg_catalog, public as $$
declare w public.delivery_work_items_v6%rowtype;
begin
  if tg_op <> 'INSERT' then
    raise exception 'Work output links are immutable.';
  end if;
  select * into w from public.delivery_work_items_v6
    where id = new.work_item_id;
  if not found or w.client_id <> new.client_id then
    raise exception 'Work output and work item must belong to one client.';
  end if;
  return new;
end $$;
create trigger delivery_work_outputs_v6_guard
  before insert or update or delete on public.delivery_work_outputs_v6
  for each row execute function public.guard_delivery_work_output_v6();

create function public.delivery_work_output_hash_v6(p_work_item_id uuid)
returns text language sql stable
set search_path = pg_catalog, public as $$
  select encode(sha256(convert_to(
    string_agg(e.id::text || ':' || e.fingerprint, '|' order by e.id),
    'UTF8')), 'hex')
  from public.delivery_work_outputs_v6 o
  join public.delivery_entity_versions_v6 e on e.id = o.entity_version_id
  where o.work_item_id = p_work_item_id;
$$;

create function public.guard_delivery_work_output_hash_v6()
returns trigger language plpgsql
set search_path = pg_catalog, public as $$
begin
  if new.state in ('ready_for_review','approved','execution_due',
      'attempted','externally_confirmed') and
     new.output_fingerprint is distinct from
       public.delivery_work_output_hash_v6(new.id) then
    raise exception 'Reviewable work must fingerprint its relational output versions.';
  end if;
  return new;
end $$;
create trigger delivery_work_items_v6_output_hash
  before update on public.delivery_work_items_v6
  for each row execute function public.guard_delivery_work_output_hash_v6();

create function public.link_delivery_work_output_v6(
  p_work_item_id uuid, p_owner_module text, p_entity_version_id uuid
) returns void
language plpgsql volatile security definer
set search_path = pg_catalog, public
as $$
declare
  w public.delivery_work_items_v6%rowtype;
  e public.delivery_entity_versions_v6%rowtype;
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
    raise exception 'Output, client and owning module must match.';
  end if;
  if e.campaign_id is not null and e.campaign_id <> w.campaign_id then
    raise exception 'Output belongs to a different campaign.';
  end if;
  if w.state in ('approved','execution_due','attempted',
    'externally_confirmed','revoked','archived') then
    raise exception 'An approved or terminal work item cannot gain new output bytes.';
  end if;
  insert into public.delivery_work_outputs_v6 (
    work_item_id, entity_version_id, client_id
  ) values (w.id, e.id, w.client_id)
  on conflict do nothing;
end $$;

revoke all on function public.link_delivery_work_output_v6(uuid,text,uuid)
  from public, anon, authenticated;
grant execute on function public.link_delivery_work_output_v6(uuid,text,uuid)
  to service_role;
revoke all on function public.delivery_work_output_hash_v6(uuid)
  from public, anon, authenticated;
grant execute on function public.delivery_work_output_hash_v6(uuid)
  to service_role;

-- Existing relations become historical edges. Every join uses both the ID
-- and client, including relations whose original FK was ID-only.
insert into public.delivery_lineage_links_v6 (
  client_id, source_version_id, derived_version_id, relationship
)
select o.client_id, o.entity_version_id, c.entity_version_id, 'informed'
from public.opportunity_links l
join public.delivery_entity_heads_v6 o on o.client_id = l.client_id
  and o.entity_kind = 'opportunity' and o.source_key = l.opportunity_id::text
join public.delivery_entity_heads_v6 c on c.client_id = l.client_id
  and c.entity_kind = 'campaign' and c.source_key = l.campaign_id::text
where l.role = 'campaign'
on conflict do nothing;

insert into public.delivery_lineage_links_v6 (
  client_id, source_version_id, derived_version_id, relationship
)
select c.client_id, o.entity_version_id, ch.entity_version_id, 'selected_offer'
from public.client_campaigns c
join public.delivery_entity_heads_v6 o on o.client_id = c.client_id
  and o.entity_kind = 'offer_version'
  and o.source_key = c.offer_version_id::text
join public.delivery_entity_heads_v6 ch on ch.client_id = c.client_id
  and ch.entity_kind = 'campaign' and ch.source_key = c.id::text
where c.offer_version_id is not null
on conflict do nothing;

insert into public.delivery_lineage_links_v6 (
  client_id, source_version_id, derived_version_id, relationship
)
select p.client_id, c.entity_version_id, r.entity_version_id, 'route_of'
from public.campaign_route_packages_v6 p
join public.delivery_entity_heads_v6 c on c.client_id = p.client_id
  and c.entity_kind = 'campaign' and c.source_key = p.campaign_id::text
join public.delivery_entity_heads_v6 r on r.client_id = p.client_id
  and r.entity_kind = 'route_package' and r.source_key = p.id::text
on conflict do nothing;

insert into public.delivery_lineage_links_v6 (
  client_id, source_version_id, derived_version_id, relationship
)
select a.client_id, c.entity_version_id, e.entity_version_id, 'produced'
from public.campaign_artifacts a
join public.delivery_entity_heads_v6 c on c.client_id = a.client_id
  and c.entity_kind = 'campaign' and c.source_key = a.campaign_id::text
join public.delivery_entity_heads_v6 e on e.client_id = a.client_id
  and e.entity_kind = case
    when a.asset_id is not null then 'content_asset'
    when a.page_id is not null then 'page'
    when a.sales_agent_id is not null then 'sales_agent'
    else '__none__' end
  and e.source_key = coalesce(a.asset_id, a.page_id, a.sales_agent_id)::text
where num_nonnulls(a.asset_id, a.page_id, a.sales_agent_id) = 1
on conflict do nothing;

insert into public.delivery_lineage_links_v6 (
  client_id, source_version_id, derived_version_id, relationship
)
select v.client_id, p.entity_version_id, a.entity_version_id, 'derived_proof'
from public.proof_artifact_versions v
join public.delivery_entity_heads_v6 p on p.client_id = v.client_id
  and p.entity_kind = 'proof_source' and p.source_key = v.source_proof_id::text
join public.delivery_entity_heads_v6 a on a.client_id = v.client_id
  and a.entity_kind = 'proof_artifact' and a.source_key = v.id::text
on conflict do nothing;

insert into public.delivery_lineage_links_v6 (
  client_id, source_version_id, derived_version_id, relationship
)
select m.client_id, c.entity_version_id, v.entity_version_id, 'produced'
from public.lead_magnets m
join public.lead_magnet_versions mv on mv.magnet_id = m.id
  and mv.client_id = m.client_id
join public.delivery_entity_heads_v6 c on c.client_id = m.client_id
  and c.entity_kind = 'campaign' and c.source_key = m.campaign_id::text
join public.delivery_entity_heads_v6 v on v.client_id = m.client_id
  and v.entity_kind = 'magnet_version' and v.source_key = mv.id::text
where m.campaign_id is not null
on conflict do nothing;

insert into public.delivery_lineage_links_v6 (
  client_id, source_version_id, derived_version_id, relationship
)
select x.client_id, c.entity_version_id, a.entity_version_id, 'produced'
from public.campaign_action_executions x
join public.delivery_entity_heads_v6 c on c.client_id = x.client_id
  and c.entity_kind = 'campaign' and c.source_key = x.campaign_id::text
join public.delivery_entity_heads_v6 a on a.client_id = x.client_id
  and a.entity_kind = 'distribution_attempt' and a.source_key = x.id::text
on conflict do nothing;

insert into public.delivery_lineage_links_v6 (
  client_id, source_version_id, derived_version_id, relationship
)
select l.client_id, c.entity_version_id, h.entity_version_id, 'captured'
from public.client_leads l
join public.delivery_entity_heads_v6 c on c.client_id = l.client_id
  and c.entity_kind = 'campaign'
  and c.source_key = l.source_client_campaign_id::text
join public.delivery_entity_heads_v6 h on h.client_id = l.client_id
  and h.entity_kind = 'lead' and h.source_key = l.id::text
where l.source_client_campaign_id is not null
on conflict do nothing;

insert into public.delivery_lineage_links_v6 (
  client_id, source_version_id, derived_version_id, relationship
)
select e.client_id, l.entity_version_id, o.entity_version_id, 'recorded_outcome'
from public.lead_events e
join public.delivery_entity_heads_v6 l on l.client_id = e.client_id
  and l.entity_kind = 'lead' and l.source_key = e.lead_id::text
join public.delivery_entity_heads_v6 o on o.client_id = e.client_id
  and o.entity_kind = 'outcome' and o.source_key = e.id::text
where e.kind = 'outcome'
on conflict do nothing;

alter table public.delivery_lineage_links_v6 enable row level security;
alter table public.delivery_work_outputs_v6 enable row level security;
create policy delivery_lineage_links_v6_read on public.delivery_lineage_links_v6
  for select to authenticated using (public.can_access_client(client_id));
create policy delivery_work_outputs_v6_read on public.delivery_work_outputs_v6
  for select to authenticated using (public.can_access_client(client_id));
revoke all on public.delivery_lineage_links_v6, public.delivery_work_outputs_v6
  from public, anon, authenticated;
grant select on public.delivery_lineage_links_v6, public.delivery_work_outputs_v6
  to authenticated;
grant all on public.delivery_lineage_links_v6, public.delivery_work_outputs_v6
  to service_role;
revoke insert, update, delete on public.delivery_work_outputs_v6 from service_role;

select public.lock_down_definer_functions();

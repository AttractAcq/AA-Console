-- Keep new source records linked after the one-time backfill, and prevent a
-- stale input or output from being advanced through the delivery gate.

create function public.link_delivery_current_source_v6(
  p_derived public.delivery_entity_versions_v6,
  p_source_kind text, p_source_key text, p_relationship text
) returns void language plpgsql security definer
set search_path = pg_catalog, public as $$
begin
  insert into public.delivery_lineage_links_v6 (
    client_id, source_version_id, derived_version_id, relationship
  )
  select p_derived.client_id, h.entity_version_id, p_derived.id, p_relationship
  from public.delivery_entity_heads_v6 h
  where h.client_id = p_derived.client_id
    and h.entity_kind = p_source_kind and h.source_key = p_source_key
    and h.entity_version_id <> p_derived.id
  on conflict do nothing;
end $$;

create function public.link_delivery_source_on_version_v6()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public as $$
declare
  r record;
  v_request_id uuid;
begin
  if new.entity_kind = 'campaign' then
    for r in select l.opportunity_id from public.opportunity_links l
      where l.campaign_id = new.source_key::uuid
        and l.client_id = new.client_id and l.role = 'campaign' loop
      perform public.link_delivery_current_source_v6(
        new, 'opportunity', r.opportunity_id::text, 'informed');
    end loop;
    select c.offer_version_id as source_id into r
      from public.client_campaigns c where c.id = new.source_key::uuid
        and c.client_id = new.client_id;
    if r.source_id is not null then
      perform public.link_delivery_current_source_v6(
        new, 'offer_version', r.source_id::text, 'selected_offer');
    end if;
  elsif new.entity_kind = 'route_package' then
    select p.campaign_id as source_id into r
      from public.campaign_route_packages_v6 p
      where p.id = new.source_key::uuid and p.client_id = new.client_id;
    if r.source_id is not null then
      perform public.link_delivery_current_source_v6(
        new, 'campaign', r.source_id::text, 'route_of');
    end if;
  elsif new.entity_kind in ('content_asset','page','sales_agent') then
    for r in select a.campaign_id from public.campaign_artifacts a
      where a.client_id = new.client_id and
        ((new.entity_kind = 'content_asset' and a.asset_id::text = new.source_key)
        or (new.entity_kind = 'page' and a.page_id::text = new.source_key)
        or (new.entity_kind = 'sales_agent' and a.sales_agent_id::text = new.source_key)) loop
      perform public.link_delivery_current_source_v6(
        new, 'campaign', r.campaign_id::text, 'produced');
    end loop;
  elsif new.entity_kind = 'proof_artifact' then
    select v.source_proof_id as source_id into r
      from public.proof_artifact_versions v
      where v.id = new.source_key::uuid and v.client_id = new.client_id;
    if r.source_id is not null then
      perform public.link_delivery_current_source_v6(
        new, 'proof_source', r.source_id::text, 'derived_proof');
    end if;
  elsif new.entity_kind = 'magnet_version' then
    select m.campaign_id as source_id into r
      from public.lead_magnet_versions v
      join public.lead_magnets m on m.id = v.magnet_id
        and m.client_id = v.client_id
      where v.id = new.source_key::uuid and v.client_id = new.client_id;
    if r.source_id is not null then
      perform public.link_delivery_current_source_v6(
        new, 'campaign', r.source_id::text, 'produced');
    end if;
  elsif new.entity_kind = 'distribution_attempt' then
    select x.campaign_id as source_id, x.approval_id into r
      from public.campaign_action_executions x
      where x.id = new.source_key::uuid and x.client_id = new.client_id;
    if r.source_id is not null then
      perform public.link_delivery_current_source_v6(
        new, 'campaign', r.source_id::text, 'produced');
    end if;
    if r.approval_id is not null then
      select ar.id into v_request_id from public.approval_requests_v6 ar
        where ar.client_id = new.client_id and ar.source_kind = 'campaign_action'
          and ar.source_id = r.approval_id::text;
      if v_request_id is not null then
        perform public.link_delivery_current_source_v6(
          new, 'approval', v_request_id::text, 'approved_action');
      end if;
    end if;
  elsif new.entity_kind = 'approval' then
    select a.campaign_id as source_id into r
      from public.approval_requests_v6 ar
      join public.campaign_action_approvals a on a.id::text = ar.source_id
        and a.client_id = ar.client_id
      where ar.id = new.source_key::uuid and ar.client_id = new.client_id
        and ar.source_kind = 'campaign_action';
    if r.source_id is not null then
      perform public.link_delivery_current_source_v6(
        new, 'campaign', r.source_id::text, 'approved_action');
    end if;
  elsif new.entity_kind = 'lead' then
    select l.source_client_campaign_id as source_id into r
      from public.client_leads l
      where l.id = new.source_key::uuid and l.client_id = new.client_id;
    if r.source_id is not null then
      perform public.link_delivery_current_source_v6(
        new, 'campaign', r.source_id::text, 'captured');
    end if;
  elsif new.entity_kind = 'outcome' then
    select e.lead_id as source_id into r from public.lead_events e
      where e.id = new.source_key::uuid and e.client_id = new.client_id;
    if r.source_id is not null then
      perform public.link_delivery_current_source_v6(
        new, 'lead', r.source_id::text, 'recorded_outcome');
    end if;
  end if;
  return null;
end $$;
create trigger delivery_entity_live_lineage_v6
  after insert on public.delivery_entity_versions_v6
  for each row execute function public.link_delivery_source_on_version_v6();

insert into public.delivery_lineage_links_v6 (
  client_id, source_version_id, derived_version_id, relationship
)
select ar.client_id, c.entity_version_id, h.entity_version_id, 'approved_action'
from public.approval_requests_v6 ar
join public.campaign_action_approvals a on a.id::text = ar.source_id
  and a.client_id = ar.client_id
join public.delivery_entity_heads_v6 c on c.client_id = ar.client_id
  and c.entity_kind = 'campaign' and c.source_key = a.campaign_id::text
join public.delivery_entity_heads_v6 h on h.client_id = ar.client_id
  and h.entity_kind = 'approval' and h.source_key = ar.id::text
where ar.source_kind = 'campaign_action'
on conflict do nothing;

insert into public.delivery_lineage_links_v6 (
  client_id, source_version_id, derived_version_id, relationship
)
select x.client_id, a.entity_version_id, h.entity_version_id, 'approved_action'
from public.campaign_action_executions x
join public.approval_requests_v6 ar on ar.source_kind = 'campaign_action'
  and ar.source_id = x.approval_id::text and ar.client_id = x.client_id
join public.delivery_entity_heads_v6 a on a.client_id = x.client_id
  and a.entity_kind = 'approval' and a.source_key = ar.id::text
join public.delivery_entity_heads_v6 h on h.client_id = x.client_id
  and h.entity_kind = 'distribution_attempt' and h.source_key = x.id::text
on conflict do nothing;

-- Some relationships are recorded after both endpoint records already exist.
create function public.link_delivery_relationship_v6()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public as $$
declare
  v_derived public.delivery_entity_versions_v6%rowtype;
  v_kind text;
  v_key text;
begin
  if tg_table_name = 'opportunity_links' then
    if new.role <> 'campaign' then return null; end if;
    v_kind := 'campaign'; v_key := new.campaign_id::text;
  elsif tg_table_name = 'campaign_artifacts' then
    v_kind := case when new.asset_id is not null then 'content_asset'
      when new.page_id is not null then 'page'
      when new.sales_agent_id is not null then 'sales_agent' end;
    v_key := coalesce(new.asset_id, new.page_id, new.sales_agent_id)::text;
  else
    return null;
  end if;
  select e.* into v_derived
  from public.delivery_entity_heads_v6 h
  join public.delivery_entity_versions_v6 e on e.id = h.entity_version_id
  where h.client_id = new.client_id and h.entity_kind = v_kind
    and h.source_key = v_key;
  if v_derived.id is null then return null; end if;
  if tg_table_name = 'opportunity_links' then
    perform public.link_delivery_current_source_v6(
      v_derived, 'opportunity', new.opportunity_id::text, 'informed');
  else
    perform public.link_delivery_current_source_v6(
      v_derived, 'campaign', new.campaign_id::text, 'produced');
  end if;
  return null;
end $$;
create trigger delivery_opportunity_link_v6
  after insert on public.opportunity_links
  for each row execute function public.link_delivery_relationship_v6();
create trigger delivery_campaign_artifact_link_v6
  after insert on public.campaign_artifacts
  for each row execute function public.link_delivery_relationship_v6();

-- Work cannot become or remain actionable if any bound input or output has
-- been replaced. A new work version is required to use the replacement.
create function public.guard_stale_delivery_work_v6()
returns trigger language plpgsql
set search_path = pg_catalog, public as $$
begin
  if new.state in ('prepared','ready_for_review','approved','execution_due',
      'attempted','externally_confirmed') and exists (
    select 1 from public.delivery_work_inputs_v6 i
    join public.delivery_entity_versions_v6 e on e.id = i.entity_version_id
    left join public.delivery_entity_heads_v6 h
      on h.client_id = e.client_id and h.entity_kind = e.entity_kind
        and h.source_key = e.source_key
    where i.work_item_id = new.id
      and h.entity_version_id is distinct from e.id
    union all
    select 1 from public.delivery_work_outputs_v6 o
    join public.delivery_entity_versions_v6 e on e.id = o.entity_version_id
    left join public.delivery_entity_heads_v6 h
      on h.client_id = e.client_id and h.entity_kind = e.entity_kind
        and h.source_key = e.source_key
    where o.work_item_id = new.id
      and h.entity_version_id is distinct from e.id
  ) then
    raise exception 'A work input or output changed; create a new work version.';
  end if;
  return new;
end $$;
create trigger delivery_work_items_v6_staleness
  before update on public.delivery_work_items_v6
  for each row execute function public.guard_stale_delivery_work_v6();

alter table public.delivery_remediation_tasks_v6
  drop constraint delivery_remediation_tasks_v6_invalidation_id_key;
create unique index delivery_remediation_external_use_v6
  on public.delivery_remediation_tasks_v6 (
    invalidation_id, external_use_kind, external_use_id);

create function public.remediate_delivery_completed_work_v6()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public as $$
begin
  insert into public.delivery_remediation_tasks_v6 (
    client_id, approval_request_id, invalidation_id,
    external_use_kind, external_use_id, reason
  )
  select new.client_id, new.approval_request_id, new.id,
    'delivery_work_item', w.id,
    'Source changed after a confirmed external delivery; inspect or retract it.'
  from public.delivery_work_items_v6 w
  where w.client_id = new.client_id
    and w.approval_request_id = new.approval_request_id
    and w.state = 'externally_confirmed'
  on conflict do nothing;
  return null;
end $$;
create trigger delivery_invalidation_completed_work_v6
  after insert on public.delivery_approval_invalidations_v6
  for each row execute function public.remediate_delivery_completed_work_v6();

select public.lock_down_definer_functions();

-- Lead/outcome source keys, fingerprints and existing lineage links survive
-- archive and recovery. This remains a rollback-only fixture; it does not
-- release cash-positive archiving in the application RPC.
begin;
insert into public.clients(id,name,initials)
values ('b6350000-0000-4000-8000-000000000001','Lineage Archive fixture','LA');
select set_config('request.jwt.claim.role','service_role',true);
select set_config('request.jwt.claims','{"role":"service_role"}',true);
insert into public.client_campaigns(id,client_id,name,brief)
values ('d6350000-0000-4000-8000-000000000001',
  'b6350000-0000-4000-8000-000000000001','Lineage campaign','Fixture');
insert into public.client_leads
 (id,client_id,name,stage,source_client_campaign_id,cash_collected,
  cash_currency,consent_given_at,consent_wording)
values ('c6350000-0000-4000-8000-000000000001',
  'b6350000-0000-4000-8000-000000000001','Recorded','cash',
  'd6350000-0000-4000-8000-000000000001',25,'USD',now(),'Fixture consent');
insert into public.lead_events(id,lead_id,client_id,kind,body,to_stage)
values ('e6350000-0000-4000-8000-000000000001',
  'c6350000-0000-4000-8000-000000000001',
  'b6350000-0000-4000-8000-000000000001','outcome',
  'Recorded fixture outcome','cash');
create temporary table lineage_expected on commit drop as
select c.entity_kind,c.source_key,c.client_id,c.campaign_id,c.fingerprint,
  h.entity_version_id
from public.delivery_source_catalog_v6 c
join public.delivery_entity_heads_v6 h
  on h.client_id=c.client_id and h.entity_kind=c.entity_kind
    and h.source_key=c.source_key and h.fingerprint=c.fingerprint
where c.client_id='b6350000-0000-4000-8000-000000000001'
  and c.entity_kind in ('lead','outcome');
do $initial$
begin
  if (select count(*) from lineage_expected)<>2 then
    raise exception 'Initial source/head lineage is missing'; end if;
  if (select count(*) from public.delivery_lineage_links_v6 l
      join lineage_expected s on s.entity_version_id=l.source_version_id
      join lineage_expected o on o.entity_version_id=l.derived_version_id
      where s.entity_kind='lead' and o.entity_kind='outcome'
        and l.relationship='recorded_outcome')<>1 then
    raise exception 'Initial lead to outcome link is missing'; end if;
end $initial$;
insert into public.archived_leads(id,client_id,name,stage_at_archive,lead,events,reason)
select l.id,l.client_id,l.name,l.stage,to_jsonb(l),
  (select coalesce(jsonb_agg(to_jsonb(e) order by e.occurred_at,e.id),'[]'::jsonb)
   from public.lead_events e where e.lead_id=l.id),
  'fixture'
from public.client_leads l
where l.id='c6350000-0000-4000-8000-000000000001';
do $overlap$
begin
  if (select count(*) from public.delivery_source_catalog_v6
      where client_id='b6350000-0000-4000-8000-000000000001'
        and entity_kind in ('lead','outcome'))<>2 then
    raise exception 'Active/archive overlap duplicated source nodes'; end if;
end $overlap$;
delete from public.client_leads
where id='c6350000-0000-4000-8000-000000000001';
do $archived$
begin
  if exists (
    (select entity_kind,source_key,client_id,campaign_id,fingerprint
     from lineage_expected
     except
     select entity_kind,source_key,client_id,campaign_id,fingerprint
     from public.delivery_source_catalog_v6
     where client_id='b6350000-0000-4000-8000-000000000001'
       and entity_kind in ('lead','outcome'))
    union all
    (select entity_kind,source_key,client_id,campaign_id,fingerprint
     from public.delivery_source_catalog_v6
     where client_id='b6350000-0000-4000-8000-000000000001'
       and entity_kind in ('lead','outcome')
     except
     select entity_kind,source_key,client_id,campaign_id,fingerprint
     from lineage_expected)
  ) then raise exception 'Archived source fingerprint or campaign changed'; end if;
  if (select count(*) from public.delivery_source_catalog_v6
      where client_id='b6350000-0000-4000-8000-000000000001'
        and entity_kind in ('lead','outcome'))<>2 then
    raise exception 'Archived source count changed'; end if;
  if (select count(*) from public.delivery_lineage_links_v6 l
      join lineage_expected s on s.entity_version_id=l.source_version_id
      join lineage_expected o on o.entity_version_id=l.derived_version_id
      where s.entity_kind='lead' and o.entity_kind='outcome'
        and l.relationship='recorded_outcome')<>1 then
    raise exception 'Archived lineage link vanished'; end if;
  if (select count(*) from public.client_leads
      where id='c6350000-0000-4000-8000-000000000001')<>0 then
    raise exception 'Archived lead remained operational'; end if;
end $archived$;
select public.recover_lead('c6350000-0000-4000-8000-000000000001');
do $restored$
begin
  if exists (
    select 1 from lineage_expected e
    left join public.delivery_source_catalog_v6 c
      on c.client_id=e.client_id and c.entity_kind=e.entity_kind
        and c.source_key=e.source_key
    where c.fingerprint is distinct from e.fingerprint
      or c.campaign_id is distinct from e.campaign_id
  ) then raise exception 'Recovered source fingerprint changed'; end if;
  if (select count(*) from public.delivery_source_catalog_v6
      where client_id='b6350000-0000-4000-8000-000000000001'
        and entity_kind in ('lead','outcome'))<>2 then
    raise exception 'Recovered source count changed'; end if;
end $restored$;
rollback;

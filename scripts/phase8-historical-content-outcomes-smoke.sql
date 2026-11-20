-- Disposable content attribution consistency fixture. The view keeps its
-- security-invoker setting while finished lead snapshots remain countable.
begin;
insert into public.clients(id,name,initials)
values ('b6280000-0000-4000-8000-000000000001','Historical content fixture','HC');
select set_config('request.jwt.claim.role','service_role',true);
select set_config('request.jwt.claims','{"role":"service_role"}',true);
insert into public.client_media_assets
  (id,client_id,media_type,title,storage_path)
values ('a6280000-0000-4000-8000-000000000001',
  'b6280000-0000-4000-8000-000000000001','image',
  'Fixture asset','fixture/content-outcomes.png');
insert into public.client_leads
  (id,client_id,name,stage,source_asset_id,source_channel,
   sale_value,sale_currency,cash_collected,cash_currency,lost_reason)
values
 ('c6280000-0000-4000-8000-000000000001',
  'b6280000-0000-4000-8000-000000000001','Cash lead','cash',
  'a6280000-0000-4000-8000-000000000001','organic',100,'USD',75,'USD',null),
 ('c6280000-0000-4000-8000-000000000002',
  'b6280000-0000-4000-8000-000000000001','Lost after sale','lost',
  'a6280000-0000-4000-8000-000000000001','organic',
  null,null,null,null,'No longer buying');
insert into public.lead_events(lead_id,client_id,kind,to_stage)
values ('c6280000-0000-4000-8000-000000000002',
  'b6280000-0000-4000-8000-000000000001','stage_change','sale');
create temporary table historical_content_expected on commit drop as
select
  (select to_jsonb(c) from public.content_attribution c
   where c.asset_id='a6280000-0000-4000-8000-000000000001') as view_row,
  (select to_jsonb(t) from public.top_content_by_revenue(
   'b6280000-0000-4000-8000-000000000001',10) t) as top_row;
insert into public.archived_leads(id,client_id,name,stage_at_archive,lead,events,reason)
select l.id,l.client_id,l.name,l.stage,to_jsonb(l),
  coalesce((select jsonb_agg(to_jsonb(e) order by e.occurred_at,e.id)
    from public.lead_events e where e.lead_id=l.id),'[]'::jsonb),'fixture'
from public.client_leads l
where l.client_id='b6280000-0000-4000-8000-000000000001';
delete from public.client_leads
where client_id='b6280000-0000-4000-8000-000000000001';
do $archived$
declare expected record; view_row jsonb; top_row jsonb;
begin
  select * into expected from historical_content_expected;
  select to_jsonb(c) into view_row from public.content_attribution c
  where c.asset_id='a6280000-0000-4000-8000-000000000001';
  select to_jsonb(t) into top_row from public.top_content_by_revenue(
    'b6280000-0000-4000-8000-000000000001',10) t;
  if expected.view_row is distinct from view_row
     or expected.top_row is distinct from top_row then
    raise exception 'Content attribution changed after archive'; end if;
  if (view_row->>'leads')::integer<>2
     or (view_row->>'sales')::integer<>2
     or (view_row->>'cash_collected')::numeric<>75 then
    raise exception 'Archived content contribution was lost'; end if;
  if has_function_privilege('anon',
      'public.content_asset_outcomes_v10(uuid,uuid)','EXECUTE') then
    raise exception 'Anonymous content outcome execution was exposed'; end if;
end $archived$;
select public.recover_lead('c6280000-0000-4000-8000-000000000001');
select public.recover_lead('c6280000-0000-4000-8000-000000000002');
do $restored$
declare expected record; view_row jsonb; top_row jsonb;
begin
  select * into expected from historical_content_expected;
  select to_jsonb(c) into view_row from public.content_attribution c
  where c.asset_id='a6280000-0000-4000-8000-000000000001';
  select to_jsonb(t) into top_row from public.top_content_by_revenue(
    'b6280000-0000-4000-8000-000000000001',10) t;
  if expected.view_row is distinct from view_row
     or expected.top_row is distinct from top_row then
    raise exception 'Content attribution changed after recovery'; end if;
end $restored$;
rollback;

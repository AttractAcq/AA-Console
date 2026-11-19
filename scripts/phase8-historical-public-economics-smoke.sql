-- Disposable public Economics consistency fixture across archive/recovery.
begin;
insert into public.clients(id,name,initials)
values ('b6260000-0000-4000-8000-000000000001','Historical Economics fixture','HE');
select set_config('request.jwt.claim.role','service_role',true);
select set_config('request.jwt.claims','{"role":"service_role"}',true);
insert into public.client_leads
  (id,client_id,name,stage,source_channel,sale_value,sale_currency,
   cash_collected,cash_currency,lost_reason)
values
 ('c6260000-0000-4000-8000-000000000001',
  'b6260000-0000-4000-8000-000000000001','Cash lead','cash','organic',
  100,'USD',75,'USD',null),
 ('c6260000-0000-4000-8000-000000000002',
  'b6260000-0000-4000-8000-000000000001','Lost after sale','lost','direct',
  null,null,null,null,'No longer buying');
insert into public.lead_events(lead_id,client_id,kind,to_stage)
values ('c6260000-0000-4000-8000-000000000002',
  'b6260000-0000-4000-8000-000000000001','stage_change','sale');
create temporary table historical_economics_expected on commit drop as
select
 (select to_jsonb(e) from public.client_economics(
   'b6260000-0000-4000-8000-000000000001',current_date-1,current_date+1) e)
   as total,
 (select jsonb_agg(to_jsonb(e) order by e.channel)
   from public.client_economics_by_channel(
   'b6260000-0000-4000-8000-000000000001',current_date-1,current_date+1) e)
   as channel,
 (select jsonb_agg(to_jsonb(e) order by e.campaign_ref)
   from public.client_economics_by_campaign(
   'b6260000-0000-4000-8000-000000000001',current_date-1,current_date+1) e)
   as campaign;
insert into public.archived_leads(id,client_id,name,stage_at_archive,lead,events,reason)
select l.id,l.client_id,l.name,l.stage,to_jsonb(l),
  coalesce((select jsonb_agg(to_jsonb(e) order by e.occurred_at,e.id)
    from public.lead_events e where e.lead_id=l.id),'[]'::jsonb),'fixture'
from public.client_leads l
where l.client_id='b6260000-0000-4000-8000-000000000001';
delete from public.client_leads
where client_id='b6260000-0000-4000-8000-000000000001';
do $archived$
declare cid uuid:='b6260000-0000-4000-8000-000000000001';
  expected record; actual_total jsonb; actual_channel jsonb; actual_campaign jsonb;
begin
  select * into expected from historical_economics_expected;
  select to_jsonb(e) into actual_total
  from public.client_economics(cid,current_date-1,current_date+1) e;
  select jsonb_agg(to_jsonb(e) order by e.channel) into actual_channel
  from public.client_economics_by_channel(cid,current_date-1,current_date+1) e;
  select jsonb_agg(to_jsonb(e) order by e.campaign_ref) into actual_campaign
  from public.client_economics_by_campaign(cid,current_date-1,current_date+1) e;
  if expected.total is distinct from actual_total
     or expected.channel is distinct from actual_channel
     or expected.campaign is distinct from actual_campaign then
    raise exception 'Public Economics changed after archive'; end if;
  if (actual_total->>'cash_collected')::numeric<>75
     or (actual_total->>'customers')::integer<>2 then
    raise exception 'Archived cash or sale evidence was lost'; end if;
end $archived$;
select public.recover_lead('c6260000-0000-4000-8000-000000000001');
select public.recover_lead('c6260000-0000-4000-8000-000000000002');
do $restored$
declare cid uuid:='b6260000-0000-4000-8000-000000000001';
  expected record; actual_total jsonb; actual_channel jsonb; actual_campaign jsonb;
begin
  select * into expected from historical_economics_expected;
  select to_jsonb(e) into actual_total
  from public.client_economics(cid,current_date-1,current_date+1) e;
  select jsonb_agg(to_jsonb(e) order by e.channel) into actual_channel
  from public.client_economics_by_channel(cid,current_date-1,current_date+1) e;
  select jsonb_agg(to_jsonb(e) order by e.campaign_ref) into actual_campaign
  from public.client_economics_by_campaign(cid,current_date-1,current_date+1) e;
  if expected.total is distinct from actual_total
     or expected.channel is distinct from actual_channel
     or expected.campaign is distinct from actual_campaign then
    raise exception 'Public Economics changed after recovery'; end if;
end $restored$;
rollback;

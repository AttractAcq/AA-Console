-- Disposable MCP Economics consistency fixture, with archived cash and a
-- sale reached before a later lost stage.
begin;
insert into public.clients(id,name,initials)
values ('b6270000-0000-4000-8000-000000000001','Historical MCP fixture','HM');
select set_config('request.jwt.claim.role','service_role',true);
select set_config('request.jwt.claims','{"role":"service_role"}',true);
insert into public.client_leads
  (id,client_id,name,stage,source_channel,sale_value,sale_currency,
   cash_collected,cash_currency,lost_reason)
values
 ('c6270000-0000-4000-8000-000000000001',
  'b6270000-0000-4000-8000-000000000001','Cash lead','cash','organic',
  100,'USD',75,'USD',null),
 ('c6270000-0000-4000-8000-000000000002',
  'b6270000-0000-4000-8000-000000000001','Lost after sale','lost','direct',
  null,null,null,null,'No longer buying');
insert into public.lead_events(lead_id,client_id,kind,to_stage)
values ('c6270000-0000-4000-8000-000000000002',
  'b6270000-0000-4000-8000-000000000001','stage_change','sale');
create temporary table historical_mcp_expected on commit drop as
select mcp_internal.cohort_economics(
  'b6270000-0000-4000-8000-000000000001',current_date-1,current_date+1) as cohort,
  mcp_internal.cohort_economics_by_campaign(
  'b6270000-0000-4000-8000-000000000001',current_date-1,current_date+1,
  null,10) as campaign;
insert into public.archived_leads(id,client_id,name,stage_at_archive,lead,events,reason)
select l.id,l.client_id,l.name,l.stage,to_jsonb(l),
  coalesce((select jsonb_agg(to_jsonb(e) order by e.occurred_at,e.id)
    from public.lead_events e where e.lead_id=l.id),'[]'::jsonb),'fixture'
from public.client_leads l
where l.client_id='b6270000-0000-4000-8000-000000000001';
delete from public.client_leads
where client_id='b6270000-0000-4000-8000-000000000001';
do $archived$
declare cid uuid:='b6270000-0000-4000-8000-000000000001';
  expected record; cohort jsonb; campaign jsonb;
begin
  select * into expected from historical_mcp_expected;
  select mcp_internal.cohort_economics(cid,current_date-1,current_date+1)
    into cohort;
  select mcp_internal.cohort_economics_by_campaign(
    cid,current_date-1,current_date+1,null,10) into campaign;
  if expected.cohort is distinct from cohort
     or expected.campaign is distinct from campaign then
    raise exception 'MCP Economics changed after archive'; end if;
  if (cohort->>'cash_collected')::numeric<>75
     or (cohort->>'customers')::integer<>2 then
    raise exception 'Archived cash or sale evidence was lost'; end if;
end $archived$;
select public.recover_lead('c6270000-0000-4000-8000-000000000001');
select public.recover_lead('c6270000-0000-4000-8000-000000000002');
do $restored$
declare cid uuid:='b6270000-0000-4000-8000-000000000001';
  expected record; cohort jsonb; campaign jsonb;
begin
  select * into expected from historical_mcp_expected;
  select mcp_internal.cohort_economics(cid,current_date-1,current_date+1)
    into cohort;
  select mcp_internal.cohort_economics_by_campaign(
    cid,current_date-1,current_date+1,null,10) into campaign;
  if expected.cohort is distinct from cohort
     or expected.campaign is distinct from campaign then
    raise exception 'MCP Economics changed after recovery'; end if;
end $restored$;
rollback;

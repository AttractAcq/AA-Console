-- Disposable historical cohort source fixture. Values and stages must survive
-- archive/recovery; active rows win on overlap and probes stay excluded.
begin;
insert into public.clients(id,name,initials)
values ('b6250000-0000-4000-8000-000000000001','Historical progress fixture','HP');
select set_config('request.jwt.claim.role','service_role',true);
select set_config('request.jwt.claims','{"role":"service_role"}',true);
insert into public.client_leads
  (id,client_id,name,stage,source_channel,sale_value,sale_currency,
   cash_collected,cash_currency,lost_reason,is_probe)
values
 ('c6250000-0000-4000-8000-000000000001',
  'b6250000-0000-4000-8000-000000000001','Archived sale','lost','organic',
  100,'USD',75,'USD','Closed after sale',false),
 ('c6250000-0000-4000-8000-000000000002',
  'b6250000-0000-4000-8000-000000000001','Probe','cash','direct',
  9,'USD',9,'USD',null,true);
insert into public.lead_events(lead_id,client_id,kind,to_stage)
values ('c6250000-0000-4000-8000-000000000001',
  'b6250000-0000-4000-8000-000000000001','stage_change','sale');
do $active$
declare p record;
begin
  if (select count(*) from public.reporting_lead_progress_v10(
      'b6250000-0000-4000-8000-000000000001'))<>1 then
    raise exception 'Probe was included in the cohort'; end if;
  select * into p from public.reporting_lead_progress_v10(
      'b6250000-0000-4000-8000-000000000001');
  if p.archived or not p.sale_evidence or not p.ever_lost
     or p.furthest_rank<public.lead_stage_rank('sale')
     or p.cash_collected<>75 or p.cash_currency<>'USD' then
    raise exception 'Active lead progress was incorrect'; end if;
end $active$;
insert into public.archived_leads(id,client_id,name,stage_at_archive,lead,events,reason)
select l.id,l.client_id,l.name,l.stage,to_jsonb(l),
  coalesce((select jsonb_agg(to_jsonb(e) order by e.occurred_at,e.id)
    from public.lead_events e where e.lead_id=l.id),'[]'::jsonb),'fixture'
from public.client_leads l
where l.id='c6250000-0000-4000-8000-000000000001';
do $overlap$
begin
  if (select count(*) from public.reporting_lead_progress_v10(
      'b6250000-0000-4000-8000-000000000001'))<>1
     or (select archived from public.reporting_lead_progress_v10(
      'b6250000-0000-4000-8000-000000000001')) then
    raise exception 'Transition overlap was double counted or mislabelled'; end if;
end $overlap$;
delete from public.client_leads
where id='c6250000-0000-4000-8000-000000000001';
do $archived$
declare p record;
begin
  select * into p from public.reporting_lead_progress_v10(
      'b6250000-0000-4000-8000-000000000001');
  if not p.archived or not p.sale_evidence or not p.ever_lost
     or p.furthest_rank<public.lead_stage_rank('sale')
     or p.cash_collected<>75 or p.cash_currency<>'USD' then
    raise exception 'Archived lead progress or money was lost'; end if;
  if has_function_privilege('authenticated',
      'public.reporting_lead_progress_v10(uuid)','EXECUTE')
     or has_function_privilege('anon',
      'public.reporting_lead_progress_v10(uuid)','EXECUTE') then
    raise exception 'Private historical progress source was exposed'; end if;
end $archived$;
select public.recover_lead('c6250000-0000-4000-8000-000000000001');
do $restored$
declare p record;
begin
  select * into p from public.reporting_lead_progress_v10(
      'b6250000-0000-4000-8000-000000000001');
  if p.archived or not p.sale_evidence or not p.ever_lost
     or p.furthest_rank<public.lead_stage_rank('sale')
     or p.cash_collected<>75 or p.cash_currency<>'USD' then
    raise exception 'Recovered lead progress or money changed'; end if;
end $restored$;
rollback;

-- First-source page associations, currency coverage and archived lead values
-- must agree before archive, while archived, and after recovery.
begin;
insert into public.clients(id,name,initials)
values ('b6320000-0000-4000-8000-000000000001','Historical pages fixture','PG');
select set_config('request.jwt.claim.role','service_role',true);
select set_config('request.jwt.claims','{"role":"service_role"}',true);
insert into public.client_pages(id,client_id,page_type,title)
values
 ('a6320000-0000-4000-8000-000000000001',
  'b6320000-0000-4000-8000-000000000001','offer','Known cash'),
 ('a6320000-0000-4000-8000-000000000002',
  'b6320000-0000-4000-8000-000000000001','offer','Mixed cash');
insert into public.client_leads
 (id,client_id,name,stage,source_page_id,cash_collected,cash_currency,
  consent_given_at,consent_wording)
values
 ('c6320000-0000-4000-8000-000000000001',
  'b6320000-0000-4000-8000-000000000001','Known','cash',
  'a6320000-0000-4000-8000-000000000001',75,'USD',now(),'Fixture consent'),
 ('c6320000-0000-4000-8000-000000000002',
  'b6320000-0000-4000-8000-000000000001','Mixed USD','cash',
  'a6320000-0000-4000-8000-000000000002',50,'USD',now(),'Fixture consent'),
 ('c6320000-0000-4000-8000-000000000003',
  'b6320000-0000-4000-8000-000000000001','Mixed EUR','cash',
  'a6320000-0000-4000-8000-000000000002',50,'EUR',now(),'Fixture consent');
create temporary table historical_pages_expected on commit drop as
select
 (select jsonb_agg(to_jsonb(r) order by r.page_id)
  from public.page_recorded_outcomes_v9(
   'b6320000-0000-4000-8000-000000000001','offer',30) r) as current_v9,
 (select jsonb_agg(to_jsonb(r) order by r.page_id)
  from public.page_recorded_outcomes_v8(
   'b6320000-0000-4000-8000-000000000001','offer',30) r) as current_v8;
do $currency$
declare known record; mixed record;
begin
  select * into known from public.page_recorded_outcomes_v9(
    'b6320000-0000-4000-8000-000000000001','offer',30)
    where page_id='a6320000-0000-4000-8000-000000000001';
  select * into mixed from public.page_recorded_outcomes_v9(
    'b6320000-0000-4000-8000-000000000001','offer',30)
    where page_id='a6320000-0000-4000-8000-000000000002';
  if known.recorded_leads<>1 or known.consented_leads<>1
     or known.recorded_sales<>1 or known.recorded_cash<>75
     or known.cash_currency<>'USD' or known.cash_currency_count<>1 then
    raise exception 'Known-currency page outcome is wrong'; end if;
  if mixed.recorded_leads<>2 or mixed.recorded_cash is not null
     or mixed.cash_currency is not null or mixed.cash_currency_count<>2 then
    raise exception 'Mixed-currency page cash was combined'; end if;
end $currency$;
insert into public.archived_leads(id,client_id,name,stage_at_archive,lead,events,reason)
select id,client_id,name,stage,to_jsonb(l),'[]'::jsonb,'fixture'
from public.client_leads l
where client_id='b6320000-0000-4000-8000-000000000001';
delete from public.client_leads
where client_id='b6320000-0000-4000-8000-000000000001';
do $archived$
declare expected record; actual_v9 jsonb; actual_v8 jsonb;
begin
  select * into expected from historical_pages_expected;
  select jsonb_agg(to_jsonb(r) order by r.page_id) into actual_v9
  from public.page_recorded_outcomes_v9(
    'b6320000-0000-4000-8000-000000000001','offer',30) r;
  select jsonb_agg(to_jsonb(r) order by r.page_id) into actual_v8
  from public.page_recorded_outcomes_v8(
    'b6320000-0000-4000-8000-000000000001','offer',30) r;
  if expected.current_v9 is distinct from actual_v9
     or expected.current_v8 is distinct from actual_v8 then
    raise exception 'Page outcomes changed after archive'; end if;
end $archived$;
select public.recover_lead('c6320000-0000-4000-8000-000000000001');
select public.recover_lead('c6320000-0000-4000-8000-000000000002');
select public.recover_lead('c6320000-0000-4000-8000-000000000003');
do $restored$
declare expected record; actual_v9 jsonb; actual_v8 jsonb;
begin
  select * into expected from historical_pages_expected;
  select jsonb_agg(to_jsonb(r) order by r.page_id) into actual_v9
  from public.page_recorded_outcomes_v9(
    'b6320000-0000-4000-8000-000000000001','offer',30) r;
  select jsonb_agg(to_jsonb(r) order by r.page_id) into actual_v8
  from public.page_recorded_outcomes_v8(
    'b6320000-0000-4000-8000-000000000001','offer',30) r;
  if expected.current_v9 is distinct from actual_v9
     or expected.current_v8 is distinct from actual_v8 then
    raise exception 'Page outcomes changed after recovery'; end if;
end $restored$;
rollback;

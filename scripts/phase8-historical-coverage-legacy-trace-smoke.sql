-- Coverage and the legacy journey signature retain a recorded lead across
-- archive/recovery. This fixture does not release the positive-cash guard.
begin;
insert into public.clients(id,name,initials)
values ('b6330000-0000-4000-8000-000000000001','Historical coverage fixture','HC');
select set_config('request.jwt.claim.role','service_role',true);
select set_config('request.jwt.claims','{"role":"service_role"}',true);
insert into public.client_leads
 (id,client_id,name,stage,source_channel,cash_collected,cash_currency,
  consent_given_at,consent_wording)
values
 ('c6330000-0000-4000-8000-000000000001',
  'b6330000-0000-4000-8000-000000000001','Recorded','cash','organic',
  42,'USD',now(),'Fixture consent');
create temporary table historical_coverage_expected on commit drop as
select
 (select to_jsonb(r) from public.acquisition_coverage_v8(
   'b6330000-0000-4000-8000-000000000001',30) r) as coverage,
 (select jsonb_agg(to_jsonb(r) order by r.lead_id)
  from public.lead_journey_trace_v8(
   'b6330000-0000-4000-8000-000000000001',30,50) r) as legacy_trace;
do $before$
declare e record;
begin
  select * into e from historical_coverage_expected;
  if (e.coverage->>'lead_rows')::integer<>1
     or (e.coverage->>'sourced_leads')::integer<>1
     or (e.coverage->>'consented_leads')::integer<>1
     or jsonb_array_length(e.legacy_trace)<>1 then
    raise exception 'Initial coverage or legacy journey is wrong';
  end if;
end $before$;
insert into public.archived_leads(id,client_id,name,stage_at_archive,lead,events,reason)
select id,client_id,name,stage,to_jsonb(l),'[]'::jsonb,'fixture'
from public.client_leads l
where client_id='b6330000-0000-4000-8000-000000000001';
delete from public.client_leads
where client_id='b6330000-0000-4000-8000-000000000001';
do $archived$
declare e record; actual_coverage jsonb; actual_trace jsonb;
begin
  select * into e from historical_coverage_expected;
  select to_jsonb(r) into actual_coverage from public.acquisition_coverage_v8(
   'b6330000-0000-4000-8000-000000000001',30) r;
  select jsonb_agg(to_jsonb(r) order by r.lead_id) into actual_trace
  from public.lead_journey_trace_v8(
   'b6330000-0000-4000-8000-000000000001',30,50) r;
  if actual_coverage is distinct from e.coverage
     or actual_trace is distinct from e.legacy_trace then
    raise exception 'Historical coverage or legacy journey changed after archive';
  end if;
  if (select count(*) from public.lead_pipeline_counts
      where client_id='b6330000-0000-4000-8000-000000000001')<>0 then
    raise exception 'Archived lead remained in operating pipeline';
  end if;
end $archived$;
select public.recover_lead('c6330000-0000-4000-8000-000000000001');
do $recovered$
declare e record; actual_coverage jsonb; actual_trace jsonb;
begin
  select * into e from historical_coverage_expected;
  select to_jsonb(r) into actual_coverage from public.acquisition_coverage_v8(
   'b6330000-0000-4000-8000-000000000001',30) r;
  select jsonb_agg(to_jsonb(r) order by r.lead_id) into actual_trace
  from public.lead_journey_trace_v8(
   'b6330000-0000-4000-8000-000000000001',30,50) r;
  if actual_coverage is distinct from e.coverage
     or actual_trace is distinct from e.legacy_trace then
    raise exception 'Historical coverage or legacy journey changed after recovery';
  end if;
end $recovered$;
rollback;

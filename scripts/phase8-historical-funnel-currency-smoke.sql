-- Verify the public funnel and currency breakdown do not lose a finished
-- lead when its operating row moves to the historical snapshot. Roll back.
begin;
insert into public.clients(id,name,initials)
values ('b6240000-0000-4000-8000-000000000001','Historical funnel fixture','HF');
select set_config('request.jwt.claim.role','service_role',true);
select set_config('request.jwt.claims','{"role":"service_role"}',true);
insert into public.client_leads
  (id,client_id,name,stage,source_channel,opportunity_value,
   opportunity_currency,sale_value,sale_currency,cash_collected,cash_currency,
   lost_reason)
values ('c6240000-0000-4000-8000-000000000001',
  'b6240000-0000-4000-8000-000000000001','Archived cash','cash','organic',
  200,'USD',100,'USD',75,'USD',null),
 ('c6240000-0000-4000-8000-000000000002',
  'b6240000-0000-4000-8000-000000000001','Lost after sale','lost','direct',
  null,null,null,null,null,null,'No longer buying');
insert into public.lead_events(lead_id,client_id,kind,to_stage)
values ('c6240000-0000-4000-8000-000000000002',
  'b6240000-0000-4000-8000-000000000001','stage_change','sale');
create temporary table historical_funnel_expected on commit drop as
select to_jsonb(f) as funnel,
  (select jsonb_agg(to_jsonb(m) order by m.kind,m.currency nulls last)
   from public.client_money_currency_breakdown(
     'b6240000-0000-4000-8000-000000000001',current_date-1,current_date+1) m)
    as money
from public.acquisition_funnel('b6240000-0000-4000-8000-000000000001',30) f;
insert into public.archived_leads(id,client_id,name,stage_at_archive,lead,events,reason)
select id,client_id,name,stage,to_jsonb(l),
  coalesce((select jsonb_agg(to_jsonb(e) order by e.occurred_at,e.id)
    from public.lead_events e where e.lead_id=l.id),'[]'::jsonb),'fixture'
from public.client_leads l
where id in ('c6240000-0000-4000-8000-000000000001',
             'c6240000-0000-4000-8000-000000000002');
delete from public.client_leads
where id in ('c6240000-0000-4000-8000-000000000001',
             'c6240000-0000-4000-8000-000000000002');
do $checks$
declare cid uuid:='b6240000-0000-4000-8000-000000000001';
  before_row record; after_funnel jsonb; after_money jsonb;
begin
  select * into before_row from historical_funnel_expected;
  select to_jsonb(f) into after_funnel
  from public.acquisition_funnel(cid,30) f;
  select jsonb_agg(to_jsonb(m) order by m.kind,m.currency nulls last)
    into after_money
  from public.client_money_currency_breakdown(cid,current_date-1,current_date+1) m;
  if before_row.funnel is distinct from after_funnel
     or before_row.money is distinct from after_money then
    raise exception 'Historical funnel or money breakdown changed after archive';
  end if;
  if (after_funnel->>'leads')::integer<>2
     or (after_funnel->>'sales')::integer<>2
     or (after_funnel->>'cash_collected')::numeric<>75 then
    raise exception 'Historical lead or cash was lost';
  end if;
end $checks$;
select public.recover_lead('c6240000-0000-4000-8000-000000000001');
select public.recover_lead('c6240000-0000-4000-8000-000000000002');
do $restored$
declare cid uuid:='b6240000-0000-4000-8000-000000000001';
  before_row record; restored_funnel jsonb; restored_money jsonb;
begin
  select * into before_row from historical_funnel_expected;
  select to_jsonb(f) into restored_funnel
  from public.acquisition_funnel(cid,30) f;
  select jsonb_agg(to_jsonb(m) order by m.kind,m.currency nulls last)
    into restored_money
  from public.client_money_currency_breakdown(cid,current_date-1,current_date+1) m;
  if before_row.funnel is distinct from restored_funnel
     or before_row.money is distinct from restored_money then
    raise exception 'Historical funnel or money breakdown changed after recovery';
  end if;
end $restored$;
rollback;

-- Disposable rollback fixture for the internal historical lead reporting
-- source. It does not release the cash-positive archive RPC guard.
begin;
insert into public.clients(id,name,initials)
values ('b6230000-0000-4000-8000-000000000001','Historical reporting fixture','HR');
select set_config('request.jwt.claim.role','service_role',true);
select set_config('request.jwt.claims','{"role":"service_role"}',true);
insert into public.client_leads
  (id,client_id,name,stage,source_channel,sale_value,sale_currency,
   cash_collected,cash_currency)
values
 ('c6230000-0000-4000-8000-000000000001',
  'b6230000-0000-4000-8000-000000000001','Archived cash','cash','organic',
  100,'USD',75,'USD'),
 ('c6230000-0000-4000-8000-000000000002',
  'b6230000-0000-4000-8000-000000000001','Transition overlap','shown','direct',
  null,null,null,null);
insert into public.archived_leads(id,client_id,name,stage_at_archive,lead,events,reason)
select id,client_id,name,stage,to_jsonb(l),'[]'::jsonb,'fixture'
from public.client_leads l
where id in ('c6230000-0000-4000-8000-000000000001',
             'c6230000-0000-4000-8000-000000000002');
delete from public.client_leads
where id='c6230000-0000-4000-8000-000000000001';
do $checks$
declare cid uuid:='b6230000-0000-4000-8000-000000000001';
  v record;
begin
  if (select count(*) from public.reporting_lead_rows_v10(cid))<>2 then
    raise exception 'Archived and transition-overlap leads were double counted or lost'; end if;
  select * into v from public.reporting_lead_rows_v10(cid)
    where id='c6230000-0000-4000-8000-000000000001';
  if v.cash_collected<>75 or v.cash_currency<>'USD' or v.sale_value<>100
    or v.source_channel<>'organic' then
    raise exception 'Archived financial or source snapshot changed'; end if;
  if (select count(*) from public.reporting_lead_rows_v10(cid)
      where id='c6230000-0000-4000-8000-000000000002')<>1 then
    raise exception 'Current and archived overlap was counted twice'; end if;
end $checks$;
do $denied$
begin
  if has_function_privilege('authenticated',
    'public.reporting_lead_rows_v10(uuid)','EXECUTE')
    or has_function_privilege('anon',
      'public.reporting_lead_rows_v10(uuid)','EXECUTE') then
    raise exception 'Internal full-lead reporting source was exposed'; end if;
end $denied$;
rollback;

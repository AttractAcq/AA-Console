-- Operational pipeline counts stay active-only; a separate historical cash
-- value survives archive and recovery without inventing currency.
begin;
insert into public.clients(id,name,initials) values
 ('b6310000-0000-4000-8000-000000000001','Historical pipeline cash','PC'),
 ('b6310000-0000-4000-8000-000000000002','Unscoped pipeline','UP');
select set_config('request.jwt.claim.role','service_role',true);
select set_config('request.jwt.claims','{"role":"service_role"}',true);
insert into public.mcp_bot_clients(bot_id,client_id)
values ('bot_sales_ops','b6310000-0000-4000-8000-000000000001');
do $scope$
begin
  begin
    perform public.mcp_get_pipeline_summary('bot_sales_ops',
      'b6310000-0000-4000-8000-000000000002');
    raise exception 'Unscoped pipeline client was readable';
  exception when sqlstate 'P0001' then
    if sqlerrm<>'client_forbidden' then raise; end if;
  end;
end $scope$;
insert into public.client_leads
 (id,client_id,name,stage,cash_collected,cash_currency)
values ('c6310000-0000-4000-8000-000000000001',
  'b6310000-0000-4000-8000-000000000001','Cash lead','cash',75,'USD');
create temporary table historical_pipeline_expected on commit drop as
select public.mcp_get_pipeline_summary('bot_sales_ops',
  'b6310000-0000-4000-8000-000000000001') as result;
insert into public.archived_leads(id,client_id,name,stage_at_archive,lead,events,reason)
select id,client_id,name,stage,to_jsonb(l),'[]'::jsonb,'fixture'
from public.client_leads l
where id='c6310000-0000-4000-8000-000000000001';
delete from public.client_leads
where id='c6310000-0000-4000-8000-000000000001';
do $archived$
declare actual jsonb;
begin
  actual:=public.mcp_get_pipeline_summary('bot_sales_ops',
    'b6310000-0000-4000-8000-000000000001');
  if (actual->>'total_leads')::integer<>0
     or (actual->>'total_cash_collected')::numeric<>0
     or actual->>'cash_scope'<>'active_pipeline'
     or (actual->>'historical_cash_collected')::numeric<>75
     or actual->>'historical_cash_currency'<>'USD'
     or actual->>'historical_cash_scope'<>'all_recorded_leads' then
    raise exception 'Pipeline and historical cash scopes were confused'; end if;
end $archived$;
select public.recover_lead('c6310000-0000-4000-8000-000000000001');
do $restored$
declare expected jsonb; actual jsonb;
begin
  select result into expected from historical_pipeline_expected;
  actual:=public.mcp_get_pipeline_summary('bot_sales_ops',
    'b6310000-0000-4000-8000-000000000001');
  if expected is distinct from actual then
    raise exception 'Pipeline summary changed after recovery'; end if;
end $restored$;
rollback;

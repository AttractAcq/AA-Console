-- Disposable bot-scoped conversion funnel check across archive and recovery.
begin;
insert into public.clients(id,name,initials) values
 ('b6300000-0000-4000-8000-000000000001','Historical MCP funnel','MF'),
 ('b6300000-0000-4000-8000-000000000002','Unscoped MCP funnel','UF');
select set_config('request.jwt.claim.role','service_role',true);
select set_config('request.jwt.claims','{"role":"service_role"}',true);
insert into public.mcp_bot_clients(bot_id,client_id)
values ('bot_marketing','b6300000-0000-4000-8000-000000000001');
do $scope$
begin
  begin
    perform public.mcp_attribution_conversion_funnel('bot_marketing',
      'b6300000-0000-4000-8000-000000000002',30);
    raise exception 'Unscoped client was readable';
  exception when sqlstate 'P0001' then
    if sqlerrm<>'client_forbidden' then raise; end if;
  end;
end $scope$;
insert into public.client_leads
 (id,client_id,name,stage,sale_value,sale_currency,cash_collected,
  cash_currency,lost_reason)
values
 ('c6300000-0000-4000-8000-000000000001',
  'b6300000-0000-4000-8000-000000000001','Cash lead','cash',
  100,'USD',75,'USD',null),
 ('c6300000-0000-4000-8000-000000000002',
  'b6300000-0000-4000-8000-000000000001','Lost after sale','lost',
  null,null,null,null,'No longer buying');
insert into public.lead_events(lead_id,client_id,kind,to_stage)
values ('c6300000-0000-4000-8000-000000000002',
  'b6300000-0000-4000-8000-000000000001','stage_change','sale');
create temporary table historical_mcp_funnel_expected on commit drop as
select public.mcp_attribution_conversion_funnel('bot_marketing',
  'b6300000-0000-4000-8000-000000000001',30) as result;
insert into public.archived_leads(id,client_id,name,stage_at_archive,lead,events,reason)
select l.id,l.client_id,l.name,l.stage,to_jsonb(l),
  coalesce((select jsonb_agg(to_jsonb(e) order by e.occurred_at,e.id)
    from public.lead_events e where e.lead_id=l.id),'[]'::jsonb),'fixture'
from public.client_leads l
where l.client_id='b6300000-0000-4000-8000-000000000001';
delete from public.client_leads
where client_id='b6300000-0000-4000-8000-000000000001';
do $archived$
declare expected jsonb; actual jsonb;
begin
  select result into expected from historical_mcp_funnel_expected;
  actual:=public.mcp_attribution_conversion_funnel('bot_marketing',
    'b6300000-0000-4000-8000-000000000001',30);
  if expected is distinct from actual then
    raise exception 'MCP conversion funnel changed after archive'; end if;
  if (actual->'funnel'->>'leads')::integer<>2
     or (actual->'funnel'->>'sales')::integer<>2
     or (actual->'funnel'->>'cash_collected')::numeric<>75 then
    raise exception 'Archived lead, sale or cash was lost'; end if;
end $archived$;
select public.recover_lead('c6300000-0000-4000-8000-000000000001');
select public.recover_lead('c6300000-0000-4000-8000-000000000002');
do $restored$
declare expected jsonb; actual jsonb;
begin
  select result into expected from historical_mcp_funnel_expected;
  actual:=public.mcp_attribution_conversion_funnel('bot_marketing',
    'b6300000-0000-4000-8000-000000000001',30);
  if expected is distinct from actual then
    raise exception 'MCP conversion funnel changed after recovery'; end if;
end $restored$;
rollback;

-- Disposable MCP content attribution fixture. Bot scope is explicit; the
-- result keeps archived cash while missing provider metrics remain unknown.
begin;
insert into public.clients(id,name,initials)
values ('b6290000-0000-4000-8000-000000000001','Historical MCP content','MC'),
       ('b6290000-0000-4000-8000-000000000002','Unscoped MCP content','UC');
select set_config('request.jwt.claim.role','service_role',true);
select set_config('request.jwt.claims','{"role":"service_role"}',true);
insert into public.mcp_bot_clients(bot_id,client_id)
values ('bot_marketing','b6290000-0000-4000-8000-000000000001');
do $scope$
begin
  begin
    perform public.mcp_attribution_content_performance('bot_marketing',
      'b6290000-0000-4000-8000-000000000002',10);
    raise exception 'Unscoped client was readable';
  exception when sqlstate 'P0001' then
    if sqlerrm<>'client_forbidden' then raise; end if;
  end;
end $scope$;
insert into public.client_media_assets(id,client_id,media_type,title,storage_path)
values ('a6290000-0000-4000-8000-000000000001',
  'b6290000-0000-4000-8000-000000000001','image','Fixture asset',
  'fixture/mcp-content.png');
insert into public.client_leads
  (id,client_id,name,stage,source_asset_id,sale_value,sale_currency,
   cash_collected,cash_currency)
values ('c6290000-0000-4000-8000-000000000001',
  'b6290000-0000-4000-8000-000000000001','Cash lead','cash',
  'a6290000-0000-4000-8000-000000000001',100,'USD',75,'USD');
create temporary table historical_mcp_content_expected on commit drop as
select public.mcp_attribution_content_performance('bot_marketing',
  'b6290000-0000-4000-8000-000000000001',10) as result;
insert into public.archived_leads(id,client_id,name,stage_at_archive,lead,events,reason)
select id,client_id,name,stage,to_jsonb(l),'[]'::jsonb,'fixture'
from public.client_leads l
where id='c6290000-0000-4000-8000-000000000001';
delete from public.client_leads
where id='c6290000-0000-4000-8000-000000000001';
do $archived$
declare expected jsonb; actual jsonb; item jsonb;
begin
  select result into expected from historical_mcp_content_expected;
  actual:=public.mcp_attribution_content_performance('bot_marketing',
    'b6290000-0000-4000-8000-000000000001',10);
  if expected is distinct from actual then
    raise exception 'MCP content contribution changed after archive'; end if;
  item:=actual->'items'->0;
  if (item->>'cash_collected')::numeric<>75
     or (item->>'sales')::integer<>1
     or item->'spend'<>'null'::jsonb
     or item->'impressions'<>'null'::jsonb then
    raise exception 'Archived cash or missing metric coverage was misreported';
  end if;
end $archived$;
select public.recover_lead('c6290000-0000-4000-8000-000000000001');
do $restored$
declare expected jsonb; actual jsonb;
begin
  select result into expected from historical_mcp_content_expected;
  actual:=public.mcp_attribution_content_performance('bot_marketing',
    'b6290000-0000-4000-8000-000000000001',10);
  if expected is distinct from actual then
    raise exception 'MCP content contribution changed after recovery'; end if;
end $restored$;
rollback;

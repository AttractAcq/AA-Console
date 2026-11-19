-- Cross-lead opportunity and money totals need one complete currency.
begin;
insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
values ('a6180000-0000-4000-8000-000000000001','00000000-0000-0000-0000-000000000000',
  'authenticated','authenticated','opportunity-aggregate@example.invalid','',now(),now());
insert into public.profiles(id,role,email)
values ('a6180000-0000-4000-8000-000000000001','admin','opportunity-aggregate@example.invalid');
insert into public.clients(id,name,initials)
values ('b6180000-0000-4000-8000-000000000001','Opportunity aggregate fixture','OA');
insert into public.mcp_bot_clients(bot_id,client_id)
values ('bot_marketing','b6180000-0000-4000-8000-000000000001');
insert into public.client_media_assets(id,client_id,media_type,title,storage_path)
values ('c6180000-0000-4000-8000-000000000001',
  'b6180000-0000-4000-8000-000000000001','image','Opportunity source','fixture/opp.png');
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claim.sub','a6180000-0000-4000-8000-000000000001',true);
select set_config('request.jwt.claims',
  '{"sub":"a6180000-0000-4000-8000-000000000001","role":"authenticated"}',true);
insert into public.client_leads(client_id,name,stage,source_asset_id,
  opportunity_value,opportunity_currency,sale_value,sale_currency,
  cash_collected,cash_currency)
values ('b6180000-0000-4000-8000-000000000001','Comparable','cash',
  'c6180000-0000-4000-8000-000000000001',500,'ZAR',250,'ZAR',200,'ZAR');
select set_config('request.jwt.claim.role','service_role',true);
select set_config('request.jwt.claims','{"role":"service_role"}',true);
do $checks$
declare cid uuid:='b6180000-0000-4000-8000-000000000001';
  asset uuid:='c6180000-0000-4000-8000-000000000001';
  v record; packet jsonb; summary jsonb;
begin
  select * into v from public.acquisition_funnel(cid,30);
  if v.pipeline_value<>500 then raise exception 'Comparable client pipeline missing'; end if;
  packet:=public.mcp_attribution_conversion_funnel('bot_marketing',cid,30);
  summary:=mcp_internal.get_pipeline_summary('bot_marketing',cid);
  if (packet#>>'{funnel,pipeline_value}')::numeric<>500
     or packet#>>'{funnel,opportunity_currency}'<>'ZAR'
     or (summary->>'total_opportunity_value')::numeric<>500
     or summary->>'opportunity_currency'<>'ZAR' then
    raise exception 'Comparable MCP pipeline missing'; end if;
  select opportunity_value,sale_value,cash_collected into v
  from public.content_attribution where asset_id=asset;
  if v.opportunity_value<>500 or v.sale_value<>250 or v.cash_collected<>200 then
    raise exception 'Comparable asset money missing'; end if;

  insert into public.client_leads(client_id,name,stage,source_asset_id,
    opportunity_value,opportunity_currency,sale_value,sale_currency,
    cash_collected,cash_currency)
  values(cid,'Other opportunity','shown',asset,100,'USD',0,null,0,null);
  select * into v from public.acquisition_funnel(cid,30);
  if v.pipeline_value is not null or v.cash_collected<>200 then
    raise exception 'Mixed opportunity currency produced client pipeline'; end if;
  packet:=public.mcp_attribution_conversion_funnel('bot_marketing',cid,30);
  summary:=mcp_internal.get_pipeline_summary('bot_marketing',cid);
  if packet#>'{funnel,pipeline_value}' is distinct from 'null'::jsonb
     or summary->'total_opportunity_value' is distinct from 'null'::jsonb then
    raise exception 'Mixed opportunity currency produced MCP pipeline'; end if;
  select opportunity_value,sale_value,cash_collected into v
  from public.content_attribution where asset_id=asset;
  if v.opportunity_value is not null or v.sale_value<>250 or v.cash_collected<>200 then
    raise exception 'Mixed opportunity currency produced asset total'; end if;

  insert into public.client_leads(client_id,name,stage,source_asset_id,
    opportunity_value,opportunity_currency,sale_value,sale_currency,
    cash_collected,cash_currency)
  values(cid,'Other cash','cash',asset,0,null,75,'USD',50,'USD');
  summary:=mcp_internal.get_pipeline_summary('bot_marketing',cid);
  select opportunity_value,sale_value,cash_collected into v
  from public.content_attribution where asset_id=asset;
  if summary->'total_cash_collected' is distinct from 'null'::jsonb
     or v.sale_value is not null or v.cash_collected is not null then
    raise exception 'Mixed lead cash or sale produced asset/MCP total'; end if;
  insert into public.client_leads(client_id,name,stage,source_asset_id,
    opportunity_value,opportunity_currency,cash_collected,cash_currency,is_probe)
  values(cid,'Probe','cash',asset,999999,'EUR',999999,'EUR',true);
  select * into v from public.acquisition_funnel(cid,30);
  if v.leads<>3 then raise exception 'Probe entered client funnel'; end if;
  summary:=mcp_internal.get_pipeline_summary('bot_marketing',cid);
  if (summary->>'total_leads')::int<>3 then raise exception 'Probe entered MCP pipeline'; end if;
end $checks$;
rollback;

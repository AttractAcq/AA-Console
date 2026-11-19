begin;
insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
values ('a8999999-9999-4999-8999-999999999999','00000000-0000-0000-0000-000000000000',
  'authenticated','authenticated','sales-definition@example.invalid','',now(),now());
insert into public.profiles(id,role,email) values
  ('a8999999-9999-4999-8999-999999999999','admin','sales-definition@example.invalid');
insert into public.clients(id,name,initials) values
  ('b8999999-9999-4999-8999-999999999999','Sales definition fixture','SD');
insert into public.mcp_bot_clients(bot_id,client_id)
values('bot_marketing','b8999999-9999-4999-8999-999999999999');
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claim.sub','a8999999-9999-4999-8999-999999999999',true);
select set_config('request.jwt.claims',
  '{"sub":"a8999999-9999-4999-8999-999999999999","role":"authenticated","aal":"aal2"}',true);
insert into public.client_media_assets(id,client_id,media_type,title,storage_path)
values ('c8999999-9999-4999-8999-999999999999',
  'b8999999-9999-4999-8999-999999999999','image','Source asset','fixture/sale.png');
insert into public.client_leads(client_id,name,stage,lost_reason,source_channel,
  source_asset_id,sale_value,cash_collected,sale_currency,cash_currency)
values
  ('b8999999-9999-4999-8999-999999999999','Shown only','shown',null,'website',
    'c8999999-9999-4999-8999-999999999999',0,0,'ZAR','ZAR'),
  ('b8999999-9999-4999-8999-999999999999','Shown with sale value','shown',null,'website',
    'c8999999-9999-4999-8999-999999999999',500,0,'ZAR','ZAR'),
  ('b8999999-9999-4999-8999-999999999999','Shown with cash','shown',null,'website',
    'c8999999-9999-4999-8999-999999999999',0,150,'ZAR','ZAR'),
  ('b8999999-9999-4999-8999-999999999999','Cash stage','cash',null,'website',
    'c8999999-9999-4999-8999-999999999999',1200,1200,'ZAR','ZAR'),
  ('b8999999-9999-4999-8999-999999999999','Lost after sale','lost','Historical loss','website',
    'c8999999-9999-4999-8999-999999999999',0,0,'ZAR','ZAR');
-- A page-health probe can carry apparent sale/cash values. It remains in the
-- audit trail but must not enter acquisition or Economics reporting.
insert into public.client_leads(client_id,name,stage,source_channel,
  source_asset_id,sale_value,cash_collected,sale_currency,cash_currency,is_probe)
values ('b8999999-9999-4999-8999-999999999999','Probe sale','cash','website',
  'c8999999-9999-4999-8999-999999999999',99999,99999,'ZAR','ZAR',true);
insert into public.lead_events(lead_id,client_id,kind,to_stage)
select id,client_id,'stage_change','sale' from public.client_leads
where name='Lost after sale';
do $checks$
declare cid uuid:='b8999999-9999-4999-8999-999999999999';
  v record; packet jsonb; campaigns jsonb; denied boolean:=false;
begin
  select * into v from public.acquisition_funnel(cid,30);
  if v.leads<>5 or v.appointments<>4 or v.sales<>4 or v.lead_to_sale_pct<>80 then
    raise exception 'Funnel sale evidence disagrees with the five-lead fixture'; end if;
  if v.sale_value<>1700 or v.cash_collected<>1350 then
    raise exception 'Probe amount entered acquisition funnel'; end if;
  select * into v from public.acquisition_coverage_v8(cid,30);
  if v.lead_rows<>5 or v.sourced_leads<>5 or v.consented_leads<>0 then
    raise exception 'Probe entered acquisition coverage'; end if;
  select * into v from public.content_attribution where client_id=cid
    and asset_id='c8999999-9999-4999-8999-999999999999';
  if v.leads<>5 or v.sales<>4 or v.sale_value<>1700 or v.cash_collected<>1350 then
    raise exception 'Content attribution sale evidence disagrees'; end if;
  select * into v from public.client_economics(cid,current_date-1,current_date+1);
  if v.leads<>5 or v.customers<>4 or v.revenue<>1700 or v.cash_collected<>1350 then
    raise exception 'Economics customer count disagrees'; end if;
  select * into v from public.client_economics_by_channel(cid,current_date-1,current_date+1)
    where channel='website';
  if v.leads<>5 or v.customers<>4 or v.revenue<>1700 or v.cash_collected<>1350 then
    raise exception 'Channel economics customer count disagrees'; end if;
  select * into v from public.client_economics_by_campaign(cid,current_date-1,current_date+1)
    where campaign_id is null;
  if v.leads<>5 or v.customers<>4 or v.revenue<>1700 or v.cash_collected<>1350 then
    raise exception 'Campaign economics customer count disagrees'; end if;
  perform set_config('request.jwt.claim.sub','f8999999-9999-4999-8999-999999999999',true);
  perform set_config('request.jwt.claims',
    '{"sub":"f8999999-9999-4999-8999-999999999999","role":"authenticated"}',true);
  begin perform public.client_economics(cid,current_date-1,current_date+1);
  exception when others then
    denied:=sqlerrm='Not permitted for this client'; end;
  if not denied then raise exception 'Other user read Economics'; end if;
  perform set_config('request.jwt.claim.role','service_role',true);
  packet:=public.mcp_attribution_conversion_funnel('bot_marketing',cid,30);
  if (packet#>>'{funnel,sales}')::integer<>4 or
     (packet#>>'{funnel,leads}')::integer<>5 or
     (packet#>>'{funnel,cash_collected}')::numeric<>1350 then
    raise exception 'MCP funnel sale count disagrees'; end if;
  packet:=mcp_internal.cohort_economics(cid,current_date-1,current_date+1);
  if (packet->>'customers')::integer<>4 or
     (packet->>'leads')::integer<>5 or
     (packet->>'cash_collected')::numeric<>1350 then
    raise exception 'Finance Controller cohort customer count disagrees'; end if;
  campaigns:=mcp_internal.cohort_economics_by_campaign(
    cid,current_date-1,current_date+1,null,25);
  if (campaigns->0->>'customers')::integer<>4 or
     (campaigns->0->>'leads')::integer<>5 or
     (campaigns->0->>'cash_collected')::numeric<>1350 then
    raise exception 'Finance Controller campaign customer count disagrees'; end if;
end $checks$;
rollback;

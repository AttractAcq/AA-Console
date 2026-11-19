-- Disposable proof that client and MCP acquisition returns require comparable money.
begin;
insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
values ('a6150000-0000-4000-8000-000000000001','00000000-0000-0000-0000-000000000000',
  'authenticated','authenticated','currency-funnel@example.invalid','',now(),now());
insert into public.profiles(id,role,email)
values ('a6150000-0000-4000-8000-000000000001','admin','currency-funnel@example.invalid');
insert into public.clients(id,name,initials)
values ('b6150000-0000-4000-8000-000000000001','Currency funnel fixture','CF');
insert into public.mcp_bot_clients(bot_id,client_id)
values ('bot_marketing','b6150000-0000-4000-8000-000000000001');
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claim.sub','a6150000-0000-4000-8000-000000000001',true);
select set_config('request.jwt.claims',
  '{"sub":"a6150000-0000-4000-8000-000000000001","role":"authenticated"}',true);
insert into public.client_marketing_spend(client_id,spent_on,amount,currency)
values ('b6150000-0000-4000-8000-000000000001',current_date,100,'ZAR');
insert into public.client_leads(client_id,name,stage,sale_value,sale_currency,
  cash_collected,cash_currency)
values ('b6150000-0000-4000-8000-000000000001','Recorded ZAR','cash',250,'ZAR',200,'ZAR');
do $checks$
declare cid uuid:='b6150000-0000-4000-8000-000000000001'; v record;
begin
  select * into v from public.acquisition_funnel(cid,30);
  if v.sale_value<>250 or v.cash_collected<>200 or v.return_on_spend<>2
     or v.cost_per_lead<>100 then
    raise exception 'Matching recorded currency did not yield a comparable funnel'; end if;
  update public.client_marketing_spend set currency='USD' where client_id=cid;
  select * into v from public.acquisition_funnel(cid,30);
  if v.cash_collected<>200 or v.return_on_spend is not null then
    raise exception 'Mismatched spend currency produced return'; end if;
  update public.client_marketing_spend set currency='ZAR' where client_id=cid;
  insert into public.client_leads(client_id,name,stage,sale_value,sale_currency,
    cash_collected,cash_currency)
  values(cid,'Recorded USD','cash',75,'USD',50,'USD');
  select * into v from public.acquisition_funnel(cid,30);
  if v.sale_value is not null or v.cash_collected is not null
     or v.return_on_spend is not null then
    raise exception 'Mixed lead currencies produced an aggregate'; end if;
  insert into public.client_marketing_spend(client_id,spent_on,amount,currency)
  values(cid,current_date,10,'USD');
  select * into v from public.acquisition_funnel(cid,30);
  if v.cost_per_lead is not null or v.return_on_spend is not null then
    raise exception 'Mixed spend currencies produced a cost or return'; end if;
end $checks$;
-- Simulate a historical unverified amount after the direct-write guard.
set local session_replication_role = replica;
update public.client_leads set cash_currency=null where name='Recorded USD';
set local session_replication_role = origin;
select set_config('request.jwt.claim.role','service_role',true);
select set_config('request.jwt.claims','{"role":"service_role"}',true);
do $mcp$
declare packet jsonb;
begin
  packet:=public.mcp_attribution_conversion_funnel(
    'bot_marketing','b6150000-0000-4000-8000-000000000001',30);
  if packet#>'{funnel,cash_collected}' is distinct from 'null'::jsonb
     or packet#>'{funnel,return_on_spend}' is distinct from 'null'::jsonb
     or (packet#>>'{funnel,cash_currency_unverified_leads}')::int<>1 then
    raise exception 'MCP funnel returned unverified cash or return'; end if;
end $mcp$;
rollback;

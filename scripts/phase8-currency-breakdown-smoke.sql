-- Per-currency rows never merge unlike amounts or silently label unknowns.
begin;
insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
values ('a6190000-0000-4000-8000-000000000001','00000000-0000-0000-0000-000000000000',
  'authenticated','authenticated','currency-breakdown@example.invalid','',now(),now());
insert into public.profiles(id,role,email)
values ('a6190000-0000-4000-8000-000000000001','client','currency-breakdown@example.invalid');
insert into public.clients(id,name,initials) values
  ('b6190000-0000-4000-8000-000000000001','Breakdown client one','B1'),
  ('b6190000-0000-4000-8000-000000000002','Breakdown client two','B2');
insert into public.client_users(client_id,user_id)
values ('b6190000-0000-4000-8000-000000000001','a6190000-0000-4000-8000-000000000001');
select set_config('request.jwt.claim.role','service_role',true);
select set_config('request.jwt.claims','{"role":"service_role"}',true);
insert into public.client_leads(client_id,name,stage,opportunity_value,opportunity_currency,
  sale_value,sale_currency,cash_collected,cash_currency)
values ('b6190000-0000-4000-8000-000000000001','Recorded ZAR','cash',500,'ZAR',250,'ZAR',200,'ZAR');
insert into public.client_leads(client_id,name,stage,opportunity_value,opportunity_currency,
  sale_value,sale_currency,cash_collected,cash_currency)
values ('b6190000-0000-4000-8000-000000000001','Recorded USD','cash',100,'USD',75,'USD',50,'USD');
set local session_replication_role = replica;
insert into public.client_leads(client_id,name,stage,opportunity_value,cash_collected)
values ('b6190000-0000-4000-8000-000000000001','Historical unknown','cash',40,20);
set local session_replication_role = origin;
insert into public.client_leads(client_id,name,stage,opportunity_value,opportunity_currency,
  cash_collected,cash_currency,is_probe)
values ('b6190000-0000-4000-8000-000000000001','Probe','cash',99999,'EUR',99999,'EUR',true);
insert into public.client_marketing_spend(client_id,spent_on,amount,currency)
values ('b6190000-0000-4000-8000-000000000001',current_date,100,'ZAR'),
       ('b6190000-0000-4000-8000-000000000001',current_date,20,'USD');
set local role authenticated;
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claim.sub','a6190000-0000-4000-8000-000000000001',true);
select set_config('request.jwt.claims',
  '{"sub":"a6190000-0000-4000-8000-000000000001","role":"authenticated"}',true);
do $checks$
declare cid uuid:='b6190000-0000-4000-8000-000000000001';
  v record; rows integer; denied boolean:=false;
begin
  select * into v from public.client_money_currency_breakdown(cid,current_date-1,current_date+1)
  where kind='cash' and currency='ZAR';
  if v.amount<>200 or v.record_count<>1 then raise exception 'ZAR cash bucket incorrect'; end if;
  select * into v from public.client_money_currency_breakdown(cid,current_date-1,current_date+1)
  where kind='cash' and currency='USD';
  if v.amount<>50 or v.record_count<>1 then raise exception 'USD cash bucket incorrect'; end if;
  select * into v from public.client_money_currency_breakdown(cid,current_date-1,current_date+1)
  where kind='cash' and currency is null;
  if v.amount<>20 or v.record_count<>1 then raise exception 'Unknown cash bucket incorrect'; end if;
  select * into v from public.client_money_currency_breakdown(cid,current_date-1,current_date+1)
  where kind='opportunity' and currency is null;
  if v.amount<>40 or v.record_count<>1 then raise exception 'Unknown opportunity bucket incorrect'; end if;
  select * into v from public.client_money_currency_breakdown(cid,current_date-1,current_date+1)
  where kind='spend' and currency='USD';
  if v.amount<>20 or v.record_count<>1 then raise exception 'USD spend bucket incorrect'; end if;
  select count(*) into rows from public.client_money_currency_breakdown(cid,current_date-1,current_date+1);
  if rows<>10 then raise exception 'Unexpected currency bucket count: %',rows; end if;
  select count(*) into rows from public.client_money_currency_breakdown(cid,current_date-3,current_date-2);
  if rows<>0 then raise exception 'Out-of-window money entered breakdown'; end if;
  begin perform public.client_money_currency_breakdown(
    'b6190000-0000-4000-8000-000000000002',current_date-1,current_date+1);
  exception when others then denied:=sqlerrm='Not permitted for this client'; end;
  if not denied then raise exception 'Other-client money breakdown was readable'; end if;
end $checks$;
rollback;

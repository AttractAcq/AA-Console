-- Currency comparability for browser Economics and Finance Controller reads.
begin;
insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
values ('a6160000-0000-4000-8000-000000000001','00000000-0000-0000-0000-000000000000',
  'authenticated','authenticated','economics-currency@example.invalid','',now(),now());
insert into public.profiles(id,role,email)
values ('a6160000-0000-4000-8000-000000000001','admin','economics-currency@example.invalid');
insert into public.clients(id,name,initials)
values ('b6160000-0000-4000-8000-000000000001','Economics currency fixture','EC');
insert into public.campaigns(id,campaign_ref,client_id,target_role)
values ('c6160000-0000-4000-8000-000000000001','Economics currency 616',
  'b6160000-0000-4000-8000-000000000001','buyer');
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claim.sub','a6160000-0000-4000-8000-000000000001',true);
select set_config('request.jwt.claims',
  '{"sub":"a6160000-0000-4000-8000-000000000001","role":"authenticated"}',true);
insert into public.client_marketing_spend(client_id,campaign_id,channel,spent_on,amount,currency)
values ('b6160000-0000-4000-8000-000000000001','c6160000-0000-4000-8000-000000000001',
  'website',current_date,100,'ZAR');
insert into public.client_leads(client_id,name,stage,source_campaign_id,source_channel,
  sale_value,sale_currency,cash_collected,cash_currency)
values ('b6160000-0000-4000-8000-000000000001','Comparable buyer','cash',
  'c6160000-0000-4000-8000-000000000001','website',250,'ZAR',200,'ZAR');
do $checks$
declare cid uuid:='b6160000-0000-4000-8000-000000000001';
  v record; packet jsonb; rows jsonb;
begin
  select * into v from public.client_economics(cid,current_date-1,current_date+1);
  if v.roas<>2.5 or v.cash_roas<>2 or v.revenue<>250 or v.cash_collected<>200 then
    raise exception 'Comparable Economics total missing'; end if;
  select * into v from public.client_economics_by_channel(cid,current_date-1,current_date+1)
    where channel='website';
  if v.roas<>2.5 or v.revenue<>250 then raise exception 'Comparable channel missing'; end if;
  select * into v from public.client_economics_by_campaign(cid,current_date-1,current_date+1)
    where campaign_id='c6160000-0000-4000-8000-000000000001';
  if v.roas<>2.5 or v.revenue<>250 then raise exception 'Comparable campaign missing'; end if;
  packet:=mcp_internal.cohort_economics(cid,current_date-1,current_date+1);
  rows:=mcp_internal.cohort_economics_by_campaign(cid,current_date-1,current_date+1,
    'c6160000-0000-4000-8000-000000000001',25);
  if (packet->>'roas')::numeric<>2.5 or (packet->>'cash_roas')::numeric<>2
     or (rows->0->>'roas')::numeric<>2.5 then
    raise exception 'Comparable Finance Controller return missing'; end if;

  update public.client_marketing_spend set currency='USD' where client_id=cid;
  select * into v from public.client_economics(cid,current_date-1,current_date+1);
  if v.roas is not null or v.cash_roas is not null then
    raise exception 'Mismatched spend returned Economics ratio'; end if;
  select * into v from public.client_economics_by_channel(cid,current_date-1,current_date+1)
    where channel='website';
  if v.roas is not null then raise exception 'Mismatched spend returned channel ratio'; end if;
  select * into v from public.client_economics_by_campaign(cid,current_date-1,current_date+1)
    where campaign_id='c6160000-0000-4000-8000-000000000001';
  if v.roas is not null then raise exception 'Mismatched spend returned campaign ratio'; end if;
  packet:=mcp_internal.cohort_economics(cid,current_date-1,current_date+1);
  rows:=mcp_internal.cohort_economics_by_campaign(cid,current_date-1,current_date+1,
    'c6160000-0000-4000-8000-000000000001',25);
  if packet->>'roas' is not null or packet->>'cash_roas' is not null
     or rows->0->>'roas' is not null then
    raise exception 'Mismatched spend returned Finance Controller ratio'; end if;

  update public.client_marketing_spend set currency='ZAR' where client_id=cid;
  insert into public.client_leads(client_id,name,stage,source_campaign_id,source_channel,
    sale_value,sale_currency,cash_collected,cash_currency)
  values(cid,'Other currency','cash','c6160000-0000-4000-8000-000000000001',
    'website',75,'USD',50,'USD');
  select * into v from public.client_economics(cid,current_date-1,current_date+1);
  if v.revenue is not null or v.cash_collected is not null or v.roas is not null then
    raise exception 'Mixed lead currencies returned Economics money'; end if;
  select * into v from public.client_economics_by_channel(cid,current_date-1,current_date+1)
    where channel='website';
  if v.revenue is not null or v.cash_collected is not null or v.roas is not null then
    raise exception 'Mixed lead currencies returned channel money'; end if;
  select * into v from public.client_economics_by_campaign(cid,current_date-1,current_date+1)
    where campaign_id='c6160000-0000-4000-8000-000000000001';
  if v.revenue is not null or v.cash_collected is not null or v.roas is not null then
    raise exception 'Mixed lead currencies returned campaign money'; end if;
  packet:=mcp_internal.cohort_economics(cid,current_date-1,current_date+1);
  rows:=mcp_internal.cohort_economics_by_campaign(cid,current_date-1,current_date+1,
    'c6160000-0000-4000-8000-000000000001',25);
  if packet->'revenue' is distinct from 'null'::jsonb
     or packet->'cash_collected' is distinct from 'null'::jsonb
     or rows->0->'revenue' is distinct from 'null'::jsonb
     or rows->0->'cash_collected' is distinct from 'null'::jsonb then
    raise exception 'Mixed lead currencies returned Finance Controller money'; end if;
  insert into public.client_marketing_spend(client_id,campaign_id,channel,spent_on,amount,currency)
  values(cid,'c6160000-0000-4000-8000-000000000001','website',current_date,20,'USD');
  select * into v from public.client_economics_by_channel(cid,current_date-1,current_date+1)
    where channel='website';
  if v.cpl is not null or v.cac is not null or v.roas is not null then
    raise exception 'Mixed spend currencies returned channel costs'; end if;
  select * into v from public.client_economics_by_campaign(cid,current_date-1,current_date+1)
    where campaign_id='c6160000-0000-4000-8000-000000000001';
  if v.cpl is not null or v.cac is not null or v.roas is not null then
    raise exception 'Mixed spend currencies returned campaign costs'; end if;
  rows:=mcp_internal.cohort_economics_by_campaign(cid,current_date-1,current_date+1,
    'c6160000-0000-4000-8000-000000000001',25);
  if rows->0->>'cpl' is not null or rows->0->>'cac' is not null then
    raise exception 'Mixed spend currencies returned Finance Controller costs'; end if;
end $checks$;
-- Historical positive amounts can lack currency; never infer it from spend.
set local session_replication_role = replica;
update public.client_leads set sale_currency=null, cash_currency=null
where name='Other currency';
set local session_replication_role = origin;
do $legacy$
declare cid uuid:='b6160000-0000-4000-8000-000000000001'; v record; packet jsonb;
begin
  select * into v from public.client_economics(cid,current_date-1,current_date+1);
  if v.revenue is not null or v.cash_collected is not null then
    raise exception 'Unverified historical lead returned Economics money'; end if;
  packet:=mcp_internal.cohort_economics(cid,current_date-1,current_date+1);
  if packet->'revenue' is distinct from 'null'::jsonb
     or packet->'cash_collected' is distinct from 'null'::jsonb
     or (packet->>'unverified_sale_leads')::int<>1
     or (packet->>'unverified_cash_leads')::int<>1 then
    raise exception 'Unverified historical lead returned Finance Controller money'; end if;
end $legacy$;
rollback;

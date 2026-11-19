-- Disposable rollback fixture for the first Sales OS currency capture path.
begin;
insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
values
 ('a6120000-0000-4000-8000-000000000001','00000000-0000-0000-0000-000000000000','authenticated','authenticated','currency-client@example.invalid','',now(),now());
insert into public.profiles(id,role,email)
values ('a6120000-0000-4000-8000-000000000001','client','currency-client@example.invalid');
insert into public.clients(id,name,initials) values
 ('b6120000-0000-4000-8000-000000000001','Currency fixture one','C1'),
 ('b6120000-0000-4000-8000-000000000002','Currency fixture two','C2');
insert into public.client_users(client_id,user_id)
values ('b6120000-0000-4000-8000-000000000001','a6120000-0000-4000-8000-000000000001');
select set_config('request.jwt.claim.role','service_role',true);
select set_config('request.jwt.claims','{"role":"service_role"}',true);
-- Existing money has no known currency; the migration must not invent it.
insert into public.client_leads(id,client_id,name,stage,sale_value,cash_collected)
values
 ('c6120000-0000-4000-8000-000000000001','b6120000-0000-4000-8000-000000000001','Legacy','shown',100,50),
 ('c6120000-0000-4000-8000-000000000002','b6120000-0000-4000-8000-000000000001','New sale','shown',null,null),
 ('c6120000-0000-4000-8000-000000000003','b6120000-0000-4000-8000-000000000002','Other client','shown',null,null);

set local role authenticated;
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claim.sub','a6120000-0000-4000-8000-000000000001',true);
select set_config('request.jwt.claims',
 '{"sub":"a6120000-0000-4000-8000-000000000001","role":"authenticated"}',true);
do $checks$
declare
  legacy uuid:='c6120000-0000-4000-8000-000000000001';
  fresh uuid:='c6120000-0000-4000-8000-000000000002';
  other uuid:='c6120000-0000-4000-8000-000000000003';
  refused boolean;
  v record;
begin
  select sale_currency,cash_currency into v from public.client_leads where id=legacy;
  if v.sale_currency is not null or v.cash_currency is not null then
    raise exception 'Legacy currency was invented'; end if;
  perform public.update_lead(legacy,'{"next_action":"Call again"}'::jsonb);
  select sale_value,cash_collected,sale_currency,cash_currency into v
    from public.client_leads where id=legacy;
  if v.sale_value<>100 or v.cash_collected<>50
     or v.sale_currency is not null or v.cash_currency is not null then
    raise exception 'Unrelated legacy edit changed financial evidence'; end if;

  refused:=false;
  begin perform public.update_lead(fresh,'{"sale_value":250}'::jsonb);
  exception when others then refused:=sqlerrm like 'Sale currency is required%'; end;
  if not refused then raise exception 'Positive sale without currency passed'; end if;
  refused:=false;
  begin perform public.update_lead(fresh,'{"sale_value":250,"sale_currency":"US"}'::jsonb);
  exception when others then refused:=sqlerrm like 'Currency must be%'; end;
  if not refused then raise exception 'Malformed currency passed'; end if;
  perform public.update_lead(fresh,'{"sale_value":250,"sale_currency":"usd"}'::jsonb);
  perform public.update_lead(fresh,'{"cash_collected":100,"cash_currency":"zar"}'::jsonb);
  select sale_value,sale_currency,cash_collected,cash_currency into v
    from public.client_leads where id=fresh;
  if v.sale_value<>250 or v.sale_currency<>'USD'
     or v.cash_collected<>100 or v.cash_currency<>'ZAR' then
    raise exception 'Separate sale and cash currencies were not saved'; end if;
  refused:=false;
  begin perform public.update_lead(fresh,'{"cash_currency":null}'::jsonb);
  exception when others then refused:=sqlerrm like 'Cash currency is required%'; end;
  if not refused then raise exception 'Positive cash lost its currency'; end if;
  refused:=false;
  begin perform public.update_lead(other,'{"sale_value":10,"sale_currency":"USD"}'::jsonb);
  exception when others then refused:=sqlerrm='Not permitted for this client'; end;
  if not refused then raise exception 'Other client lead was editable'; end if;

  -- Cash-bearing leads are not archivable. The sale-only legacy lead can be
  -- annotated, archived and recovered without losing its currency evidence.
  perform public.update_lead(legacy,'{"sale_currency":"EUR"}'::jsonb);
  perform public.update_lead(legacy,'{"cash_collected":null}'::jsonb);
  perform public.archive_lead(legacy,'currency fixture');
  if not exists (select 1 from public.archived_leads
                 where id=legacy and lead->>'sale_currency'='EUR') then
    raise exception 'Archive omitted sale currency'; end if;
  perform public.recover_lead(legacy);
  select sale_value,sale_currency,cash_collected,cash_currency into v
    from public.client_leads where id=legacy;
  if v.sale_value<>100 or v.sale_currency<>'EUR'
     or v.cash_collected is not null or v.cash_currency is not null then
    raise exception 'Recovery changed sale currency lineage'; end if;
end $checks$;
rollback;

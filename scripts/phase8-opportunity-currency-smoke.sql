-- New opportunity values need currency; old amounts remain unknown and recoverable.
begin;
insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
values ('a6170000-0000-4000-8000-000000000001','00000000-0000-0000-0000-000000000000',
  'authenticated','authenticated','opportunity-currency@example.invalid','',now(),now());
insert into public.profiles(id,role,email)
values ('a6170000-0000-4000-8000-000000000001','client','opportunity-currency@example.invalid');
insert into public.clients(id,name,initials) values
  ('b6170000-0000-4000-8000-000000000001','Opportunity currency one','O1'),
  ('b6170000-0000-4000-8000-000000000002','Opportunity currency two','O2');
insert into public.client_users(client_id,user_id)
values ('b6170000-0000-4000-8000-000000000001','a6170000-0000-4000-8000-000000000001');
select set_config('request.jwt.claim.role','service_role',true);
select set_config('request.jwt.claims','{"role":"service_role"}',true);
set local session_replication_role = replica;
insert into public.client_leads(id,client_id,name,stage,opportunity_value)
values ('c6170000-0000-4000-8000-000000000001',
  'b6170000-0000-4000-8000-000000000001','Historical amount','shown',500);
set local session_replication_role = origin;
insert into public.lead_identities(id,client_id)
values ('c6170000-0000-4000-8000-000000000001',
  'b6170000-0000-4000-8000-000000000001');
do $direct$
declare refused boolean:=false;
begin
  begin
    insert into public.client_leads(client_id,name,stage,opportunity_value)
    values('b6170000-0000-4000-8000-000000000001','Direct missing currency','shown',50);
  exception when check_violation then refused:=true; end;
  if not refused then raise exception 'Direct opportunity insert bypassed currency'; end if;
  insert into public.client_leads(client_id,name,stage,opportunity_value,opportunity_currency)
  values('b6170000-0000-4000-8000-000000000001','Direct EUR','shown',50,'EUR');
  refused:=false;
  begin update public.client_leads set opportunity_value=600
    where id='c6170000-0000-4000-8000-000000000001';
  exception when check_violation then refused:=true; end;
  if not refused then raise exception 'Direct legacy opportunity edit bypassed currency'; end if;
end $direct$;
set local role authenticated;
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claim.sub','a6170000-0000-4000-8000-000000000001',true);
select set_config('request.jwt.claims',
  '{"sub":"a6170000-0000-4000-8000-000000000001","role":"authenticated"}',true);
do $checks$
declare cid uuid:='b6170000-0000-4000-8000-000000000001';
  legacy uuid:='c6170000-0000-4000-8000-000000000001';
  created uuid; refused boolean; v record;
begin
  perform public.update_lead(legacy,'{"next_action":"Call"}'::jsonb);
  select opportunity_value,opportunity_currency into v from public.client_leads where id=legacy;
  if v.opportunity_value<>500 or v.opportunity_currency is not null then
    raise exception 'Unrelated edit invented opportunity currency'; end if;
  perform public.archive_lead(legacy,'historical opportunity fixture');
  perform public.recover_lead(legacy);
  select opportunity_value,opportunity_currency into v from public.client_leads where id=legacy;
  if v.opportunity_value<>500 or v.opportunity_currency is not null then
    raise exception 'Historical opportunity recovery invented currency'; end if;
  refused:=false;
  begin perform public.update_lead(legacy,'{"opportunity_value":600}'::jsonb);
  exception when others then refused:=sqlerrm like 'Opportunity currency is required%'; end;
  if not refused then raise exception 'Update without opportunity currency passed'; end if;
  refused:=false;
  begin perform public.update_lead(legacy,'{"opportunity_currency":"US"}'::jsonb);
  exception when others then refused:=sqlerrm like 'Currency must be%'; end;
  if not refused then raise exception 'Malformed opportunity currency passed'; end if;
  perform public.update_lead(legacy,'{"opportunity_value":600,"opportunity_currency":"usd"}'::jsonb);
  select opportunity_value,opportunity_currency into v from public.client_leads where id=legacy;
  if v.opportunity_value<>600 or v.opportunity_currency<>'USD' then
    raise exception 'Explicit opportunity currency was not saved'; end if;

  refused:=false;
  begin perform public.create_manual_lead(cid,'Old RPC',null,null,null,null,null,10);
  exception when check_violation then refused:=true; end;
  if not refused then raise exception 'Old manual RPC bypassed currency'; end if;
  refused:=false;
  begin perform public.create_manual_lead_with_currency(cid,'New missing',null,null,null,null,null,10,null);
  exception when others then refused:=sqlerrm like 'Opportunity currency is required%'; end;
  if not refused then raise exception 'New manual RPC accepted missing currency'; end if;
  created:=public.create_manual_lead_with_currency(cid,'New recorded',null,null,null,null,null,10,'eur');
  select opportunity_value,opportunity_currency into v from public.client_leads where id=created;
  if v.opportunity_value<>10 or v.opportunity_currency<>'EUR' then
    raise exception 'Manual opportunity currency was not saved'; end if;
  refused:=false;
  begin perform public.create_manual_lead_with_currency(
    'b6170000-0000-4000-8000-000000000002','Other client',null,null,null,null,null,10,'EUR');
  exception when others then refused:=sqlerrm='Not permitted for this client'; end;
  if not refused then raise exception 'Other-client manual opportunity passed'; end if;

  perform public.archive_lead(legacy,'opportunity fixture');
  if not exists(select 1 from public.archived_leads where id=legacy
    and lead->>'opportunity_currency'='USD') then
    raise exception 'Archive omitted opportunity currency'; end if;
  perform public.recover_lead(legacy);
  select opportunity_value,opportunity_currency into v from public.client_leads where id=legacy;
  if v.opportunity_value<>600 or v.opportunity_currency<>'USD' then
    raise exception 'Recovery changed opportunity currency'; end if;
end $checks$;
rollback;

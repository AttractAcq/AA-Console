-- Disposable rollback fixture: archived leads remain readable as historical
-- journeys, without crossing client boundaries or entering the live funnel.
begin;
insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
values ('a6210000-0000-4000-8000-000000000001','00000000-0000-0000-0000-000000000000',
  'authenticated','authenticated','archived-journey@example.invalid','',now(),now());
insert into public.profiles(id,role,email)
values ('a6210000-0000-4000-8000-000000000001','client','archived-journey@example.invalid');
insert into public.clients(id,name,initials) values
  ('b6210000-0000-4000-8000-000000000001','Archived journey one','AJ'),
  ('b6210000-0000-4000-8000-000000000002','Archived journey two','AX');
insert into public.client_users(client_id,user_id)
values ('b6210000-0000-4000-8000-000000000001','a6210000-0000-4000-8000-000000000001');
select set_config('request.jwt.claim.role','service_role',true);
select set_config('request.jwt.claims','{"role":"service_role"}',true);
insert into public.client_leads(id,client_id,name,stage,source_channel)
values
 ('c6210000-0000-4000-8000-000000000001','b6210000-0000-4000-8000-000000000001',
  'Archived source','shown','organic'),
 ('c6210000-0000-4000-8000-000000000002','b6210000-0000-4000-8000-000000000001',
  'Current source','shown','direct');
insert into public.lead_events(lead_id,client_id,kind,body,to_stage)
values ('c6210000-0000-4000-8000-000000000001',
  'b6210000-0000-4000-8000-000000000001','outcome','Qualified', 'shown');
set local role authenticated;
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claim.sub','a6210000-0000-4000-8000-000000000001',true);
select set_config('request.jwt.claims',
 '{"sub":"a6210000-0000-4000-8000-000000000001","role":"authenticated"}',true);
do $checks$
declare cid uuid:='b6210000-0000-4000-8000-000000000001';
  archived uuid:='c6210000-0000-4000-8000-000000000001';
  live uuid:='c6210000-0000-4000-8000-000000000002';
  v record; denied boolean:=false;
begin
  perform public.archive_lead(archived,'finished source');
  select * into v from public.lead_journey_trace_v10(cid,30,50)
    where lead_id=archived;
  if v.lead_id is distinct from archived or v.archived_at is null
    or v.source_channel is distinct from 'organic' or v.outcome_events<>1 then
    raise exception 'Archived lead journey was not preserved'; end if;
  select * into v from public.lead_journey_trace_v10(cid,30,50)
    where lead_id=live;
  if v.lead_id is distinct from live or v.archived_at is not null
    then raise exception 'Live journey was mislabeled archived'; end if;
  begin
    perform 1 from public.lead_journey_trace_v10(
      'b6210000-0000-4000-8000-000000000002',30,50);
  exception when insufficient_privilege then denied:=true; end;
  if not denied then raise exception 'Cross-client journey read was not denied'; end if;
end $checks$;
rollback;

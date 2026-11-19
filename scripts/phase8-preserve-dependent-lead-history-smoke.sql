-- The archive keeps completed dependent rows linked to the durable identity;
-- unfinished obligations block archive and a new write cannot target an
-- archived or wrong-client identity. Cash-positive archive remains held.
begin;
insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
values ('a6360000-0000-4000-8000-000000000001',
  '00000000-0000-0000-0000-000000000000',
  'authenticated','authenticated','dependent-history@example.invalid','',now(),now());
insert into public.profiles(id,role,email)
values ('a6360000-0000-4000-8000-000000000001','admin',
  'dependent-history@example.invalid');
insert into public.clients(id,name,initials)
values
 ('b6360000-0000-4000-8000-000000000001','Dependent history fixture','DH'),
 ('b6360000-0000-4000-8000-000000000002','Other client fixture','OC');
select set_config('request.jwt.claim.role','service_role',true);
select set_config('request.jwt.claims','{"role":"service_role"}',true);
select set_config('request.jwt.claim.sub',
 'a6360000-0000-4000-8000-000000000001',true);
insert into public.client_leads(id,client_id,name,stage,lost_reason)
values
 ('c6360000-0000-4000-8000-000000000001',
  'b6360000-0000-4000-8000-000000000001','Finished','cash',null),
 ('c6360000-0000-4000-8000-000000000002',
  'b6360000-0000-4000-8000-000000000001','Cash held','cash',null);
update public.client_leads set cash_collected=25,cash_currency='USD'
where id='c6360000-0000-4000-8000-000000000002';
insert into public.client_appointments
 (id,client_id,lead_id,starts_at,ends_at,status,booked_via)
values ('d6360000-0000-4000-8000-000000000001',
  'b6360000-0000-4000-8000-000000000001',
  'c6360000-0000-4000-8000-000000000001',now()+interval '1 day',
  now()+interval '1 day 1 hour','booked','person');
insert into public.dm_identities(id,client_id,platform,external_user_id,lead_id)
values ('e6360000-0000-4000-8000-000000000001',
  'b6360000-0000-4000-8000-000000000001','facebook','fixture-user',
  'c6360000-0000-4000-8000-000000000001');
insert into public.dm_conversations
 (id,client_id,identity_id,platform,lead_id,status)
values ('f6360000-0000-4000-8000-000000000001',
  'b6360000-0000-4000-8000-000000000001',
  'e6360000-0000-4000-8000-000000000001','facebook',
  'c6360000-0000-4000-8000-000000000001','open');
insert into public.workflow_runs
 (id,client_id,kind,workflow_version,idempotency_key,input_snapshot,
  deadline_at,status)
values ('a6360000-0000-4000-8000-000000000002',
  'b6360000-0000-4000-8000-000000000001','client_launch_package',
  'fixture-v1','dependent-history-fixture','{}',now()+interval '1 day',
  'completed');
insert into public.workflow_lead_attribution(run_id,lead_id,label,evidence)
values ('a6360000-0000-4000-8000-000000000002',
  'c6360000-0000-4000-8000-000000000001','unknown',
  '{"reason":"fixture attribution"}');
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claims',
 '{"sub":"a6360000-0000-4000-8000-000000000001","role":"authenticated"}',true);
insert into public.proof_service_outcomes_v7
 (id,client_id,lead_id,outcome_summary,occurred_at,evidence_source,
  evidence_note,recorded_by)
values ('a6360000-0000-4000-8000-000000000003',
  'b6360000-0000-4000-8000-000000000001',
  'c6360000-0000-4000-8000-000000000001',
  'Customer reported a completed outcome',now(),'fixture record',
  'Synthetic evidence for archive preservation',
  'a6360000-0000-4000-8000-000000000001');
select set_config('request.jwt.claim.role','service_role',true);
select set_config('request.jwt.claims','{"role":"service_role"}',true);
do $blocked$
declare refused boolean:=false;
begin
  begin
    perform public.archive_lead('c6360000-0000-4000-8000-000000000001',
      'Fixture');
  exception when check_violation then refused:=true; end;
  if not refused then raise exception 'Booked/open obligation did not block archive'; end if;
  refused:=false;
  begin
    perform public.archive_lead('c6360000-0000-4000-8000-000000000002',
      'Fixture');
  exception when others then
    if sqlerrm like '%cash collected%' then refused:=true; else raise; end if;
  end;
  if not refused then raise exception 'Positive cash guard was released'; end if;
end $blocked$;
update public.client_appointments set status='attended'
where id='d6360000-0000-4000-8000-000000000001';
update public.dm_conversations set status='closed'
where id='f6360000-0000-4000-8000-000000000001';
select public.archive_lead('c6360000-0000-4000-8000-000000000001',
 'Fixture finished');
do $archived$
declare refused boolean:=false;
begin
  if exists (select 1 from public.client_leads
      where id='c6360000-0000-4000-8000-000000000001') then
    raise exception 'Active lead remained after archive'; end if;
  if not exists (select 1 from public.client_appointments
      where id='d6360000-0000-4000-8000-000000000001'
        and lead_id='c6360000-0000-4000-8000-000000000001'
        and status='attended')
     or not exists (select 1 from public.dm_identities
      where id='e6360000-0000-4000-8000-000000000001'
        and lead_id='c6360000-0000-4000-8000-000000000001')
     or not exists (select 1 from public.dm_conversations
      where id='f6360000-0000-4000-8000-000000000001'
        and lead_id='c6360000-0000-4000-8000-000000000001')
     or not exists (select 1 from public.workflow_lead_attribution
      where run_id='a6360000-0000-4000-8000-000000000002'
        and lead_id='c6360000-0000-4000-8000-000000000001')
     or not exists (select 1 from public.proof_service_outcomes_v7
      where id='a6360000-0000-4000-8000-000000000003'
        and lead_id='c6360000-0000-4000-8000-000000000001') then
    raise exception 'Dependent historical record was lost or detached'; end if;
  begin
    insert into public.client_appointments
      (client_id,lead_id,starts_at,ends_at,booked_via)
    values ('b6360000-0000-4000-8000-000000000001',
      'c6360000-0000-4000-8000-000000000001',now()+interval '2 days',
      now()+interval '2 days 1 hour','person');
  exception when foreign_key_violation then refused:=true; end;
  if not refused then raise exception 'New appointment on archived identity succeeded'; end if;
  refused:=false;
  begin
    insert into public.dm_identities(client_id,platform,external_user_id,lead_id)
    values ('b6360000-0000-4000-8000-000000000002','facebook',
      'wrong-client-user','c6360000-0000-4000-8000-000000000001');
  exception when foreign_key_violation then refused:=true; end;
  if not refused then raise exception 'Cross-client lead reference succeeded'; end if;
end $archived$;
select public.recover_lead('c6360000-0000-4000-8000-000000000001');
do $recovered$
begin
  if not exists (select 1 from public.client_leads
      where id='c6360000-0000-4000-8000-000000000001')
     or not exists (select 1 from public.client_appointments
      where id='d6360000-0000-4000-8000-000000000001'
        and lead_id='c6360000-0000-4000-8000-000000000001')
     or not exists (select 1 from public.workflow_lead_attribution
      where run_id='a6360000-0000-4000-8000-000000000002'
        and lead_id='c6360000-0000-4000-8000-000000000001') then
    raise exception 'Recovery lost dependent history'; end if;
  if (select count(*) from pg_constraint
      where confrelid='public.lead_identities'::regclass
        and conname like '%identity_fkey_v11')<>12
     or (select count(*) from pg_trigger
      where tgfoid='public.guard_active_lead_reference_v11()'::regprocedure
        and not tgisinternal)<>12 then
    raise exception 'Dependent identity constraints or active guards missing'; end if;
end $recovered$;
rollback;

-- Campaign lead evidence remains recorded when a finished lead leaves the
-- operating pipeline. The fixture archives directly in a rollback transaction
-- because archive_lead still refuses positive cash.
begin;
insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
values ('a6340000-0000-4000-8000-000000000001',
  '00000000-0000-0000-0000-000000000000',
  'authenticated','authenticated','campaign-history@example.invalid','',now(),now());
insert into public.profiles(id,role,email)
values ('a6340000-0000-4000-8000-000000000001','admin',
  'campaign-history@example.invalid');
insert into public.clients(id,name,initials)
values ('b6340000-0000-4000-8000-000000000001','Campaign history fixture','CH');
select set_config('request.jwt.claim.role','service_role',true);
select set_config('request.jwt.claims','{"role":"service_role"}',true);
insert into public.client_campaigns(id,client_id,name,brief)
values ('d6340000-0000-4000-8000-000000000001',
  'b6340000-0000-4000-8000-000000000001','Campaign history','Fixture');
insert into public.client_leads
 (id,client_id,name,stage,source_client_campaign_id,cash_collected,
  cash_currency,consent_given_at,consent_wording)
values
 ('c6340000-0000-4000-8000-000000000001',
  'b6340000-0000-4000-8000-000000000001','Recorded','cash',
  'd6340000-0000-4000-8000-000000000001',75,'USD',now(),'Fixture consent'),
 ('c6340000-0000-4000-8000-000000000002',
  'b6340000-0000-4000-8000-000000000001','Probe','lead',
  'd6340000-0000-4000-8000-000000000001',null,null,null,null);
update public.client_leads set is_probe=true
where id='c6340000-0000-4000-8000-000000000002';
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claim.sub',
 'a6340000-0000-4000-8000-000000000001',true);
select set_config('request.jwt.claims',
 '{"sub":"a6340000-0000-4000-8000-000000000001","role":"authenticated"}',true);
do $before$
declare evidence bigint;
begin
  select leads_attributed into evidence from public.campaign_live_evidence
    where campaign_id='d6340000-0000-4000-8000-000000000001';
  if evidence<>1 then raise exception 'Initial campaign evidence is wrong'; end if;
end $before$;
select set_config('request.jwt.claim.role','service_role',true);
select set_config('request.jwt.claims','{"role":"service_role"}',true);
insert into public.archived_leads(id,client_id,name,stage_at_archive,lead,events,reason)
select id,client_id,name,stage,to_jsonb(l),'[]'::jsonb,'fixture'
from public.client_leads l
where id='c6340000-0000-4000-8000-000000000001';
delete from public.client_leads
where id='c6340000-0000-4000-8000-000000000001';
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claim.sub',
 'a6340000-0000-4000-8000-000000000001',true);
select set_config('request.jwt.claims',
 '{"sub":"a6340000-0000-4000-8000-000000000001","role":"authenticated"}',true);
do $archived$
declare evidence bigint;
begin
  select leads_attributed into evidence from public.campaign_live_evidence
    where campaign_id='d6340000-0000-4000-8000-000000000001';
  if evidence<>1 then raise exception 'Campaign lead vanished after archive'; end if;
  if (select count(*) from public.client_leads
      where source_client_campaign_id='d6340000-0000-4000-8000-000000000001'
      and not is_probe)<>0 then
    raise exception 'Archived lead remained operational';
  end if;
  if public.campaign_recorded_lead_count_v11(
      'b6340000-0000-4000-8000-000000000001',
      'd6340000-0000-4000-8000-000000000002')<>0 then
    raise exception 'Wrong campaign count leaked';
  end if;
  perform set_config('request.jwt.claim.sub',
    'f6340000-0000-4000-8000-000000000001',true);
  perform set_config('request.jwt.claims',
    '{"sub":"f6340000-0000-4000-8000-000000000001","role":"authenticated"}',true);
  if public.campaign_recorded_lead_count_v11(
      'b6340000-0000-4000-8000-000000000001',
      'd6340000-0000-4000-8000-000000000001')<>0 then
    raise exception 'Unauthorized count leaked';
  end if;
end $archived$;
select set_config('request.jwt.claim.role','service_role',true);
select set_config('request.jwt.claims','{"role":"service_role"}',true);
select set_config('request.jwt.claim.sub',
 'a6340000-0000-4000-8000-000000000001',true);
select public.recover_lead('c6340000-0000-4000-8000-000000000001');
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claim.sub',
 'a6340000-0000-4000-8000-000000000001',true);
select set_config('request.jwt.claims',
 '{"sub":"a6340000-0000-4000-8000-000000000001","role":"authenticated"}',true);
do $recovered$
declare evidence bigint;
begin
  select leads_attributed into evidence from public.campaign_live_evidence
    where campaign_id='d6340000-0000-4000-8000-000000000001';
  if evidence<>1 then raise exception 'Campaign evidence changed after recovery'; end if;
end $recovered$;
rollback;

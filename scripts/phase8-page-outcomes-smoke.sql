begin;
insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
values ('a8899999-9999-4999-8999-999999999999','00000000-0000-0000-0000-000000000000',
  'authenticated','authenticated','page-outcomes@example.invalid','',now(),now());
insert into public.profiles(id,role,email) values
  ('a8899999-9999-4999-8999-999999999999','admin','page-outcomes@example.invalid');
insert into public.clients(id,name,initials) values
  ('b8899999-9999-4999-8999-999999999999','Page outcomes fixture','PO');
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claim.sub','a8899999-9999-4999-8999-999999999999',true);
select set_config('request.jwt.claims',
  '{"sub":"a8899999-9999-4999-8999-999999999999","role":"authenticated","aal":"aal2"}',true);
insert into public.client_pages(id,client_id,page_type,title,brief,status)
values ('c8899999-9999-4999-8999-999999999999',
  'b8899999-9999-4999-8999-999999999999','landing','Fixture page','Fixture brief','draft');
insert into public.client_leads(client_id,name,source_page_id,stage,
  consent_given_at,consent_wording,sale_value,cash_collected)
values ('b8899999-9999-4999-8999-999999999999','Recorded lead',
  'c8899999-9999-4999-8999-999999999999','cash',now(),'I agree',1200,1200),
  ('b8899999-9999-4999-8999-999999999999','Probe lead',
  'c8899999-9999-4999-8999-999999999999','cash',now(),'I agree',900,900),
  ('b8899999-9999-4999-8999-999999999999','Shown appointment',
  'c8899999-9999-4999-8999-999999999999','shown',now(),'I agree',0,0),
  ('b8899999-9999-4999-8999-999999999999','Shown with recorded sale',
  'c8899999-9999-4999-8999-999999999999','shown',now(),'I agree',500,0),
  ('b8899999-9999-4999-8999-999999999999','Shown with collected cash',
  'c8899999-9999-4999-8999-999999999999','shown',now(),'I agree',0,150);
update public.client_leads set is_probe=true where name='Probe lead';
do $checks$
declare cid uuid:='b8899999-9999-4999-8999-999999999999';
  v record; refused boolean:=false;
begin
  select * into v from public.page_recorded_outcomes_v8(cid,'landing',30);
  if v.recorded_leads<>4 or v.consented_leads<>4 or v.recorded_sales<>3
    or v.recorded_cash<>1350 or v.latest_lead_at is null then
    raise exception 'Page outcome aggregation or probe exclusion failed';
  end if;
  update public.client_pages set archived_at=now() where id=v.page_id;
  select * into v from public.page_recorded_outcomes_v8(cid,'landing',30);
  if v.archived_at is null or v.recorded_leads<>4 then
    raise exception 'Archived page outcome disappeared'; end if;
  perform set_config('request.jwt.claim.sub','f8899999-9999-4999-8999-999999999999',true);
  perform set_config('request.jwt.claims',
    '{"sub":"f8899999-9999-4999-8999-999999999999","role":"authenticated"}',true);
  begin perform public.page_recorded_outcomes_v8(cid,'landing',30);
  exception when insufficient_privilege then refused:=true; end;
  if not refused then raise exception 'Other user read page outcomes'; end if;
end $checks$;
rollback;

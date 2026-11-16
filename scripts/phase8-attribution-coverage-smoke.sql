begin;
insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
values ('a4444444-4444-4444-8444-444444444444','00000000-0000-0000-0000-000000000000',
  'authenticated','authenticated','coverage-admin@example.invalid','',now(),now());
insert into public.profiles(id,role,email) values
  ('a4444444-4444-4444-8444-444444444444','admin','coverage-admin@example.invalid');
insert into public.clients(id,name,initials) values
  ('b4444444-4444-4444-8444-444444444444','Coverage fixture','CF');
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claim.sub','a4444444-4444-4444-8444-444444444444',true);
select set_config('request.jwt.claims',
  '{"sub":"a4444444-4444-4444-8444-444444444444","role":"authenticated","aal":"aal2"}',true);
do $checks$
declare cid uuid:='b4444444-4444-4444-8444-444444444444';
  v record; refused boolean:=false;
begin
  select * into v from public.acquisition_coverage_v8(cid,30);
  if v.lead_rows<>0 or v.sourced_leads<>0 or v.spend_rows<>0
    or v.spend_currency is not null or v.latest_meta_read_at is not null then
    raise exception 'Missing attribution data was not represented as missing'; end if;
  insert into public.client_leads(client_id,name,source_channel,consent_given_at,consent_wording)
    values(cid,'Sourced lead','website',now(),'I agree to be contacted');
  insert into public.client_leads(client_id,name) values(cid,'Unknown source');
  insert into public.client_marketing_spend(client_id,spent_on,amount,currency,source)
    values(cid,current_date,25,'ZAR','manual'),
      (cid,current_date,3,'USD','manual');
  select * into v from public.acquisition_coverage_v8(cid,30);
  if v.lead_rows<>2 or v.sourced_leads<>1 or v.consented_leads<>1
    or v.spend_rows<>2 or v.spend_currencies<>2 or v.spend_currency is not null
    or v.latest_spend_date<>current_date then
    raise exception 'Coverage counts or mixed currency classification were wrong'; end if;
  perform set_config('request.jwt.claim.sub','f4444444-4444-4444-8444-444444444444',true);
  perform set_config('request.jwt.claims',
    '{"sub":"f4444444-4444-4444-8444-444444444444","role":"authenticated"}',true);
  begin perform public.acquisition_coverage_v8(cid,30);
  exception when insufficient_privilege then refused:=true; end;
  if not refused then raise exception 'Unauthorized user read attribution coverage'; end if;
end $checks$;
rollback;

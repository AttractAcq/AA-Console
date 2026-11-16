-- Rollback-only exact activation of booking and one public lead-capture door.
begin;
insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','00000000-0000-0000-0000-000000000000',
 'authenticated','authenticated','booking-admin@example.invalid','',now(),now());
insert into public.profiles(id,role,email) values
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','admin','booking-admin@example.invalid');
insert into public.clients(id,name,initials) values
 ('dddddddd-dddd-4ddd-8ddd-dddddddddddd','Booking fixture','BF'),
 ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee','Other booking fixture','OB');
select set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true);
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claims',
 '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal1"}',true);
do $checks$
declare cid uuid:='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
 endpoint_id uuid; request_id uuid; review_id uuid;
begin
 perform public.set_client_booking_settings_v6(cid,'Europe/Monaco',30,10,24,30,5);
 perform public.replace_client_booking_windows_v6(cid,
  '[{"day_of_week":1,"starts_at_minute":540,"ends_at_minute":720}]'::jsonb);
 begin
  perform public.set_client_booking_enabled_v6(cid,true);
  raise exception 'Direct booking enable succeeded';
 exception when insufficient_privilege then null; end;
 request_id:=public.request_client_switch_activation_v6(cid,'booking');
 select id into review_id from public.client_switch_activation_reviews_v6
  where canonical_request_id=request_id;
 if public.request_client_switch_activation_v6(cid,'booking')<>request_id
  or (select status from public.approval_inbox_v6 where id=request_id)<>'pending' then
  raise exception 'Booking review did not deduplicate'; end if;
 begin
  perform public.decide_client_switch_activation_v6(review_id,request_id,true);
  raise exception 'AAL1 enabled booking';
 exception when insufficient_privilege then null; end;
 perform public.replace_client_booking_windows_v6(cid,
  '[{"day_of_week":1,"starts_at_minute":600,"ends_at_minute":720}]'::jsonb);
 perform public.replace_client_booking_windows_v6(cid,
  '[{"day_of_week":1,"starts_at_minute":540,"ends_at_minute":720}]'::jsonb);
 if public.client_switch_activation_source_state_v6(request_id)<>'superseded' then
  raise exception 'Reverted booking hours revived old review'; end if;
 perform set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal2"}',true);
 begin
  perform public.decide_client_switch_activation_v6(review_id,request_id,true);
  raise exception 'Stale booking review enabled booking';
 exception when check_violation then null; end;
 request_id:=public.request_client_switch_activation_v6(cid,'booking');
 select id into review_id from public.client_switch_activation_reviews_v6
  where canonical_request_id=request_id;
 perform public.decide_client_switch_activation_v6(review_id,request_id,true);
 if (select enabled from public.client_booking_settings where client_id=cid) is not true
  or public.client_switch_activation_source_state_v6(request_id)<>'source_decided' then
  raise exception 'Exact booking review did not enable booking'; end if;
 begin
  perform public.replace_client_booking_windows_v6(cid,
   '[{"day_of_week":2,"starts_at_minute":540,"ends_at_minute":720}]'::jsonb);
  raise exception 'Live booking hours changed without reapproval';
 exception when insufficient_privilege then null; end;
 perform public.set_client_booking_enabled_v6(cid,false);
 if (select enabled from public.client_booking_settings where client_id=cid) is not false then
  raise exception 'Booking did not switch off immediately'; end if;

 select id into endpoint_id from public.create_lead_capture_endpoint_v6(cid,
  'page_form',repeat('a',64),'I agree to be contacted about this enquiry');
 begin
  perform public.set_lead_capture_enabled_v6(endpoint_id,true);
  raise exception 'Direct intake enable succeeded';
 exception when insufficient_privilege then null; end;
 request_id:=public.request_lead_capture_activation_v6(endpoint_id);
 select id into review_id from public.client_switch_activation_reviews_v6
  where canonical_request_id=request_id;
 if public.request_lead_capture_activation_v6(endpoint_id)<>request_id
  or (select status from public.approval_inbox_v6 where id=request_id)<>'pending' then
  raise exception 'Intake review did not deduplicate'; end if;
 update public.lead_capture_endpoints set consent_wording='Changed consent'
  where id=endpoint_id;
 update public.lead_capture_endpoints
  set consent_wording='I agree to be contacted about this enquiry' where id=endpoint_id;
 if public.client_switch_activation_source_state_v6(request_id)<>'superseded' then
  raise exception 'Reverted endpoint consent revived old review'; end if;
 request_id:=public.request_lead_capture_activation_v6(endpoint_id);
 select id into review_id from public.client_switch_activation_reviews_v6
  where canonical_request_id=request_id;
 perform public.decide_client_switch_activation_v6(review_id,request_id,true);
 if (select enabled from public.lead_capture_endpoints where id=endpoint_id) is not true
  or public.client_switch_activation_source_state_v6(request_id)<>'source_decided' then
  raise exception 'Exact intake review did not enable endpoint'; end if;
 begin
  update public.lead_capture_endpoints set consent_wording='Changed while live'
   where id=endpoint_id;
  raise exception 'Live intake consent changed without reapproval';
 exception when insufficient_privilege then null; end;
 perform public.set_lead_capture_enabled_v6(endpoint_id,false);
 if (select enabled from public.lead_capture_endpoints where id=endpoint_id) is not false then
  raise exception 'Intake endpoint did not switch off immediately'; end if;
end $checks$;
rollback;

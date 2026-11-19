-- Disposable, rollback-only Business Profile performance boundary fixture.
begin;
insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
values ('a3333333-3333-4333-8333-333333333333','00000000-0000-0000-0000-000000000000',
  'authenticated','authenticated','profile-metrics-admin@example.invalid','',now(),now()),
  ('c3333333-3333-4333-8333-333333333333','00000000-0000-0000-0000-000000000000',
  'authenticated','authenticated','other-profile@example.invalid','',now(),now());
insert into public.profiles(id,role,email) values
  ('a3333333-3333-4333-8333-333333333333','admin','profile-metrics-admin@example.invalid'),
  ('c3333333-3333-4333-8333-333333333333','client','other-profile@example.invalid');
insert into public.clients(id,name,initials) values
  ('b3333333-3333-4333-8333-333333333333','Profile metrics fixture','PM'),
  ('d3333333-3333-4333-8333-333333333333','Other profile fixture','OP');
insert into public.client_users(client_id,user_id) values
  ('d3333333-3333-4333-8333-333333333333',
   'c3333333-3333-4333-8333-333333333333');
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claim.sub','a3333333-3333-4333-8333-333333333333',true);
select set_config('request.jwt.claims',
  '{"sub":"a3333333-3333-4333-8333-333333333333","role":"authenticated","aal":"aal2"}',true);

do $checks$
declare cid uuid:='b3333333-3333-4333-8333-333333333333';
  loc uuid; integration_id uuid; credential_id uuid; request_id uuid;
  review_id uuid; job_id uuid; v_run_id uuid; refused boolean:=false;
  points jsonb:=jsonb_build_array(jsonb_build_object('metric','WEBSITE_CLICKS',
    'day',(current_date-1)::text,'value','4'));
begin
  insert into public.client_google_locations
    (client_id,location_ref,title,verification_state)
  values(cid,'accounts/123/locations/456','Main office','verified') returning id into loc;
  integration_id:=public.admin_store_integration_credential(
    cid,'google_business','Business Profile fixture','fixture-oauth-token','read');
  select credential_secret_id into credential_id from public.client_integrations
    where id=integration_id;
  begin
    perform public.request_google_profile_performance_read_v8(loc);
  exception when check_violation then refused:=true; end;
  if not refused then raise exception 'Unapproved integration queued a provider read'; end if;
  refused:=false;
  request_id:=public.request_integration_grant_v6(integration_id,false);
  select id into review_id from public.integration_grant_reviews_v6
    where canonical_request_id=request_id;
  perform public.decide_integration_grant_v6(review_id,request_id,true);
  job_id:=public.request_google_profile_performance_read_v8(loc);
  if job_id is null or job_id<>public.request_google_profile_performance_read_v8(loc) then
    raise exception 'Exact location read was not deduplicated'; end if;
  perform set_config('request.jwt.claim.role','service_role',true);
  perform set_config('request.jwt.claims','{"role":"service_role"}',true);
  begin
    perform public.record_google_profile_performance_read_v8(
      'd3333333-3333-4333-8333-333333333333',loc,integration_id,credential_id,
      job_id,'accounts/123/locations/456',current_date-29,current_date,
      array['WEBSITE_CLICKS'],points);
  exception when check_violation then refused:=true; end;
  if not refused then raise exception 'Cross-client metric read was recorded'; end if;
  refused:=false;
  begin
    perform public.record_google_profile_performance_read_v8(
      cid,loc,integration_id,'f3333333-3333-4333-8333-333333333333',
      job_id,'accounts/123/locations/456',current_date-29,current_date,
      array['WEBSITE_CLICKS'],points);
  exception when check_violation then refused:=true; end;
  if not refused then raise exception 'Wrong credential generation was recorded'; end if;
  refused:=false;
  begin
    perform public.record_google_profile_performance_read_v8(
      cid,loc,integration_id,credential_id,job_id,'accounts/123/locations/999',
      current_date-29,current_date,array['WEBSITE_CLICKS'],points);
  exception when check_violation then refused:=true; end;
  if not refused then raise exception 'Wrong location was recorded'; end if;
  refused:=false;
  begin
    perform public.record_google_profile_performance_read_v8(
      cid,loc,integration_id,credential_id,job_id,'accounts/123/locations/456',
      current_date-29,current_date,array['CALL_CLICKS'],points);
  exception when check_violation then refused:=true; end;
  if not refused then raise exception 'Unobserved metric point was recorded'; end if;
  refused:=false;
  v_run_id:=public.record_google_profile_performance_read_v8(
    cid,loc,integration_id,credential_id,job_id,'accounts/123/locations/456',
    current_date-29,current_date,array['WEBSITE_CLICKS'],
    jsonb_build_array(jsonb_build_object('metric','WEBSITE_CLICKS',
      'day',(current_date-1)::text,'value','4')));
  if not exists(select 1 from public.google_profile_performance_points_v8
    where run_id=v_run_id and client_id=cid and metric='WEBSITE_CLICKS'
      and day=current_date-1 and value=4) then
    raise exception 'Exact dated provider value was not stored'; end if;
  if not exists(select 1 from public.google_profile_performance_current_v8
    where id=v_run_id and client_id=cid and location_id=loc) then
    raise exception 'Current configured account did not expose its read'; end if;
  begin
    perform public.record_google_profile_performance_read_v8(
      cid,loc,integration_id,credential_id,job_id,'accounts/123/locations/456',
      current_date-29,current_date,array['WEBSITE_CLICKS'],'[]'::jsonb);
  exception when unique_violation then refused:=true; end;
  if not refused then raise exception 'Duplicate job recorded a second provider snapshot'; end if;
  update public.client_google_locations
    set location_ref='accounts/123/locations/457' where id=loc;
  if exists(select 1 from public.google_profile_performance_current_v8
    where id=v_run_id) then
    raise exception 'Old location snapshot remained current'; end if;
end $checks$;

set local role authenticated;
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claim.sub','c3333333-3333-4333-8333-333333333333',true);
select set_config('request.jwt.claims',
  '{"sub":"c3333333-3333-4333-8333-333333333333","role":"authenticated","aal":"aal1"}',true);
do $scope$
begin
  if exists(select 1 from public.google_profile_performance_current_v8) or
    exists(select 1 from public.google_profile_performance_points_v8) then
    raise exception 'Other-client metric observation crossed RLS boundary'; end if;
end $scope$;
rollback;

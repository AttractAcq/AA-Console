begin;
insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
values ('a8888888-8888-4888-8888-888888888888','00000000-0000-0000-0000-000000000000',
  'authenticated','authenticated','route-admin@example.invalid','',now(),now());
insert into public.profiles(id,role,email) values
  ('a8888888-8888-4888-8888-888888888888','admin','route-admin@example.invalid');
insert into public.clients(id,name,initials) values
  ('b8888888-8888-4888-8888-888888888888','Route fixture','RF');
select set_config('request.jwt.claim.role','service_role',true);
select set_config('request.jwt.claims','{"role":"service_role"}',true);
do $checks$
declare cid uuid:='b8888888-8888-4888-8888-888888888888';
  campaign_id uuid; page_id uuid; route_id uuid; endpoint_id uuid;
  v_lead_id uuid; v record; refused boolean;
begin
  insert into public.client_campaigns(client_id,name,brief,acquisition_mode,runs_organic)
    values(cid,'Exact route campaign','Disposable', 'organic',true)
    returning id into campaign_id;
  insert into public.client_pages(client_id,page_type,title)
    values(cid,'landing','Route page') returning id into page_id;
  insert into public.campaign_artifacts(client_id,campaign_id,kind,page_id)
    values(cid,campaign_id,'landing_page',page_id);
  insert into public.campaign_route_packages_v6
    (client_id,campaign_id,route,version,plan_fingerprint)
    select cid,campaign_id,'organic',1,public.campaign_plan_fingerprint(c)
      from public.client_campaigns c where c.id=campaign_id
    returning id into route_id;
  refused:=false;
  begin
    perform public.create_route_lead_capture_endpoint_v9(
      cid,repeat('b',64),'I agree to be contacted',campaign_id,page_id,
      'organic',gen_random_uuid());
  exception when check_violation then refused:=true; end;
  if not refused then raise exception 'Wrong route was accepted'; end if;
  select id into endpoint_id from public.create_route_lead_capture_endpoint_v9(
    cid,repeat('a',64),'I agree to be contacted',campaign_id,page_id,
    'organic',route_id);
  if (select route_package_id from public.lead_capture_endpoints where id=endpoint_id)
    is distinct from route_id then raise exception 'Route binding missing'; end if;
  refused:=false;
  begin
    update public.lead_capture_endpoints set route_package_id=null where id=endpoint_id;
  exception when check_violation then refused:=true; end;
  if not refused then raise exception 'Route retarget was accepted'; end if;
  insert into public.client_leads(client_id,name,source_client_campaign_id)
    values(cid,'Captured route lead',campaign_id) returning id into v_lead_id;
  insert into public.lead_submissions
    (client_id,endpoint_id,email,consent_wording,consent_given_at,
     idempotency_key,status,lead_id)
    values(cid,endpoint_id,'route@example.invalid','I agree to be contacted',now(),
      'route-one','promoted',v_lead_id);
  if (select route_package_id from public.lead_submissions where idempotency_key='route-one')
    is distinct from route_id then raise exception 'Submission route snapshot missing'; end if;
  refused:=false;
  begin
    update public.lead_submissions set route_package_id=null where idempotency_key='route-one';
  exception when check_violation then refused:=true; end;
  if not refused then raise exception 'Submission route rewrite was accepted'; end if;
  perform set_config('request.jwt.claim.role','authenticated',true);
  perform set_config('request.jwt.claim.sub','a8888888-8888-4888-8888-888888888888',true);
  perform set_config('request.jwt.claims',
    '{"sub":"a8888888-8888-4888-8888-888888888888","role":"authenticated"}',true);
  select * into v from public.lead_journey_trace_v9(cid,30,50) j
    where j.lead_id=v_lead_id;
  if v.route_package_ids is distinct from array[route_id]
     or v.capture_submissions<>1 or v.unknown_route_submissions<>0 then
    raise exception 'Exact capture route was not traceable'; end if;
  perform set_config('request.jwt.claim.sub','f8888888-8888-4888-8888-888888888888',true);
  perform set_config('request.jwt.claims',
    '{"sub":"f8888888-8888-4888-8888-888888888888","role":"authenticated"}',true);
  refused:=false;
  begin perform public.lead_journey_trace_v9(cid,30,50);
  exception when insufficient_privilege then refused:=true; end;
  if not refused then raise exception 'Unauthorized trace was accepted'; end if;
end $checks$;
rollback;

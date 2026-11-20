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
  stale_endpoint_id uuid; route_free_endpoint_id uuid;
  v_lead_id uuid; request_id uuid; review_id uuid;
  result jsonb; v record; refused boolean;
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
  -- The actual public capture route remains held until the exact human AAL2
  -- activation decision. Exercise that gate before posting a lead.
  perform set_config('request.jwt.claim.role','authenticated',true);
  perform set_config('request.jwt.claim.sub','a8888888-8888-4888-8888-888888888888',true);
  perform set_config('request.jwt.claims',
    '{"sub":"a8888888-8888-4888-8888-888888888888","role":"authenticated","aal":"aal1"}',true);
  refused:=false;
  begin perform public.set_lead_capture_enabled_v6(endpoint_id,true);
  exception when insufficient_privilege then refused:=true; end;
  if not refused then raise exception 'Direct capture activation was accepted'; end if;
  request_id:=public.request_lead_capture_activation_v6(endpoint_id);
  select id into review_id from public.client_switch_activation_reviews_v6
    where canonical_request_id=request_id;
  refused:=false;
  begin perform public.decide_client_switch_activation_v6(review_id,request_id,true);
  exception when insufficient_privilege then refused:=true; end;
  if not refused then raise exception 'AAL1 capture activation was accepted'; end if;
  perform set_config('request.jwt.claims',
    '{"sub":"a8888888-8888-4888-8888-888888888888","role":"authenticated","aal":"aal2"}',true);
  perform public.decide_client_switch_activation_v6(review_id,request_id,true);
  if (select enabled from public.lead_capture_endpoints where id=endpoint_id) is not true
    then raise exception 'Approved capture did not enable endpoint'; end if;

  perform set_config('request.jwt.claim.role','service_role',true);
  perform set_config('request.jwt.claim.sub','',true);
  perform set_config('request.jwt.claims','{"role":"service_role"}',true);
  result:=public.capture_lead_v6(repeat('a',64),'no-consent',
    p_email=>'route@example.invalid',p_consented=>false);
  if coalesce((result->>'ok')::boolean,true) or
    exists(select 1 from public.lead_submissions where client_id=cid) then
    raise exception 'Unconsented capture was accepted'; end if;
  result:=public.capture_lead_v6(repeat('a',64),'route-one',
    p_name=>'Captured route lead',p_email=>'route@example.invalid',
    p_consented=>true,p_click_id=>'click-1',
    p_utm=>'{"utm_source":"fixture"}'::jsonb);
  if result->>'ok'<>'true' or result->>'created'<>'true' then
    raise exception 'First route capture failed: %',result; end if;
  v_lead_id:=(result->>'lead_id')::uuid;
  result:=public.capture_lead_v6(repeat('a',64),'route-one',
    p_email=>'route@example.invalid',p_consented=>true);
  if result->>'repeat'<>'true' or (result->>'lead_id')::uuid is distinct from v_lead_id
    then raise exception 'Idempotent capture replay changed the lead'; end if;
  result:=public.capture_lead_v6(repeat('a',64),'route-two',
    p_email=>'route@example.invalid',p_consented=>true);
  if result->>'created'<>'false' or (result->>'lead_id')::uuid is distinct from v_lead_id
    then raise exception 'Returning capture duplicated the lead'; end if;
  if (select count(*) from public.lead_submissions where client_id=cid)<>2
     or (select source_click_id from public.client_leads where id=v_lead_id)<>'click-1'
     or (select source_utm->>'utm_source' from public.client_leads where id=v_lead_id)<>'fixture'
     or (select source_client_campaign_id from public.client_leads where id=v_lead_id)
        is distinct from campaign_id then
    raise exception 'Capture source, consent or deduplication lost evidence'; end if;
  if (select route_package_id from public.lead_submissions where idempotency_key='route-one')
    is distinct from route_id then raise exception 'Submission route snapshot missing'; end if;
  refused:=false;
  begin
    update public.lead_submissions set route_package_id=null where idempotency_key='route-one';
  exception when check_violation then refused:=true; end;
  if not refused then raise exception 'Submission route rewrite was accepted'; end if;

  -- A route that was current when the endpoint was made must be rechecked
  -- when a human later approves activation. A generic campaign form cannot
  -- bypass the exact route by using the old endpoint creator.
  select id into stale_endpoint_id from public.create_route_lead_capture_endpoint_v9(
    cid,repeat('c',64),'I agree to be contacted',campaign_id,page_id,
    'organic',route_id);
  select id into route_free_endpoint_id from public.create_lead_capture_endpoint_v6(
    cid,'page_form',repeat('d',64),'I agree to be contacted',campaign_id,page_id,'organic');
  update public.client_campaigns set core_message='Replanned after form creation' where id=campaign_id;
  perform set_config('request.jwt.claim.role','authenticated',true);
  perform set_config('request.jwt.claim.sub','a8888888-8888-4888-8888-888888888888',true);
  perform set_config('request.jwt.claims',
    '{"sub":"a8888888-8888-4888-8888-888888888888","role":"authenticated","aal":"aal2"}',true);
  request_id:=public.request_lead_capture_activation_v6(stale_endpoint_id);
  select id into review_id from public.client_switch_activation_reviews_v6
    where canonical_request_id=request_id;
  refused:=false;
  begin perform public.decide_client_switch_activation_v6(review_id,request_id,true);
  exception when check_violation then refused:=true; end;
  if not refused or (select enabled from public.lead_capture_endpoints where id=stale_endpoint_id)
      then raise exception 'Replanned route endpoint was activated'; end if;
  request_id:=public.request_lead_capture_activation_v6(route_free_endpoint_id);
  select id into review_id from public.client_switch_activation_reviews_v6
    where canonical_request_id=request_id;
  refused:=false;
  begin perform public.decide_client_switch_activation_v6(review_id,request_id,true);
  exception when check_violation then refused:=true; end;
  if not refused or (select enabled from public.lead_capture_endpoints where id=route_free_endpoint_id)
      then raise exception 'Route-free campaign endpoint was activated'; end if;
  perform public.advance_lead(v_lead_id,'shown');
  perform public.advance_lead(v_lead_id,'cash');
  perform public.update_lead(v_lead_id,'{"sale_value":12000,"sale_currency":"ZAR","cash_collected":9000,"cash_currency":"ZAR"}'::jsonb);
  perform public.set_client_archive_v8(cid,'client_campaigns',campaign_id,true);
  perform public.set_client_archive_v8(cid,'client_pages',page_id,true);
  select * into v from public.lead_journey_trace_v9(cid,30,50) j
    where j.lead_id=v_lead_id;
  if v.route_package_ids is distinct from array[route_id]
     or v.capture_submissions<>2 or v.unknown_route_submissions<>0
     or v.campaign_name<>'Exact route campaign' or v.page_title<>'Route page'
     or v.lead_stage<>'cash' or v.sale_value<>12000 or v.cash_collected<>9000 then
    raise exception 'Archived route capture to cash was not traceable'; end if;
  perform set_config('request.jwt.claim.sub','f8888888-8888-4888-8888-888888888888',true);
  perform set_config('request.jwt.claims',
    '{"sub":"f8888888-8888-4888-8888-888888888888","role":"authenticated"}',true);
  refused:=false;
  begin perform public.lead_journey_trace_v9(cid,30,50);
  exception when insufficient_privilege then refused:=true; end;
  if not refused then raise exception 'Unauthorized trace was accepted'; end if;
end $checks$;
rollback;

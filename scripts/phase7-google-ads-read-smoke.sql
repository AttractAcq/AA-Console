-- Provider-specific Google observations stay behind exact account and
-- integration-grant gates. The fixture never calls a provider.
begin;
insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
values ('a2222222-2222-4222-8222-222222222222','00000000-0000-0000-0000-000000000000',
  'authenticated','authenticated','google-read-admin@example.invalid','',now(),now());
insert into public.profiles(id,role,email) values
  ('a2222222-2222-4222-8222-222222222222','admin','google-read-admin@example.invalid');
insert into public.clients(id,name,initials) values
  ('b2222222-2222-4222-8222-222222222222','Google read fixture','GR'),
  ('d2222222-2222-4222-8222-222222222222','Other Google fixture','OG');
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claim.sub','a2222222-2222-4222-8222-222222222222',true);
select set_config('request.jwt.claims',
  '{"sub":"a2222222-2222-4222-8222-222222222222","role":"authenticated","aal":"aal2"}',true);

do $checks$
declare cid uuid:='b2222222-2222-4222-8222-222222222222';
  integration_id uuid; credential_id uuid; request_id uuid; review_id uuid; job_id uuid;
  v_run_id uuid; refused boolean:=false;
  campaign_rows jsonb:='[{"id":"42","name":"Lead search","status":"ENABLED",
    "channel":"SEARCH","impressions":"100","clicks":"8",
    "cost_micros":"1230000","conversions":"1.25"}]'::jsonb;
  ad_rows jsonb:='[{"resource_name":"customers/1234567890/adGroupAds/7~9",
    "campaign_id":"42","ad_group_id":"7","ad_id":"9","status":"ENABLED",
    "ad_type":"RESPONSIVE_SEARCH_AD","final_urls":["https://example.com"],
    "headlines":["A headline"],"descriptions":["A description"],
    "impressions":"50","clicks":"4","cost_micros":"600000","conversions":"1"}]'::jsonb;
begin
  integration_id:=public.admin_store_integration_credential(
    cid,'google_ads','Google Ads fixture','fixture-oauth-token','read');
  update public.client_integrations set google_ads_customer_id='1234567890'
    where id=integration_id;
  select credential_secret_id into credential_id from public.client_integrations
    where id=integration_id;
  perform set_config('request.jwt.claim.role','service_role',true);
  perform set_config('request.jwt.claims','{"role":"service_role"}',true);
  insert into public.agent_jobs(agent_key,client_id)
    values('google_ads_read',cid) returning id into job_id;
  begin
    perform public.record_google_ads_full_read_v7(cid,integration_id,credential_id,job_id,
      '1234567890','USD',current_date-29,current_date,'req-a',campaign_rows,ad_rows);
  exception when check_violation then refused:=true; end;
  if not refused then raise exception 'Unapproved Google integration recorded a read'; end if;
  refused:=false;
  perform set_config('request.jwt.claim.role','authenticated',true);
  perform set_config('request.jwt.claim.sub','a2222222-2222-4222-8222-222222222222',true);
  perform set_config('request.jwt.claims',
    '{"sub":"a2222222-2222-4222-8222-222222222222","role":"authenticated","aal":"aal2"}',true);
  request_id:=public.request_integration_grant_v6(integration_id,false);
  select id into review_id from public.integration_grant_reviews_v6
    where canonical_request_id=request_id;
  perform public.decide_integration_grant_v6(review_id,request_id,true);
  perform set_config('request.jwt.claim.role','service_role',true);
  perform set_config('request.jwt.claims','{"role":"service_role"}',true);
  begin
    perform public.record_google_ads_full_read_v7(cid,integration_id,credential_id,job_id,
      '9999999999','USD',current_date-29,current_date,'req-b',campaign_rows,ad_rows);
  exception when check_violation then refused:=true; end;
  if not refused then raise exception 'Different Google customer was recorded'; end if;
  refused:=false;
  begin
    perform public.record_google_ads_full_read_v7(cid,integration_id,
      'f2222222-2222-4222-8222-222222222222',job_id,
      '1234567890','USD',current_date-29,current_date,'req-rotated',campaign_rows,ad_rows);
  exception when check_violation then refused:=true; end;
  if not refused then raise exception 'Wrong credential generation recorded a Google read'; end if;
  refused:=false;
  begin
    perform public.record_google_ads_full_read_v7('d2222222-2222-4222-8222-222222222222',
      integration_id,credential_id,job_id,'1234567890','USD',current_date-29,current_date,
      'req-c',campaign_rows,ad_rows);
  exception when check_violation then refused:=true; end;
  if not refused then raise exception 'Cross-client Google read was recorded'; end if;
  refused:=false;
  begin
    perform public.record_google_ads_full_read_v7(cid,integration_id,credential_id,job_id,
      '1234567890','USD',current_date-29,current_date,'req-bad-ad',campaign_rows,
      jsonb_set(ad_rows,'{0,resource_name}',
        '"customers/9999999999/adGroupAds/7~9"'::jsonb));
  exception when check_violation then refused:=true; end;
  if not refused then raise exception 'Foreign Google ad identity was recorded'; end if;
  refused:=false;
  select public.record_google_ads_full_read_v7(cid,integration_id,credential_id,job_id,
    '1234567890','USD',current_date-29,current_date,'req-d',campaign_rows,ad_rows) into v_run_id;
  if not exists(select 1 from public.google_ads_campaign_reads_v7 r
    where r.run_id=v_run_id and r.client_id=cid and r.external_campaign_id='42'
      and cost_micros=1230000 and conversions=1.25) then
    raise exception 'Google read did not persist exact metrics'; end if;
  if not exists(select 1 from public.google_ads_ad_reads_v7 a
    where a.run_id=v_run_id and a.client_id=cid and a.external_ad_id='9'
      and a.cost_micros=600000 and a.headlines='["A headline"]'::jsonb) then
    raise exception 'Google read did not persist ad creative and metrics'; end if;
  begin
    perform public.record_google_ads_full_read_v7(cid,integration_id,credential_id,job_id,
      '1234567890','USD',current_date-29,current_date,'req-d',campaign_rows,ad_rows);
  exception when unique_violation then refused:=true; end;
  if not refused then raise exception 'Duplicate job recorded a second Google read'; end if;
end $checks$;
rollback;

begin;
insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
values ('a3333333-3333-4333-8333-333333333333','00000000-0000-0000-0000-000000000000',
  'authenticated','authenticated','meta-read-admin@example.invalid','',now(),now());
insert into public.profiles(id,role,email) values
  ('a3333333-3333-4333-8333-333333333333','admin','meta-read-admin@example.invalid');
insert into public.clients(id,name,initials) values
  ('b3333333-3333-4333-8333-333333333333','Meta read fixture','MR');
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claim.sub','a3333333-3333-4333-8333-333333333333',true);
select set_config('request.jwt.claims',
  '{"sub":"a3333333-3333-4333-8333-333333333333","role":"authenticated","aal":"aal2"}',true);
do $checks$
declare cid uuid:='b3333333-3333-4333-8333-333333333333';
  integration_id uuid; credential_id uuid; request_id uuid; review_id uuid; job_id uuid;
  v_run uuid; refused boolean:=false;
  campaigns jsonb:='[{"id":"42","name":"Lead campaign","status":"ACTIVE",
    "effective_status":"ACTIVE","metrics_observed":true,"impressions":"100","clicks":"8","spend":"12.30",
    "actions":[{"action_type":"lead","value":"2"}]}]'::jsonb;
  ads jsonb:='[{"id":"9","campaign_id":"42","adset_id":"7","name":"Image ad",
    "status":"ACTIVE","effective_status":"ACTIVE","creative_id":"11",
    "creative_name":"Image creative","metrics_observed":true,"impressions":"50","clicks":"4","spend":"6.20",
    "actions":[]}]'::jsonb;
begin
  integration_id:=public.admin_store_integration_credential(
    cid,'meta','Meta Ads fixture','fixture-oauth-token','read');
  update public.client_integrations set ad_account_id='act_123' where id=integration_id;
  select credential_secret_id into credential_id from public.client_integrations where id=integration_id;
  perform set_config('request.jwt.claim.role','service_role',true);
  perform set_config('request.jwt.claims','{"role":"service_role"}',true);
  insert into public.agent_jobs(agent_key,client_id)
    values('meta_ads_read',cid) returning id into job_id;
  begin
    perform public.record_meta_ads_read_v7(cid,integration_id,credential_id,job_id,
      'act_123','USD',current_date-29,current_date,campaigns,ads);
  exception when check_violation then refused:=true; end;
  if not refused then raise exception 'Unapproved Meta integration recorded a read'; end if;
  refused:=false;
  perform set_config('request.jwt.claim.role','authenticated',true);
  perform set_config('request.jwt.claim.sub','a3333333-3333-4333-8333-333333333333',true);
  perform set_config('request.jwt.claims',
    '{"sub":"a3333333-3333-4333-8333-333333333333","role":"authenticated","aal":"aal2"}',true);
  request_id:=public.request_integration_grant_v6(integration_id,false);
  select id into review_id from public.integration_grant_reviews_v6 where canonical_request_id=request_id;
  perform public.decide_integration_grant_v6(review_id,request_id,true);
  perform set_config('request.jwt.claim.role','service_role',true);
  perform set_config('request.jwt.claims','{"role":"service_role"}',true);
  begin
    perform public.record_meta_ads_read_v7(cid,integration_id,credential_id,job_id,
      'act_999','USD',current_date-29,current_date,campaigns,ads);
  exception when check_violation then refused:=true; end;
  if not refused then raise exception 'Different Meta account was recorded'; end if;
  refused:=false;
  begin
    perform public.record_meta_ads_read_v7(cid,integration_id,credential_id,job_id,
      'act_123','USD',current_date-29,current_date,campaigns,
      jsonb_set(ads,'{0,campaign_id}','"999"'::jsonb));
  exception when check_violation then refused:=true; end;
  if not refused then raise exception 'Orphan Meta ad was recorded'; end if;
  refused:=false;
  select public.record_meta_ads_read_v7(cid,integration_id,credential_id,job_id,
    'act_123','USD',current_date-29,current_date,campaigns,ads) into v_run;
  if not exists(select 1 from public.meta_ads_campaign_reads_v7 c
    where c.run_id=v_run and c.external_campaign_id='42' and c.spend=12.30
      and c.metrics_observed)
    or not exists(select 1 from public.meta_ads_ad_reads_v7 a
      where a.run_id=v_run and a.external_ad_id='9' and a.spend=6.20
        and a.metrics_observed) then
    raise exception 'Meta inventory and metrics were not stored together'; end if;
  begin
    perform public.record_meta_ads_read_v7(cid,integration_id,credential_id,job_id,
      'act_123','USD',current_date-29,current_date,campaigns,ads);
  exception when unique_violation then refused:=true; end;
  if not refused then raise exception 'Meta job recorded twice'; end if;
  insert into public.agent_jobs(agent_key,client_id)
    values('meta_ads_read',cid) returning id into job_id;
  select public.record_meta_ads_read_v7(cid,integration_id,credential_id,job_id,
    'act_123','USD',current_date-29,current_date,
    '[{"id":"43","name":"No insights","status":"PAUSED",
      "effective_status":"PAUSED","impressions":"0","clicks":"0","spend":"0",
      "actions":[]}]'::jsonb,'[]'::jsonb) into v_run;
  if not exists(select 1 from public.meta_ads_campaign_reads_v7 c
    where c.run_id=v_run and c.external_campaign_id='43' and not c.metrics_observed) then
    raise exception 'Meta missing insight row was presented as observed'; end if;
end $checks$;
rollback;

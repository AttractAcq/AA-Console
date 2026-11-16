-- The Google manual packet freezes a signed offer, current campaign sheet,
-- human search copy, exact review, and reported handoff without API execution.
begin;
insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
values ('a1111111-1111-4111-8111-111111111111','00000000-0000-0000-0000-000000000000',
  'authenticated','authenticated','google-operator-fixture@example.invalid','',now(),now());
insert into public.profiles(id,role,email) values
  ('a1111111-1111-4111-8111-111111111111','admin','google-operator-fixture@example.invalid');
insert into public.clients(id,name,initials) values
  ('b1111111-1111-4111-8111-111111111111','Google operator fixture','GO');
insert into public.service_offers(id,client_id,service_name) values
  ('e1111111-1111-4111-8111-111111111111','b1111111-1111-4111-8111-111111111111','Fixture service');
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claim.sub','a1111111-1111-4111-8111-111111111111',true);
select set_config('request.jwt.claims',
  '{"sub":"a1111111-1111-4111-8111-111111111111","role":"authenticated","aal":"aal2"}',true);
select public.create_service_offer_version_v6(
  'b1111111-1111-4111-8111-111111111111','Fixture service','Local buyers',
  'Fixture promise',array[]::text[],array[]::text[],null,null,null,'[]'::jsonb,
  'google-operator-fixture','e1111111-1111-4111-8111-111111111111');
select public.approve_service_offer_version_v6(id)
  from public.service_offer_versions where idempotency_key='google-operator-fixture';
insert into public.client_campaigns(id,client_id,name,brief,acquisition_mode,runs_organic,runs_paid,
  paid_platform,content_count,organic_content_count,paid_content_count,built_at,
  offer_version_id,audience,objective,target_countries,daily_budget,conversion_event)
values ('c1111111-1111-4111-8111-111111111111',
  'b1111111-1111-4111-8111-111111111111','Google fixture campaign','Fixture',
  'paid',false,true,'google',1,0,1,now(),
  (select id from public.service_offer_versions where idempotency_key='google-operator-fixture'),
  'Local buyers','Lead generation',array['US'],25,'LEAD');
select set_config('request.jwt.claim.role','service_role',true);
select set_config('request.jwt.claims','{"role":"service_role"}',true);

do $checks$
declare cid uuid:='c1111111-1111-4111-8111-111111111111';
  manifest public.campaign_manifest_versions%rowtype;
  sheet_id uuid; bundle public.google_operator_bundles_v7%rowtype;
  repeated public.google_operator_bundles_v7%rowtype;
  request_id uuid; refused boolean:=false;
begin
  select * into manifest from public.create_campaign_manifest_v6(cid,'google-fixture');
  select public.record_google_ads_sheet_for_manifest_v6(cid,manifest.id,
    jsonb_build_object(
      'campaign',jsonb_build_object('name','Google fixture campaign',
        'daily_budget',25,'geography',array['US'],'conversion_action','LEAD'),
      'destination',jsonb_build_object('url','https://example.invalid/fixture'),
      'offer',jsonb_build_object('version_id',
        (select offer_version_id from public.client_campaigns where id=cid))),
    array['keyword_research']) into sheet_id;
  perform set_config('request.jwt.claim.role','authenticated',true);
  perform set_config('request.jwt.claim.sub','a1111111-1111-4111-8111-111111111111',true);
  perform set_config('request.jwt.claims',
    '{"sub":"a1111111-1111-4111-8111-111111111111","role":"authenticated","aal":"aal2"}',true);
  select * into bundle from public.create_google_operator_bundle_v7(sheet_id,
    'Google paid specialist','Cap at 25 USD per day','Use campaign source IDs',
    array['Fixture headline one','Fixture headline two','Fixture headline three'],
    array['Fixture description one','Fixture description two'],
    'Research keywords and negatives before Ads Manager build');
  select * into repeated from public.create_google_operator_bundle_v7(sheet_id,
    'Google paid specialist','Cap at 25 USD per day','Use campaign source IDs',
    array['Fixture headline one','Fixture headline two','Fixture headline three'],
    array['Fixture description one','Fixture description two'],
    'Research keywords and negatives before Ads Manager build');
  if bundle.id is distinct from repeated.id or not public.google_operator_bundle_current_v7(bundle.id)
    then raise exception 'Google packet was not current and idempotent'; end if;
  select id into request_id from public.approval_requests_v6
    where source_kind='google_operator_bundle' and source_id=bundle.id::text;
  if not exists(select 1 from public.approval_inbox_v6
      where id=request_id and status='pending' and source_state='pending'
        and preview_blocker is null) then
    raise exception 'Exact Google packet was missing from the unified inbox'; end if;
  begin
    perform public.record_google_operator_event_v7(bundle.id,'download_reported','browser-1');
  exception when check_violation then refused:=true; end;
  if not refused then raise exception 'Unapproved Google packet allowed a download report'; end if;
  refused:=false;
  perform set_config('request.jwt.claims',
    '{"sub":"a1111111-1111-4111-8111-111111111111","role":"authenticated","aal":"aal1"}',true);
  begin
    perform public.decide_google_operator_bundle_v7(bundle.id,request_id,true);
  exception when insufficient_privilege then refused:=true; end;
  if not refused then raise exception 'AAL1 approved the Google packet'; end if;
  refused:=false;
  perform set_config('request.jwt.claims',
    '{"sub":"a1111111-1111-4111-8111-111111111111","role":"authenticated","aal":"aal2"}',true);
  perform public.decide_google_operator_bundle_v7(bundle.id,request_id,true);
  if not public.google_operator_bundle_approved_v7(bundle.id) then
    raise exception 'Exact Google review was not approved'; end if;
  begin
    perform public.record_google_operator_event_v7(bundle.id,'handoff_reported','ticket-1');
  exception when check_violation then refused:=true; end;
  if not refused then raise exception 'Handoff skipped download report'; end if;
  refused:=false;
  perform public.record_google_operator_event_v7(bundle.id,'download_reported','browser-1');
  perform public.record_google_operator_event_v7(bundle.id,'handoff_reported','ticket-1');
  perform public.record_google_operator_event_v7(bundle.id,'external_ids_reported',
    'ads-manager-1','123456');
  update public.client_campaigns set daily_budget=30 where id=cid;
  if public.google_operator_bundle_current_v7(bundle.id) then
    raise exception 'Changed budget retained current Google packet'; end if;
  begin
    perform public.record_google_operator_event_v7(bundle.id,'change_reported',
      'ads-manager-2','123456');
  exception when check_violation then refused:=true; end;
  if not refused then raise exception 'Stale Google packet accepted a new report'; end if;
end $checks$;
rollback;

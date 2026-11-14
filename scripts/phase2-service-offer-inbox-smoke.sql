-- Rollback-only local proof for the service-offer AAL2 inbox bridge (327).
begin;
insert into auth.users (id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','00000000-0000-0000-0000-000000000000',
  'authenticated','authenticated','offer-admin@example.invalid','',now(),now()),
  ('cccccccc-cccc-4ccc-8ccc-cccccccccccc','00000000-0000-0000-0000-000000000000',
  'authenticated','authenticated','offer-outsider@example.invalid','',now(),now());
insert into public.profiles(id,role,email) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','admin','offer-admin@example.invalid'),
  ('cccccccc-cccc-4ccc-8ccc-cccccccccccc','client','offer-outsider@example.invalid');
insert into public.clients(id,name,initials) values
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Offer fixture','OF');

select set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true);
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal1"}',true);

do $checks$
declare
  v_first public.service_offer_versions%rowtype;
  v_second public.service_offer_versions%rowtype;
  v_held public.service_offer_versions%rowtype;
  v_request public.approval_requests_v6%rowtype;
begin
  if has_function_privilege('anon','public.reject_service_offer_version_v6(uuid,text)','execute')
    then raise exception 'Anonymous offer rejection is open'; end if;
  v_first := public.create_service_offer_version_v6(
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Consulting','Owners','Clear plan',
    array['Workshop'],array['No guaranteed result'],1000,'EUR',200,
    '[]'::jsonb,'offer-first');
  select * into v_request from public.approval_requests_v6
    where source_kind = 'service_offer' and source_id = v_first.id::text;
  if not found or v_request.artifact_hash <> v_first.content_hash
    or v_request.preview->>'promise' <> 'Clear plan'
    or v_request.scope->>'offer_version_id' <> v_first.id::text
    or public.service_offer_source_state_v6(v_request.id) <> 'pending'
    then raise exception 'Exact offer request is absent or incomplete'; end if;

  begin
    perform public.approve_service_offer_version_v6(v_first.id);
    raise exception 'AAL1 approved an offer';
  exception when insufficient_privilege then null; end;
  begin
    insert into public.service_offer_signoffs(offer_version_id,client_id,approved_by)
      values (v_first.id,v_first.client_id,auth.uid());
    raise exception 'AAL1 inserted a direct offer signoff';
  exception when insufficient_privilege then null; end;

  v_second := public.create_service_offer_version_v6(
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Consulting','Owners','Revised plan',
    array['Workshop'],array['No guaranteed result'],1000,'EUR',200,
    '[]'::jsonb,'offer-second',v_first.offer_id);
  if public.service_offer_source_state_v6(v_request.id) <> 'superseded' then
    raise exception 'Earlier offer version remains approvable'; end if;

  perform set_config('request.jwt.claims',
    '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal2"}',true);
  begin
    perform public.approve_service_offer_version_v6(v_first.id);
    raise exception 'Superseded offer approved';
  exception when check_violation then null; end;
  perform set_config('request.jwt.claim.sub','cccccccc-cccc-4ccc-8ccc-cccccccccccc',true);
  perform set_config('request.jwt.claims',
    '{"sub":"cccccccc-cccc-4ccc-8ccc-cccccccccccc","role":"authenticated","aal":"aal2"}',true);
  begin
    perform public.approve_service_offer_version_v6(v_second.id);
    raise exception 'Wrong-client actor approved an offer';
  exception when insufficient_privilege then null; end;
  perform set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true);
  perform set_config('request.jwt.claims',
    '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal2"}',true);
  begin
    insert into public.service_offer_signoffs(offer_version_id,client_id,approved_by)
      values (v_second.id,v_second.client_id,auth.uid());
    raise exception 'Direct signoff passed without an Inbox decision';
  exception when check_violation then null; end;
  begin
    insert into public.client_campaigns(client_id,name,brief,acquisition_mode,
      runs_organic,runs_paid,offer_version_id)
    values (v_second.client_id,'Unapproved offer campaign','Fixture','organic',true,false,v_second.id);
    raise exception 'Campaign used an offer without the exact signoff';
  exception when raise_exception then
    if sqlerrm = 'Campaign used an offer without the exact signoff' then raise; end if;
  end;
  perform public.approve_service_offer_version_v6(v_second.id);
  if not exists (select 1 from public.service_offer_signoffs
    where offer_version_id = v_second.id and approved_by = auth.uid())
    or not exists (select 1 from public.approval_decision_events_v6 d
      join public.approval_requests_v6 r on r.id = d.request_id
      where r.source_id = v_second.id::text and d.decision = 'approved'
        and d.actor_aal = 'aal2') then
    raise exception 'Signoff and canonical AAL2 decision diverged'; end if;
  insert into public.client_campaigns(client_id,name,brief,acquisition_mode,
    runs_organic,runs_paid,offer_version_id)
  values (v_second.client_id,'Approved offer campaign','Fixture','organic',true,false,v_second.id);
  begin
    perform public.approve_service_offer_version_v6(v_second.id);
    raise exception 'Duplicate signoff succeeded';
  exception when check_violation then null; end;

  v_held := public.create_service_offer_version_v6(
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Other service','Owners','More leads',
    array[]::text[],array[]::text[],null,null,null,
    '[{"kind":"quantified","text":"50% more leads","proof_asset_id":"11111111-1111-4111-8111-111111111111"}]'::jsonb,
    'offer-held');
  select * into v_request from public.approval_requests_v6
    where source_kind = 'service_offer' and source_id = v_held.id::text;
  if public.service_offer_source_state_v6(v_request.id) <> 'source_held' then
    raise exception 'Uncleared quantified claim was not held'; end if;
  begin
    perform public.approve_service_offer_version_v6(v_held.id);
    raise exception 'Uncleared quantified claim approved';
  exception when check_violation then null; end;
  perform public.reject_service_offer_version_v6(v_held.id,'Proof missing');
  if (select status from public.approval_inbox_v6 where id = v_request.id) <> 'rejected'
    or not exists (select 1 from public.approval_decision_events_v6 d
    where d.request_id = v_request.id and d.decision = 'rejected'
      and d.reason = 'Proof missing') then
    raise exception 'Rejection was not recorded'; end if;
end $checks$;
rollback;

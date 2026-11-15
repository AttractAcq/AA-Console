-- Rollback-only proof of the standalone, exact text-placement Inbox route.
begin;
-- Fixture setup exercises another approval class; bypass only the new
-- activation guard inside this rollback transaction.
alter table public.client_engine_settings disable trigger client_switch_activation_guard_v6;
insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','00000000-0000-0000-0000-000000000000',
  'authenticated','authenticated','placement-admin@example.invalid','',now(),now()),
  ('cccccccc-cccc-4ccc-8ccc-cccccccccccc','00000000-0000-0000-0000-000000000000',
  'authenticated','authenticated','placement-outsider@example.invalid','',now(),now());
insert into public.profiles(id,role,email) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','admin','placement-admin@example.invalid'),
  ('cccccccc-cccc-4ccc-8ccc-cccccccccccc','client','placement-outsider@example.invalid');
insert into public.clients(id,name,initials) values
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Placement fixture','PL');
select set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true);
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal1"}',true);

do $checks$
declare p public.client_proof_assets%rowtype;
  rights_request uuid;
  rights_source uuid;
  placement_id uuid;
  confirmation_placement_id uuid;
  request_id uuid;
  placement_approval_id uuid;
  stale_placement_id uuid;
  stale_request_id uuid;
  stale_approval_id uuid;
begin
  insert into public.client_proof_assets(client_id,media_type,title,body,source,claim,evidence)
    values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','text','Customer quote','The team arrived on time',
      'Customer interview','Arrived on time','Signed handover') returning * into p;
  rights_request := public.request_proof_rights_v6(p.id,'Customer signed quote release');
  select id into rights_source from public.proof_rights_requests_v6
    where canonical_request_id = rights_request;
  perform set_config('request.jwt.claims',
    '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal2"}',true);
  perform public.approve_proof_rights_v6(rights_source,rights_request);
  placement_id := public.create_proof_placement_v6('test-directory-placement',p.client_id,
    'third_party_directory',p_proof_id => p.id);
  begin
    perform public.decide_proof_placement_approval_v6(
      public.request_proof_placement_approval_v6(placement_id),true);
    raise exception 'Legacy direct placement approval succeeded';
  exception when insufficient_privilege then null; end;
  -- The failed direct transaction rolls back its own old request.
  request_id := public.request_proof_placement_inbox_v6(placement_id);
  select pl.approval_id into placement_approval_id from public.proof_placements pl where pl.id=placement_id;
  if placement_approval_id is null or public.request_proof_placement_inbox_v6(placement_id) <> request_id
    or public.proof_placement_source_state_v6(request_id) <> 'pending'
    or (select status from public.approval_inbox_v6 where id=request_id) <> 'pending'
    then raise exception 'Placement request was not exact, pending and deduplicated'; end if;
  perform set_config('request.jwt.claims',
    '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal1"}',true);
  begin
    perform public.decide_proof_placement_inbox_v6(placement_approval_id,request_id,true);
    raise exception 'AAL1 approved placement';
  exception when insufficient_privilege then null; end;
  perform set_config('request.jwt.claim.sub','cccccccc-cccc-4ccc-8ccc-cccccccccccc',true);
  perform set_config('request.jwt.claims',
    '{"sub":"cccccccc-cccc-4ccc-8ccc-cccccccccccc","role":"authenticated","aal":"aal2"}',true);
  begin
    perform public.decide_proof_placement_inbox_v6(placement_approval_id,request_id,true);
    raise exception 'Wrong-client actor approved placement';
  exception when insufficient_privilege then null; end;
  perform set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true);
  perform set_config('request.jwt.claims',
    '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal2"}',true);
  perform public.decide_proof_placement_inbox_v6(placement_approval_id,request_id,true);
  if (select status from public.proof_placements where id=placement_id) <> 'awaiting_manual_placement'
    or public.proof_placement_source_state_v6(request_id) <> 'source_decided'
    or (select status from public.approval_inbox_v6 where id=request_id) <> 'approved'
    then raise exception 'Exact Inbox decision did not release the placement'; end if;
  begin
    perform public.decide_proof_placement_inbox_v6(placement_approval_id,request_id,true);
    raise exception 'A duplicate placement decision succeeded';
  exception when check_violation then null; end;
  if public.proof_placement_effect_allowed_v6(placement_id) then
    raise exception 'An off client switch did not hold the approved placement'; end if;
  begin
    perform public.mark_proof_placement_placed_inbox_v6(placement_id,'https://example.invalid/proof');
    raise exception 'Placement was marked while the client switch was off';
  exception when insufficient_privilege then null; end;
  insert into public.client_engine_settings(client_id,proof_publishing_enabled)
    values (p.client_id,true) on conflict (client_id)
    do update set proof_publishing_enabled=true;
  insert into public.client_proof_destinations(client_id,destination_key,enabled)
    values (p.client_id,'third_party_directory',true);
  if not public.proof_placement_effect_allowed_v6(placement_id) then
    raise exception 'Current exact approval did not clear the placement prewrite gate'; end if;
  perform set_config('request.jwt.claim.role','service_role',true);
  if not public.proof_placement_effect_allowed_v6(placement_id) then
    raise exception 'Service-role sweep could not observe the current exact decision'; end if;
  perform set_config('request.jwt.claim.role','authenticated',true);
  perform public.mark_proof_placement_placed_inbox_v6(placement_id,'https://example.invalid/proof');
  if (select status from public.proof_placements where id=placement_id) <> 'placed' then
    raise exception 'Assisted placement did not record an external URL'; end if;
  stale_placement_id := public.create_proof_placement_v6('stale-quotation-placement',p.client_id,
    'proposal_quotation',p_proof_id => p.id);
  stale_request_id := public.request_proof_placement_inbox_v6(stale_placement_id);
  select pl.approval_id into stale_approval_id from public.proof_placements pl
    where pl.id=stale_placement_id;
  insert into public.client_proof_destinations(client_id,destination_key,enabled,account_ref)
    values (p.client_id,'proposal_quotation',false,'different account');
  if public.proof_placement_source_state_v6(stale_request_id) <> 'superseded' then
    raise exception 'Destination account change did not stale placement review'; end if;
  begin
    perform public.decide_proof_placement_inbox_v6(stale_approval_id,stale_request_id,true);
    raise exception 'Stale destination account was approved';
  exception when check_violation then null; end;
  update public.client_proof_assets set usage_rights='restricted' where id=p.id;
  if (select status from public.proof_placements where id=placement_id) <> 'retraction_required'
    or (select status from public.approval_inbox_v6 where id=request_id) = 'approved'
    then raise exception 'Revoked proof still appeared releasable'; end if;
  if has_function_privilege('authenticated',
    'public.record_proof_retracted_v6(uuid,text)','execute')
    or has_function_privilege('service_role',
      'public.record_proof_retracted_v6(uuid,text)','execute') then
    raise exception 'Status-only proof retraction RPC remains callable'; end if;
  begin
    update public.proof_placements set status='retracted' where id=placement_id;
    raise exception 'A placement was retracted without a receipt';
  exception when check_violation then null; end;
  perform set_config('request.jwt.claims',
    '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal1"}',true);
  begin
    perform public.record_proof_retraction_confirmation_v6(placement_id,
      'human_checked','https://example.invalid/removal-ticket','Rights withdrawn');
    raise exception 'AAL1 confirmed external proof removal';
  exception when insufficient_privilege then null; end;
  perform set_config('request.jwt.claims',
    '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal2"}',true);
  begin
    perform public.record_proof_retraction_confirmation_v6(placement_id,
      'cancelled_before_placement',null,'Rights withdrawn');
    raise exception 'A placed proof was cancelled as if never published';
  exception when check_violation then null; end;
  begin
    perform public.record_proof_retraction_confirmation_v6(placement_id,
      'human_checked',null,'Rights withdrawn');
    raise exception 'A live proof was retracted without removal evidence';
  exception when check_violation then null; end;
  perform public.record_proof_retraction_confirmation_v6(placement_id,
    'human_checked','https://example.invalid/removal-ticket','Rights withdrawn');
  confirmation_placement_id := placement_id;
  if (select status from public.proof_placements where id=placement_id)<>'retracted'
    or not exists(select 1 from public.proof_placement_retraction_receipts_v6 r
      where r.placement_id=confirmation_placement_id and r.method='human_checked'
        and r.evidence_ref='https://example.invalid/removal-ticket'
        and r.recorded_by='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') then
    raise exception 'Removal confirmation did not atomically record its receipt'; end if;
  begin
    perform public.record_proof_retraction_confirmation_v6(placement_id,
      'human_checked','https://example.invalid/removal-ticket','Again');
    raise exception 'A duplicate removal confirmation succeeded';
  exception when check_violation then null; end;
end $checks$;
rollback;

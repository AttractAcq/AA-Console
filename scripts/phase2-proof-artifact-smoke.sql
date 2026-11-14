-- Rollback-only artifact signoff and subsequent text-placement fixture.
begin;
insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','00000000-0000-0000-0000-000000000000',
  'authenticated','authenticated','artifact-admin@example.invalid','',now(),now());
insert into public.profiles(id,role,email) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','admin','artifact-admin@example.invalid');
insert into public.clients(id,name,initials) values
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Artifact fixture','AF');
select set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true);
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal1"}',true);

do $checks$
declare p public.client_proof_assets%rowtype;
  v public.proof_artifact_versions%rowtype;
  rights_request uuid;
  rights_source uuid;
  review_request uuid;
  review_source uuid;
  placement_id uuid;
  placement_request uuid;
  placement_approval uuid;
begin
  insert into public.client_proof_assets(client_id,media_type,title,body,source,claim,evidence)
    values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','text','Customer result',
      'The team arrived on time','Customer interview','Arrived on time','Signed handover')
    returning * into p;
  rights_request := public.request_proof_rights_v6(p.id,'Signed customer quote release');
  select id into rights_source from public.proof_rights_requests_v6
    where canonical_request_id = rights_request;
  perform set_config('request.jwt.claims',
    '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal2"}',true);
  perform public.approve_proof_rights_v6(rights_source,rights_request);
  select * into v from public.create_proof_artifact_v6(p.client_id,p.id,'local_proof_snippet',
    'The team arrived on time','Signed handover',
    'A customer said the team arrived on time. Signed handover supports the claim.',
    'artifact-fixture');
  begin
    perform public.approve_proof_artifact_v6(v.id);
    raise exception 'Old direct artifact signoff succeeded';
  exception when insufficient_privilege then null; end;
  review_request := public.request_proof_artifact_signoff_v6(v.id);
  select id into review_source from public.proof_artifact_review_requests_v6
    where canonical_request_id = review_request;
  if review_source is null or public.request_proof_artifact_signoff_v6(v.id) <> review_request
    or public.proof_artifact_review_source_state_v6(review_request) <> 'pending'
    or (select status from public.approval_inbox_v6 where id=review_request) <> 'pending'
    then raise exception 'Exact artifact request was not pending and deduplicated'; end if;
  begin
    insert into public.proof_artifact_signoffs
      (artifact_version_id,client_id,approved_by,approved_request_id,approved_content_hash)
    values (v.id,p.client_id,'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      review_request,(select artifact_hash from public.approval_requests_v6 where id=review_request));
    raise exception 'Direct signoff row bypassed Inbox';
  exception when check_violation then null; end;
  perform set_config('request.jwt.claims',
    '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal1"}',true);
  begin
    perform public.approve_proof_artifact_inbox_v6(review_source,review_request);
    raise exception 'AAL1 signed artifact';
  exception when insufficient_privilege then null; end;
  perform set_config('request.jwt.claims',
    '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal2"}',true);
  perform public.approve_proof_artifact_inbox_v6(review_source,review_request);
  if not public.proof_artifact_signoff_current_v6(v.id)
    or (select status from public.approval_inbox_v6 where id=review_request) <> 'approved'
    then raise exception 'Exact artifact signoff did not become current'; end if;
  placement_id := public.create_proof_placement_v6('artifact-placement',p.client_id,
    'third_party_directory',p_artifact_version_id => v.id);
  placement_request := public.request_proof_placement_inbox_v6(placement_id);
  select pl.approval_id into placement_approval from public.proof_placements pl
    where pl.id=placement_id;
  if public.proof_placement_source_state_v6(placement_request) <> 'pending'
    then raise exception 'Current artifact signoff did not permit a placement review'; end if;
  perform public.decide_proof_placement_inbox_v6(placement_approval,placement_request,true);
  insert into public.client_engine_settings(client_id,proof_publishing_enabled)
    values (p.client_id,true) on conflict (client_id)
    do update set proof_publishing_enabled=true;
  insert into public.client_proof_destinations(client_id,destination_key,enabled)
    values (p.client_id,'third_party_directory',true);
  if not public.proof_placement_effect_allowed_v6(placement_id) then
    raise exception 'Current artifact and placement decisions did not clear prewrite'; end if;
  perform public.mark_proof_placement_placed_inbox_v6(placement_id,'https://example.invalid/artifact');
  update public.client_proof_assets set usage_rights='restricted' where id=p.id;
  if public.proof_artifact_signoff_current_v6(v.id)
    or public.proof_placement_effect_allowed_v6(placement_id)
    or (select status from public.proof_placements where id=placement_id) <> 'retraction_required'
    then raise exception 'Revoked source rights left artifact placement live'; end if;
end $checks$;
rollback;

-- Rollback-only proof of text-source rights clearance and protective revocation.
begin;
insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','00000000-0000-0000-0000-000000000000',
  'authenticated','authenticated','proof-admin@example.invalid','',now(),now()),
  ('cccccccc-cccc-4ccc-8ccc-cccccccccccc','00000000-0000-0000-0000-000000000000',
  'authenticated','authenticated','proof-outsider@example.invalid','',now(),now());
insert into public.profiles(id,role,email) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','admin','proof-admin@example.invalid'),
  ('cccccccc-cccc-4ccc-8ccc-cccccccccccc','client','proof-outsider@example.invalid');
insert into public.clients(id,name,initials) values
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Proof rights fixture','PR');
select set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true);
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal1"}',true);

do $checks$
declare p public.client_proof_assets%rowtype;
  media public.client_proof_assets%rowtype;
  request_id uuid;
  rights_id uuid;
  next_request uuid;
begin
  begin
    insert into public.client_proof_assets(client_id,media_type,title,body,usage_rights,permission_basis)
      values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','text','Forged proof','A result',
        'approved','Customer consent');
    raise exception 'New proof carried forged clearance';
  exception when check_violation then null; end;
  insert into public.client_proof_assets(client_id,media_type,title,body,source,claim,evidence)
    values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','text','Testimonial','Built on time',
      'Customer interview','Delivered on time','Signed handover note') returning * into p;
  insert into public.client_proof_assets(client_id,media_type,title,storage_path)
    values (p.client_id,'image','Stored photo','proof/test-image.png') returning * into media;
  begin
    perform public.request_proof_rights_v6(media.id,'Signed photo release');
    raise exception 'Stored media requested clearance without byte attestation';
  exception when check_violation then null; end;
  begin
    update public.client_proof_assets set usage_rights='approved',
      permission_basis='Customer signed' where id = p.id;
    raise exception 'Direct AAL1 rights grant succeeded';
  exception when insufficient_privilege then null; end;
  request_id := public.request_proof_rights_v6(p.id,'Customer signed quote release');
  select id into rights_id from public.proof_rights_requests_v6
    where canonical_request_id = request_id;
  if rights_id is null or public.request_proof_rights_v6(p.id,'Customer signed quote release') <> request_id
    or public.proof_rights_source_state_v6(request_id) <> 'pending'
    or (select status from public.approval_inbox_v6 where id = request_id) <> 'pending'
    then raise exception 'Exact rights request was not registered and deduplicated'; end if;
  begin
    perform public.approve_proof_rights_v6(rights_id,request_id);
    raise exception 'AAL1 cleared proof rights';
  exception when insufficient_privilege then null; end;
  perform set_config('request.jwt.claim.sub','cccccccc-cccc-4ccc-8ccc-cccccccccccc',true);
  perform set_config('request.jwt.claims',
    '{"sub":"cccccccc-cccc-4ccc-8ccc-cccccccccccc","role":"authenticated","aal":"aal2"}',true);
  begin
    perform public.approve_proof_rights_v6(rights_id,request_id);
    raise exception 'Wrong-client actor cleared proof rights';
  exception when insufficient_privilege then null; end;
  perform set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true);
  perform set_config('request.jwt.claims',
    '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal2"}',true);
  begin
    update public.client_proof_assets set usage_rights='approved',
      permission_basis='Customer signed quote release' where id = p.id;
    raise exception 'Direct AAL2 rights grant bypassed Inbox';
  exception when insufficient_privilege then null; end;
  update public.client_proof_assets set body='Revised customer quote' where id = p.id;
  if public.proof_rights_source_state_v6(request_id) <> 'superseded' then
    raise exception 'Source words changed without staling rights request'; end if;
  begin
    perform public.approve_proof_rights_v6(rights_id,request_id);
    raise exception 'Stale proof was cleared';
  exception when check_violation then null; end;
  next_request := public.request_proof_rights_v6(p.id,'Customer signed quote release');
  if next_request = request_id then raise exception 'Stale request epoch was reused'; end if;
  select id into rights_id from public.proof_rights_requests_v6
    where canonical_request_id = next_request;
  perform public.approve_proof_rights_v6(rights_id,next_request);
  if (select usage_rights from public.client_proof_assets where id=p.id) <> 'approved'
    or public.proof_rights_source_state_v6(next_request) <> 'source_decided'
    or (select status from public.approval_inbox_v6 where id=next_request) <> 'approved'
    then raise exception 'Exact rights approval did not clear the source and Inbox'; end if;
  update public.client_proof_assets set usage_rights='restricted' where id=p.id;
  if (select usage_rights from public.client_proof_assets where id=p.id) <> 'restricted'
    or public.proof_rights_source_state_v6(next_request) <> 'revoked'
    or (select status from public.approval_inbox_v6 where id=next_request) <> 'revoked'
    then raise exception 'Protective restriction did not revoke rights'; end if;
  request_id := public.request_proof_rights_v6(p.id,'Customer signed quote release');
  if request_id = next_request then raise exception 'Revoked request epoch was reused'; end if;
  select id into rights_id from public.proof_rights_requests_v6
    where canonical_request_id = request_id;
  perform public.reject_proof_rights_v6(rights_id,request_id,'Consent basis incomplete');
  if (select status from public.approval_inbox_v6 where id=request_id) <> 'rejected'
    then raise exception 'Rights rejection did not reach Inbox'; end if;
  next_request := public.request_proof_rights_v6(p.id,'Customer signed quote release');
  select id into rights_id from public.proof_rights_requests_v6
    where canonical_request_id = next_request;
  perform public.approve_proof_rights_v6(rights_id,next_request);
  update public.client_proof_assets set body='A materially different testimonial' where id=p.id;
  if (select usage_rights from public.client_proof_assets where id=p.id) <> 'not_cleared'
    or (select status from public.approval_inbox_v6 where id=next_request) <> 'revoked'
    then raise exception 'Edited proof retained public clearance'; end if;
end $checks$;
rollback;

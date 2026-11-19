-- A consented return to an archived contact must preserve the submission,
-- exact source and consent, while leaving the historical lead untouched.
begin;
insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
values ('a6380000-0000-4000-8000-000000000001',
  '00000000-0000-0000-0000-000000000000',
  'authenticated','authenticated','return-review@example.invalid','',now(),now());
insert into public.profiles(id,role,email)
values ('a6380000-0000-4000-8000-000000000001','admin',
  'return-review@example.invalid');
insert into public.clients(id,name,initials)
values ('b6380000-0000-4000-8000-000000000001','Return fixture','RF');
select set_config('request.jwt.claim.role','service_role',true);
select set_config('request.jwt.claims','{"role":"service_role"}',true);
do $fixture$
declare cid uuid:='b6380000-0000-4000-8000-000000000001';
  endpoint_id uuid; request_id uuid; review_id uuid; first_id uuid;
  held_id uuid; result jsonb; archived_hash text; packet jsonb;
  second_id uuid; resolved_id uuid; canonical_id uuid; refused boolean;
begin
  select id into endpoint_id from public.create_lead_capture_endpoint_v6(
    cid,'agent_handoff',repeat('f',64),'I agree to a reply',
    null,null,'organic');
  perform set_config('request.jwt.claim.role','authenticated',true);
  perform set_config('request.jwt.claim.sub',
    'a6380000-0000-4000-8000-000000000099',true);
  perform set_config('request.jwt.claims',
    '{"sub":"a6380000-0000-4000-8000-000000000099","role":"authenticated","aal":"aal2"}',true);
  refused:=false;
  begin perform public.archived_return_review_packet_v11(held_id);
  exception when insufficient_privilege then refused:=true; end;
  if not refused then raise exception 'Unprovisioned reviewer read another client return'; end if;
  perform set_config('request.jwt.claim.sub',
    'a6380000-0000-4000-8000-000000000001',true);
  perform set_config('request.jwt.claims',
    '{"sub":"a6380000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal2"}',true);
  request_id:=public.request_lead_capture_activation_v6(endpoint_id);
  select id into review_id from public.client_switch_activation_reviews_v6
    where canonical_request_id=request_id;
  perform public.decide_client_switch_activation_v6(review_id,request_id,true);
  perform set_config('request.jwt.claim.role','service_role',true);
  perform set_config('request.jwt.claim.sub','',true);
  perform set_config('request.jwt.claims','{"role":"service_role"}',true);

  result:=public.capture_lead_v6(repeat('f',64),'first',
    p_name=>'Returning fixture',p_email=>'return@example.invalid',
    p_consented=>true,p_click_id=>'click-first');
  if result->>'created'<>'true' then raise exception 'Initial capture failed'; end if;
  first_id:=(result->>'lead_id')::uuid;
  perform public.archive_lead(first_id,'Finished fixture');
  -- Legacy archived JSON may predate the stored generated dedupe key.
  update public.archived_leads set lead=lead-'dedupe_key' where id=first_id;
  select md5(lead::text) into archived_hash from public.archived_leads
    where id=first_id;

  result:=public.capture_lead_v6(repeat('f',64),'return',
    p_name=>'Returning fixture',p_email=>'return@example.invalid',
    p_consented=>true,p_click_id=>'click-return',
    p_utm=>'{"utm_source":"fixture-return"}'::jsonb);
  held_id:=(result->>'submission_id')::uuid;
  if result->>'ok'<>'true' or result->>'pending_review'<>'true'
     or result->>'lead_id' is not null
     or exists (select 1 from public.client_leads where client_id=cid)
     or (select count(*) from public.archived_leads where client_id=cid)<>1
     or (select md5(lead::text) from public.archived_leads where id=first_id)
          is distinct from archived_hash then
    raise exception 'Returning capture silently changed archived history';
  end if;
  if not exists (select 1 from public.lead_submissions s
      where s.id=held_id and s.status='received' and s.lead_id is null
        and s.archive_match_lead_id=first_id
        and s.consent_wording='I agree to a reply'
        and s.consent_evidence->'source_snapshot'->>'purpose'='agent_handoff'
        and s.click_id='click-return'
        and s.utm->>'utm_source'='fixture-return') then
    raise exception 'Held submission lost consent, source or candidate';
  end if;
  select id into canonical_id from public.approval_requests_v6
    where source_kind='archived_form_return' and source_id=held_id::text;
  if canonical_id is null or
     public.archived_return_inbox_source_state_v11(canonical_id)<>'pending' then
    raise exception 'Held form return has no exact canonical Inbox request';
  end if;
  result:=public.capture_lead_v6(repeat('f',64),'return',
    p_email=>'return@example.invalid',p_consented=>true);
  if result->>'repeat'<>'true'
     or (result->>'submission_id')::uuid is distinct from held_id
     or (select count(*) from public.lead_submissions where client_id=cid)<>2 then
    raise exception 'Held submission replay was not idempotent';
  end if;
  result:=public.capture_lead_v6(repeat('f',64),'no-consent',
    p_email=>'return@example.invalid',p_consented=>false);
  if result->>'ok'<>'false'
     or (select count(*) from public.lead_submissions where client_id=cid)<>2 then
    raise exception 'Unconsented returning capture was accepted';
  end if;
  refused:=false;
  begin perform public.recover_lead(first_id);
  exception when check_violation then refused:=true; end;
  if not refused then raise exception 'Direct recovery bypassed pending review'; end if;
  refused:=false;
  begin
    update public.lead_submissions set consent_wording='Changed after consent'
    where id=held_id;
  exception when check_violation then refused:=true; end;
  if not refused then raise exception 'Held consent wording was rewritten'; end if;
  refused:=false;
  begin
    update public.lead_submissions set status='promoted',lead_id=first_id
    where id=held_id;
  exception when check_violation then refused:=true; end;
  if not refused then raise exception 'Direct service promotion bypassed review'; end if;

  perform set_config('request.jwt.claim.role','authenticated',true);
  perform set_config('request.jwt.claim.sub',
    'a6380000-0000-4000-8000-000000000099',true);
  perform set_config('request.jwt.claims',
    '{"sub":"a6380000-0000-4000-8000-000000000099","role":"authenticated","aal":"aal2"}',true);
  execute 'set local role authenticated';
  if exists(select 1 from public.approval_inbox_v6 where id=canonical_id) then
    raise exception 'Unprovisioned reviewer read the canonical form card';
  end if;
  execute 'reset role';
  perform set_config('request.jwt.claim.sub',
    'a6380000-0000-4000-8000-000000000001',true);
  perform set_config('request.jwt.claims',
    '{"sub":"a6380000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal1"}',true);
  packet:=public.archived_return_review_packet_v11(held_id);
  execute 'set local role authenticated';
  if not exists(select 1 from public.approval_inbox_v6 where id=canonical_id) then
    raise exception 'Provisioned reviewer cannot read the form card';
  end if;
  execute 'reset role';
  if (select status from public.approval_inbox_v6 where id=canonical_id)<>'pending'
     then raise exception 'Held form return is absent from the pending Inbox'; end if;
  if packet->>'archived_email'<>'return@example.invalid'
     or packet->>'submitted_email'<>'return@example.invalid' then
    raise exception 'Review packet omitted the compared contact'; end if;
  refused:=false;
  begin
    perform public.resolve_archived_return_v11(held_id,'recover',
      packet->>'source_hash','Reviewed returning customer');
  exception when insufficient_privilege then refused:=true; end;
  if not refused then raise exception 'AAL1 resolved the archived return'; end if;
  perform set_config('request.jwt.claims',
    '{"sub":"a6380000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal2"}',true);
  refused:=false;
  begin
    perform public.resolve_archived_return_v11(held_id,'recover',
      repeat('0',64),'Reviewed returning customer');
  exception when check_violation then refused:=true; end;
  if not refused then raise exception 'Stale review hash resolved the return'; end if;
  resolved_id:=public.resolve_archived_return_v11(held_id,'recover',
    packet->>'source_hash','Reviewed returning customer');
  if resolved_id is distinct from first_id
     or exists(select 1 from public.archived_leads where id=first_id)
     or not exists(select 1 from public.lead_submissions
       where id=held_id and status='promoted' and lead_id=first_id)
     or not exists(select 1 from public.lead_return_resolutions_v11
       where submission_id=held_id and action='recover'
         and reviewer_aal='aal2' and source_hash=packet->>'source_hash') then
    raise exception 'Reviewed recovery lost the submission or decision';
  end if;
  if public.archived_return_inbox_source_state_v11(canonical_id)<>'source_decided'
     or (select status from public.approval_inbox_v6 where id=canonical_id)<>'approved'
     or not exists(select 1 from public.approval_decision_events_v6 d
       where d.request_id=canonical_id and d.decision='approved'
         and d.artifact_hash=packet->>'source_hash'
         and d.actor_aal='aal2') then
    raise exception 'Form return source decision was not mirrored atomically';
  end if;
  refused:=false;
  begin
    perform public.resolve_archived_return_v11(held_id,'recover',
      packet->>'source_hash','Duplicate review attempt');
  exception when check_violation then refused:=true; end;
  if not refused then raise exception 'Duplicate return resolution succeeded'; end if;

  perform public.archive_lead(first_id,'Finished again');
  select md5(lead::text) into archived_hash from public.archived_leads
    where id=first_id;
  perform set_config('request.jwt.claim.role','service_role',true);
  perform set_config('request.jwt.claim.sub','',true);
  perform set_config('request.jwt.claims','{"role":"service_role"}',true);
  result:=public.capture_lead_v6(repeat('f',64),'return-new',
    p_name=>'New journey',p_email=>'return@example.invalid',
    p_consented=>true,p_click_id=>'click-new');
  second_id:=(result->>'submission_id')::uuid;
  if result->>'pending_review'<>'true' then
    raise exception 'Second archived return did not hold'; end if;
  perform set_config('request.jwt.claim.role','authenticated',true);
  perform set_config('request.jwt.claim.sub',
    'a6380000-0000-4000-8000-000000000001',true);
  perform set_config('request.jwt.claims',
    '{"sub":"a6380000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal2"}',true);
  packet:=public.archived_return_review_packet_v11(second_id);
  resolved_id:=public.resolve_archived_return_v11(second_id,'new_lead',
    packet->>'source_hash','Separate new acquisition journey');
  if resolved_id=first_id
     or not exists(select 1 from public.archived_leads where id=first_id)
     or (select md5(lead::text) from public.archived_leads where id=first_id)
          is distinct from archived_hash
     or not exists(select 1 from public.client_leads
       where id=resolved_id and source='agent_handoff'
         and source_click_id='click-new' and consent_wording='I agree to a reply')
     or not exists(select 1 from public.lead_return_resolutions_v11
       where submission_id=second_id and action='new_lead'
         and archived_lead_id=first_id and resolved_lead_id=resolved_id)
     or not exists(select 1 from public.lead_submissions
       where id=second_id and status='promoted' and lead_id=resolved_id) then
    raise exception 'New lead decision changed archive or lost source';
  end if;
  if has_table_privilege('service_role',
      'public.lead_return_resolutions_v11','INSERT') then
    raise exception 'Service role can forge a human review record'; end if;
end $fixture$;
rollback;

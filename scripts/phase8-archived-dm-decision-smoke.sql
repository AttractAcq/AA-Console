-- An exact, canonical AAL2 DM decision recovers or starts a separate lead
-- without sending a message. This fixture rolls every record back.
begin;
insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
values ('a6520000-0000-4000-8000-000000000001',
  '00000000-0000-0000-0000-000000000000','authenticated','authenticated',
  'dm-decision@example.invalid','',now(),now());
insert into public.profiles(id,role,email)
values ('a6520000-0000-4000-8000-000000000001','admin',
  'dm-decision@example.invalid');
insert into public.clients(id,name,initials)
values ('b6520000-0000-4000-8000-000000000001','DM decision fixture','DD');
select set_config('request.jwt.claim.role','service_role',true);
select set_config('request.jwt.claims','{"role":"service_role"}',true);
do $fixture$
declare v_client uuid:='b6520000-0000-4000-8000-000000000001';
  v_old uuid; v_identity uuid; v_conversation uuid;
  v_packet jsonb; v_current jsonb; v_result uuid;
  v_request uuid; v_refused boolean; v_action text;
  v_second_conversation uuid;
begin
  for v_action in select unnest(array['recover','new_lead']) loop
    perform set_config('request.jwt.claim.role','service_role',true);
    perform set_config('request.jwt.claim.sub','',true);
    perform set_config('request.jwt.claims','{"role":"service_role"}',true);
    insert into public.client_leads(client_id,name,stage,source,source_channel)
      values(v_client,'Archived DM '||v_action,'conversation','direct_message',
        'instagram') returning id into v_old;
    insert into public.dm_identities(client_id,platform,external_user_id,
      display_name,lead_id)
      values(v_client,'instagram','dm-decision-'||v_action,
        'Returning DM '||v_action,v_old) returning id into v_identity;
    insert into public.dm_conversations(client_id,identity_id,platform,
      lead_id,status,closed_reason)
      values(v_client,v_identity,'instagram',v_old,'closed','finished')
      returning id into v_conversation;
    perform public.archive_lead(v_old,'Finished original relationship');
    perform public.record_inbound_dm_v6(v_client,'instagram',
      'dm-decision-'||v_action,'dm-decision-message-'||v_action,
      'Please contact me again','Returning DM',now());
    perform set_config('request.jwt.claim.role','authenticated',true);
    perform set_config('request.jwt.claim.sub',
      'a6520000-0000-4000-8000-000000000001',true);
    perform set_config('request.jwt.claims',
      '{"sub":"a6520000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal1"}',true);
    v_packet:=public.archived_dm_return_review_packet_v11(v_conversation);
    if v_packet->>'archived_lead_id'<>v_old::text
       or jsonb_array_length(v_packet->'messages')<>1 then
      raise exception 'The exact DM packet omitted retained evidence';
    end if;
    select id into v_request from public.approval_requests_v6
      where source_kind='archived_dm_return'
        and source_id=v_conversation::text
        and source_version=v_packet->>'source_hash';
    if v_request is null
       or public.archived_dm_return_inbox_source_state_v11(v_request)<>'pending'
       or not exists(select 1 from public.approval_inbox_v6
         where id=v_request and status='pending') then
      raise exception 'The exact DM has no pending canonical Inbox card: request %, source %, view %',
        v_request,
        case when v_request is null then null
          else public.archived_dm_return_inbox_source_state_v11(v_request) end,
        (select status from public.approval_inbox_v6 where id=v_request);
    end if;
    v_refused:=false;
    begin
      perform public.resolve_archived_dm_return_v11(v_conversation,v_action,
        v_packet->>'source_hash','Reviewed continuing relationship');
    exception when insufficient_privilege then v_refused:=true; end;
    if not v_refused then raise exception 'AAL1 decided an archived DM'; end if;
    if v_action='new_lead' then
      perform set_config('request.jwt.claim.role','service_role',true);
      perform set_config('request.jwt.claims','{"role":"service_role"}',true);
      perform public.record_inbound_dm_v6(v_client,'instagram',
        'dm-decision-'||v_action,'dm-decision-second-'||v_action,
        'One more detail','Returning DM',now());
      perform set_config('request.jwt.claim.role','authenticated',true);
      perform set_config('request.jwt.claims',
        '{"sub":"a6520000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal2"}',true);
      v_refused:=false;
      begin
        perform public.resolve_archived_dm_return_v11(v_conversation,v_action,
          v_packet->>'source_hash','Reviewed continuing relationship');
      exception when check_violation then v_refused:=true; end;
      if not v_refused then raise exception 'A changed DM kept its old approval'; end if;
      if public.archived_dm_return_inbox_source_state_v11(v_request)<>'superseded'
         then raise exception 'The old Inbox card was not staled'; end if;
      v_packet:=public.archived_dm_return_review_packet_v11(v_conversation);
      select id into v_request from public.approval_requests_v6
        where source_kind='archived_dm_return'
          and source_id=v_conversation::text
          and source_version=v_packet->>'source_hash';
    else
      perform set_config('request.jwt.claims',
        '{"sub":"a6520000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal2"}',true);
    end if;
    v_result:=public.resolve_archived_dm_return_v11(v_conversation,v_action,
      v_packet->>'source_hash','Reviewed continuing relationship');
    if (v_action='recover' and
        (v_result<>v_old or not exists(select 1 from public.client_leads
          where id=v_old) or exists(select 1 from public.archived_leads
          where id=v_old)))
       or (v_action='new_lead' and
        (v_result=v_old or not exists(select 1 from public.archived_leads
          where id=v_old) or not exists(select 1 from public.client_leads
          where id=v_result))) then
      raise exception 'The DM identity outcome was not preserved';
    end if;
    select to_jsonb(c) into v_current from public.dm_conversations c
      where c.id=v_conversation;
    if v_current->>'lead_id'<>v_result::text
       or v_current->>'status'<>'closed'
       or v_current->>'closed_reason'<>'reviewed_return'
       or not exists(select 1 from public.archived_dm_return_resolutions_v11 r
         where r.conversation_id=v_conversation
           and r.archived_lead_id=v_old and r.resolved_lead_id=v_result
           and r.action=v_action and r.reviewer_aal='aal2')
       or not exists(select 1 from public.approval_inbox_v6
         where id=v_request and status='approved')
       or exists(select 1 from public.dm_messages
         where conversation_id=v_conversation and direction='outbound') then
      raise exception 'The DM decision lacked audit or sent a reply';
    end if;
    v_refused:=false;
    begin
      perform public.resolve_archived_dm_return_v11(v_conversation,v_action,
        v_packet->>'source_hash','Reviewed continuing relationship');
    exception when check_violation then v_refused:=true; end;
    if not v_refused then raise exception 'A duplicate DM decision was accepted'; end if;
  end loop;
  perform set_config('request.jwt.claim.role','service_role',true);
  perform set_config('request.jwt.claim.sub','',true);
  perform set_config('request.jwt.claims','{"role":"service_role"}',true);
  insert into public.client_leads(client_id,name,stage,source,source_channel)
    values(v_client,'Two DM doors','conversation','direct_message','instagram')
    returning id into v_old;
  insert into public.dm_identities(client_id,platform,external_user_id,
    display_name,lead_id)
    values(v_client,'instagram','dm-decision-multi-instagram',
      'Two DM doors',v_old) returning id into v_identity;
  insert into public.dm_conversations(client_id,identity_id,platform,lead_id,
    status,closed_reason)
    values(v_client,v_identity,'instagram',v_old,'closed','finished')
    returning id into v_conversation;
  insert into public.dm_identities(client_id,platform,external_user_id,
    display_name,lead_id)
    values(v_client,'facebook','dm-decision-multi-facebook',
      'Two DM doors',v_old) returning id into v_identity;
  insert into public.dm_conversations(client_id,identity_id,platform,lead_id,
    status,closed_reason)
    values(v_client,v_identity,'facebook',v_old,'closed','finished')
    returning id into v_second_conversation;
  perform public.archive_lead(v_old,'Finished original relationship');
  perform public.record_inbound_dm_v6(v_client,'instagram',
    'dm-decision-multi-instagram','dm-decision-multi-ig-1',
    'Instagram arrival','Two DM doors',now());
  perform public.record_inbound_dm_v6(v_client,'facebook',
    'dm-decision-multi-facebook','dm-decision-multi-fb-1',
    'Facebook arrival','Two DM doors',now());
  perform set_config('request.jwt.claim.role','authenticated',true);
  perform set_config('request.jwt.claim.sub',
    'a6520000-0000-4000-8000-000000000001',true);
  perform set_config('request.jwt.claims',
    '{"sub":"a6520000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal2"}',true);
  v_packet:=public.archived_dm_return_review_packet_v11(v_conversation);
  v_refused:=false;
  begin
    perform public.resolve_archived_dm_return_v11(v_conversation,'recover',
      v_packet->>'source_hash','Two arrivals need one decision');
  exception when check_violation then v_refused:=true; end;
  if not v_refused or exists(select 1 from public.archived_dm_return_resolutions_v11
      where conversation_id in (v_conversation,v_second_conversation)) then
    raise exception 'Two DM doors bypassed coordinated review';
  end if;
end $fixture$;
rollback;

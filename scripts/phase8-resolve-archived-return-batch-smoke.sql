-- Two held sales doors: stale/AAL1 refusal, atomic recovery and one new lead.
begin;
insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
values ('a6490000-0000-4000-8000-000000000001',
  '00000000-0000-0000-0000-000000000000','authenticated','authenticated',
  'batch-decision@example.invalid','',now(),now());
insert into public.profiles(id,role,email)
values ('a6490000-0000-4000-8000-000000000001','admin',
  'batch-decision@example.invalid');
insert into public.clients(id,name,initials)
values ('b6490000-0000-4000-8000-000000000001','Batch decision fixture','BD');
select set_config('request.jwt.claim.role','service_role',true);
select set_config('request.jwt.claims','{"role":"service_role"}',true);
do $fixture$
declare cid uuid:='b6490000-0000-4000-8000-000000000001';
  agent_id uuid; old_id uuid; first_id uuid; second_id uuid;
  created_id uuid; packet jsonb; stale jsonb; refused boolean;
  cycle integer; chosen text;
  endpoint_id uuid; request_id uuid; review_id uuid;
  mixed_old uuid; mixed_form uuid; mixed_sales uuid; mixed_third uuid; capture jsonb;
begin
  insert into public.client_sales_agents(client_id,name,purpose)
    values(cid,'Batch decision agent','Capture two returning conversations')
    returning id into agent_id;
  for cycle in 1..2 loop
    chosen:=case cycle when 1 then 'recover' else 'new_lead' end;
    insert into public.client_leads(client_id,name,email,source,source_channel,stage)
      values(cid,'Archived original',
        'batch-decision-'||cycle::text||'@example.invalid',
        'sales_agent','sales_agent','conversation') returning id into old_id;
    perform public.archive_lead(old_id,'Finished original');
    insert into public.sales_agent_conversations(client_id,sales_agent_id,
      contact_name,contact_email,qualified,outcome,transcript)
      values(cid,agent_id,'First return',
        'batch-decision-'||cycle::text||'@example.invalid',true,
        'First conversation','[]'::jsonb) returning id into first_id;
    insert into public.sales_agent_conversations(client_id,sales_agent_id,
      contact_name,contact_email,qualified,outcome,transcript)
      values(cid,agent_id,'Second return',
        'batch-decision-'||cycle::text||'@example.invalid',false,
        'Second conversation','[]'::jsonb) returning id into second_id;
    if public.capture_sales_agent_lead(first_id) is not null
       or public.capture_sales_agent_lead(second_id) is not null then
      raise exception 'Archived batch was promoted before review'; end if;
    perform set_config('request.jwt.claim.role','authenticated',true);
    perform set_config('request.jwt.claim.sub',
      'a6490000-0000-4000-8000-000000000001',true);
    perform set_config('request.jwt.claims',
      '{"sub":"a6490000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal1"}',true);
    packet:=public.archived_return_batch_review_packet_v11(old_id);
    refused:=false;
    begin perform public.resolve_archived_return_batch_v11(old_id,chosen,
      packet->>'source_hash','Reviewed both returning conversations',
      case when chosen='new_lead' then 'sales_agent' else null end,
      case when chosen='new_lead' then first_id else null end);
    exception when insufficient_privilege then refused:=true; end;
    if not refused then raise exception 'AAL1 resolved a grouped identity'; end if;
    perform set_config('request.jwt.claims',
      '{"sub":"a6490000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal2"}',true);
    update public.sales_agent_conversations set contact_name='Later second turn'
      where id=second_id;
    refused:=false;
    begin perform public.resolve_archived_return_batch_v11(old_id,chosen,
      packet->>'source_hash','Reviewed both returning conversations',
      case when chosen='new_lead' then 'sales_agent' else null end,
      case when chosen='new_lead' then first_id else null end);
    exception when check_violation then refused:=true; end;
    if not refused then raise exception 'Stale grouped packet was accepted'; end if;
    stale:=public.archived_return_batch_review_packet_v11(old_id);
    if chosen='new_lead' then
      refused:=false;
      begin perform public.resolve_archived_return_batch_v11(old_id,chosen,
        stale->>'source_hash','Reviewed both returning conversations',
        'sales_agent','a6490000-0000-4000-8000-000000000099');
      exception when check_violation then refused:=true; end;
      if not refused then raise exception 'Unlisted primary source was accepted'; end if;
    end if;
    created_id:=public.resolve_archived_return_batch_v11(old_id,chosen,
      stale->>'source_hash','Reviewed both returning conversations',
      case when chosen='new_lead' then 'sales_agent' else null end,
      case when chosen='new_lead' then first_id else null end);
    if (chosen='recover' and created_id<>old_id)
       or (chosen='new_lead' and created_id=old_id)
       or (select count(*) from public.sales_agent_return_resolutions_v11
           where archived_lead_id=old_id and resolved_lead_id=created_id
             and batch_resolution_id is not null)<>2
       or (select count(*) from public.sales_agent_conversations
           where id in (first_id,second_id) and lead_id=created_id)<>2
       or (select count(*) from public.archived_return_batch_resolutions_v11
           where archived_lead_id=old_id and resolved_lead_id=created_id
             and action=chosen and source_count=2)<>1
       or (select count(*) from public.approval_inbox_v6
           where source_kind='archived_sales_return'
             and source_id in (first_id::text,second_id::text)
             and status='approved')<>2
       or (chosen='recover' and exists(select 1 from public.archived_leads
           where id=old_id))
       or (chosen='new_lead' and not exists(select 1 from public.archived_leads
           where id=old_id)) then
      raise exception 'Grouped decision did not atomically resolve both doors';
    end if;
    refused:=false;
    begin perform public.resolve_archived_return_batch_v11(old_id,chosen,
      stale->>'source_hash','Reviewed both returning conversations',
      case when chosen='new_lead' then 'sales_agent' else null end,
      case when chosen='new_lead' then first_id else null end);
    exception when insufficient_privilege or check_violation then refused:=true; end;
    if not refused then raise exception 'Duplicate batch decision was accepted'; end if;
    perform set_config('request.jwt.claim.role','service_role',true);
    perform set_config('request.jwt.claim.sub','',true);
    perform set_config('request.jwt.claims','{"role":"service_role"}',true);
  end loop;

  -- A form and a sales conversation resolve to one new lead. The form is
  -- explicitly chosen as the attributed primary source, with both doors
  -- retained as reviewed evidence.
  select id into endpoint_id from public.create_lead_capture_endpoint_v6(
    cid,'agent_handoff',repeat('9',64),'I agree to a reply',
    null,null,'organic');
  perform set_config('request.jwt.claim.role','authenticated',true);
  perform set_config('request.jwt.claim.sub',
    'a6490000-0000-4000-8000-000000000001',true);
  perform set_config('request.jwt.claims',
    '{"sub":"a6490000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal2"}',true);
  request_id:=public.request_lead_capture_activation_v6(endpoint_id);
  select id into review_id from public.client_switch_activation_reviews_v6
    where canonical_request_id=request_id;
  perform public.decide_client_switch_activation_v6(review_id,request_id,true);
  perform set_config('request.jwt.claim.role','service_role',true);
  perform set_config('request.jwt.claim.sub','',true);
  perform set_config('request.jwt.claims','{"role":"service_role"}',true);
  capture:=public.capture_lead_v6(repeat('9',64),'initial',
    p_name=>'Mixed original',p_email=>'mixed-batch@example.invalid',
    p_consented=>true);
  mixed_old:=(capture->>'lead_id')::uuid;
  if mixed_old is null then raise exception 'Initial mixed capture failed'; end if;
  perform public.archive_lead(mixed_old,'Finished mixed original');
  capture:=public.capture_lead_v6(repeat('9',64),'return',
    p_name=>'Mixed form arrival',p_email=>'mixed-batch@example.invalid',
    p_consented=>true,p_click_id=>'mixed-click');
  mixed_form:=(capture->>'submission_id')::uuid;
  if capture->>'pending_review'<>'true' then
    raise exception 'Mixed form was not held for identity review'; end if;
  insert into public.sales_agent_conversations(client_id,sales_agent_id,
    contact_name,contact_email,qualified,outcome,transcript)
    values(cid,agent_id,'Mixed sales arrival','mixed-batch@example.invalid',true,
      'Later sales contact','[]'::jsonb) returning id into mixed_sales;
  if public.capture_sales_agent_lead(mixed_sales) is not null then
    raise exception 'Mixed sales return promoted before review'; end if;
  perform set_config('request.jwt.claim.role','authenticated',true);
  perform set_config('request.jwt.claim.sub',
    'a6490000-0000-4000-8000-000000000001',true);
  perform set_config('request.jwt.claims',
    '{"sub":"a6490000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal2"}',true);
  packet:=public.archived_return_batch_review_packet_v11(mixed_old);
  if packet->>'source_count'<>'2' or packet->>'dm_count'<>'0' then
    raise exception 'Mixed source batch packet is incomplete'; end if;
  perform set_config('request.jwt.claim.role','service_role',true);
  perform set_config('request.jwt.claim.sub','',true);
  perform set_config('request.jwt.claims','{"role":"service_role"}',true);
  insert into public.sales_agent_conversations(client_id,sales_agent_id,
    contact_name,contact_email,qualified,outcome,transcript)
    values(cid,agent_id,'Third arrival','mixed-batch@example.invalid',false,
      'New arrival after review opened','[]'::jsonb) returning id into mixed_third;
  if public.capture_sales_agent_lead(mixed_third) is not null then
    raise exception 'Third arrival promoted before review'; end if;
  perform set_config('request.jwt.claim.role','authenticated',true);
  perform set_config('request.jwt.claim.sub',
    'a6490000-0000-4000-8000-000000000001',true);
  perform set_config('request.jwt.claims',
    '{"sub":"a6490000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal2"}',true);
  refused:=false;
  begin perform public.resolve_archived_return_batch_v11(mixed_old,'new_lead',
    packet->>'source_hash','Reviewed the form and sales contact together',
    'form',mixed_form);
  exception when check_violation then refused:=true; end;
  if not refused then raise exception 'A new third arrival did not stale the batch'; end if;
  packet:=public.archived_return_batch_review_packet_v11(mixed_old);
  if packet->>'source_count'<>'3' then
    raise exception 'Fresh grouped packet omitted the third arrival'; end if;
  created_id:=public.resolve_archived_return_batch_v11(mixed_old,'new_lead',
    packet->>'source_hash','Reviewed the form and sales contact together',
    'form',mixed_form);
  if created_id is null or created_id=mixed_old
     or not exists(select 1 from public.client_leads
       where id=created_id and client_id=cid and source='agent_handoff'
         and source_click_id='mixed-click'
         and consent_wording='I agree to a reply')
     or not exists(select 1 from public.lead_submissions
       where id=mixed_form and status='promoted' and lead_id=created_id)
     or not exists(select 1 from public.sales_agent_conversations
       where id=mixed_sales and lead_id=created_id)
     or not exists(select 1 from public.sales_agent_conversations
       where id=mixed_third and lead_id=created_id)
     or (select count(*) from public.approval_inbox_v6
       where source_id in (mixed_form::text,mixed_sales::text,mixed_third::text)
         and status='approved')<>3
     or not exists(select 1 from public.archived_leads where id=mixed_old) then
    raise exception 'Mixed batch lost source, consent or the archived history';
  end if;
end $fixture$;
rollback;

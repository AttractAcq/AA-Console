-- Exact, read-only coordination packet for two sales returns and an inbound DM.
begin;
insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
values ('a6470000-0000-4000-8000-000000000001',
  '00000000-0000-0000-0000-000000000000','authenticated','authenticated',
  'batch-review@example.invalid','',now(),now());
insert into public.profiles(id,role,email)
values ('a6470000-0000-4000-8000-000000000001','admin',
  'batch-review@example.invalid');
insert into public.clients(id,name,initials)
values ('b6470000-0000-4000-8000-000000000001','Batch return fixture','BR');
select set_config('request.jwt.claim.role','service_role',true);
select set_config('request.jwt.claims','{"role":"service_role"}',true);
do $fixture$
declare cid uuid:='b6470000-0000-4000-8000-000000000001';
  agent_id uuid; archived_id uuid; first_id uuid; second_id uuid;
  dm_archive_id uuid; dm_sales_id uuid; fake_batch_id uuid;
  packet jsonb; revised jsonb; with_dm jsonb; refused boolean;
begin
  insert into public.client_sales_agents(client_id,name,purpose)
    values(cid,'Batch fixture agent','Returning identity review')
    returning id into agent_id;
  insert into public.client_leads(client_id,name,email,source,source_channel,stage)
    values(cid,'Archived original','batch-return@example.invalid',
      'sales_agent','sales_agent','conversation') returning id into archived_id;
  insert into public.dm_identities(client_id,platform,external_user_id,
    display_name,lead_id)
  values(cid,'instagram','batch-fixture-user','DM return',archived_id);
  perform public.archive_lead(archived_id,'Finished original');
  insert into public.sales_agent_conversations(client_id,sales_agent_id,
    contact_name,contact_email,qualified,outcome,transcript)
    values(cid,agent_id,'First arrival','batch-return@example.invalid',true,
      'First conversation','[]'::jsonb) returning id into first_id;
  if public.capture_sales_agent_lead(first_id) is not null then
    raise exception 'First archived return became an active lead'; end if;

  perform set_config('request.jwt.claim.role','authenticated',true);
  perform set_config('request.jwt.claim.sub',
    'a6470000-0000-4000-8000-000000000001',true);
  perform set_config('request.jwt.claims',
    '{"sub":"a6470000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal1"}',true);
  packet:=public.archived_return_batch_review_packet_v11(archived_id);
  if packet->>'decision_state'<>'single_source' or packet->>'source_count'<>'1'
     then raise exception 'Single source overview implied a grouped decision'; end if;

  perform set_config('request.jwt.claim.role','service_role',true);
  perform set_config('request.jwt.claim.sub','',true);
  perform set_config('request.jwt.claims','{"role":"service_role"}',true);
  insert into public.sales_agent_conversations(client_id,sales_agent_id,
    contact_name,contact_email,qualified,outcome,transcript)
    values(cid,agent_id,'Second arrival','batch-return@example.invalid',false,
      'Second conversation','[]'::jsonb) returning id into second_id;
  if public.capture_sales_agent_lead(second_id) is not null then
    raise exception 'Second archived return became an active lead'; end if;

  perform set_config('request.jwt.claim.role','authenticated',true);
  perform set_config('request.jwt.claim.sub',
    'a6470000-0000-4000-8000-000000000099',true);
  perform set_config('request.jwt.claims',
    '{"sub":"a6470000-0000-4000-8000-000000000099","role":"authenticated","aal":"aal2"}',true);
  refused:=false;
  begin perform public.archived_return_batch_review_packet_v11(archived_id);
  exception when insufficient_privilege then refused:=true; end;
  if not refused then raise exception 'Unprovisioned user read grouped identities'; end if;

  perform set_config('request.jwt.claim.sub',
    'a6470000-0000-4000-8000-000000000001',true);
  perform set_config('request.jwt.claims',
    '{"sub":"a6470000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal2"}',true);
  packet:=public.archived_return_batch_review_packet_v11(archived_id);
  if packet->>'source_count'<>'2' or packet->>'dm_count'<>'0'
     or jsonb_array_length(packet->'sources')<>2
     or packet->>'source_hash' !~ '^[0-9a-f]{64}$'
     or packet->>'decision_state'<>'grouped_hold'
     or (select count(*) from public.approval_inbox_v6
       where client_id=cid and source_kind='archived_sales_return'
         and status='pending')<>2 then
    raise exception 'Batch packet lost source identity or implied approval';
  end if;
  refused:=false;
  begin
    insert into public.sales_agent_return_resolutions_v11(
      client_id,conversation_id,archived_lead_id,resolved_lead_id,
      action,reason,source_hash,reviewer_id,reviewer_aal)
    values(cid,first_id,archived_id,archived_id,'recover',
      'Tried only one arrival',
      public.sales_agent_return_review_packet_v11(first_id)->>'source_hash',
      'a6470000-0000-4000-8000-000000000001','aal2');
  exception when check_violation then refused:=true; end;
  if not refused then raise exception 'Direct resolution row bypassed grouped hold'; end if;
  insert into public.archived_return_batch_resolutions_v11(
    client_id,archived_lead_id,resolved_lead_id,action,reason,
    source_hash,source_count,reviewer_id,reviewer_aal)
  values(cid,archived_id,archived_id,'recover','Reviewed both arrivals',
    packet->>'source_hash',2,
    'a6470000-0000-4000-8000-000000000001','aal2')
  returning id into fake_batch_id;
  refused:=false;
  begin
    insert into public.sales_agent_return_resolutions_v11(
      client_id,conversation_id,archived_lead_id,resolved_lead_id,
      action,reason,source_hash,reviewer_id,reviewer_aal,batch_resolution_id)
    values(cid,first_id,archived_id,archived_id,'new_lead',
      'Mismatched grouped outcome',
      public.sales_agent_return_review_packet_v11(first_id)->>'source_hash',
      'a6470000-0000-4000-8000-000000000001','aal2',fake_batch_id);
  exception when check_violation then refused:=true; end;
  if not refused then raise exception 'Mismatched grouped decision marker was accepted'; end if;
  refused:=false;
  begin perform public.resolve_sales_agent_return_v11(first_id,'recover',
    public.sales_agent_return_review_packet_v11(first_id)->>'source_hash',
    'Reviewed only the first arrival');
  exception when check_violation then refused:=true; end;
  if not refused then raise exception 'Single return bypassed the grouped hold'; end if;

  update public.sales_agent_conversations set contact_name='Later second turn'
    where id=second_id;
  revised:=public.archived_return_batch_review_packet_v11(archived_id);
  if revised->>'source_hash'=packet->>'source_hash'
     or not exists(select 1 from jsonb_array_elements(revised->'sources') x
       where x->>'conversation_id'=second_id::text
         and x->>'current_name'='Later second turn') then
    raise exception 'Changed conversation did not stale the grouped packet';
  end if;

  perform set_config('request.jwt.claim.role','service_role',true);
  perform set_config('request.jwt.claim.sub','',true);
  perform set_config('request.jwt.claims','{"role":"service_role"}',true);
  perform public.record_inbound_dm_v6(cid,'instagram','batch-fixture-user',
    'batch-message-1','I came back','DM return',now());
  perform set_config('request.jwt.claim.role','authenticated',true);
  perform set_config('request.jwt.claim.sub',
    'a6470000-0000-4000-8000-000000000001',true);
  perform set_config('request.jwt.claims',
    '{"sub":"a6470000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal2"}',true);
  with_dm:=public.archived_return_batch_review_packet_v11(archived_id);
  if with_dm->>'dm_count'<>'1'
     or with_dm->>'source_count'<>'2'
     or with_dm->>'source_hash'=revised->>'source_hash'
     or with_dm->'dms'->0->>'source_hash' !~ '^[0-9a-f]{64}$'
     or not exists(select 1 from public.dm_conversations c
       where c.client_id=cid and c.status='closed'
         and c.closed_reason='archived_lead_return_review')
     or exists(select 1 from public.client_leads where client_id=cid) then
    raise exception 'DM return was hidden, reopened or promoted by review';
  end if;

  -- One sales arrival plus one held DM is also a grouped identity case.
  perform set_config('request.jwt.claim.role','service_role',true);
  perform set_config('request.jwt.claim.sub','',true);
  perform set_config('request.jwt.claims','{"role":"service_role"}',true);
  insert into public.client_leads(client_id,name,email,source,source_channel,stage)
    values(cid,'Other archived original','other-return@example.invalid',
      'sales_agent','sales_agent','conversation') returning id into dm_archive_id;
  insert into public.dm_identities(client_id,platform,external_user_id,
    display_name,lead_id)
    values(cid,'instagram','other-batch-user','Other DM return',dm_archive_id);
  perform public.archive_lead(dm_archive_id,'Finished other original');
  insert into public.sales_agent_conversations(client_id,sales_agent_id,
    contact_name,contact_email,qualified,outcome,transcript)
    values(cid,agent_id,'Other sales arrival','other-return@example.invalid',false,
      'Another conversation','[]'::jsonb) returning id into dm_sales_id;
  if public.capture_sales_agent_lead(dm_sales_id) is not null then
    raise exception 'Single sales archived return became an active lead'; end if;
  perform public.record_inbound_dm_v6(cid,'instagram','other-batch-user',
    'other-batch-message','Returning again','Other DM return',now());
  perform set_config('request.jwt.claim.role','authenticated',true);
  perform set_config('request.jwt.claim.sub',
    'a6470000-0000-4000-8000-000000000001',true);
  perform set_config('request.jwt.claims',
    '{"sub":"a6470000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal2"}',true);
  packet:=public.archived_return_batch_review_packet_v11(dm_archive_id);
  if packet->>'source_count'<>'1' or packet->>'dm_count'<>'1'
     or packet->>'decision_state'<>'grouped_hold' then
    raise exception 'One sales plus one DM failed grouped review'; end if;
  refused:=false;
  begin perform public.resolve_sales_agent_return_v11(dm_sales_id,'new_lead',
    public.sales_agent_return_review_packet_v11(dm_sales_id)->>'source_hash',
    'Cannot ignore the related DM arrival');
  exception when check_violation then refused:=true; end;
  if not refused or exists(select 1 from public.client_leads
      where client_id=cid and email='other-return@example.invalid') then
    raise exception 'Sales return bypassed the held DM or leaked a lead';
  end if;
end $fixture$;
rollback;

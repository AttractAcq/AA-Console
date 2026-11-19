-- An inbound DM against archived history is visible to the right lead
-- reviewer, exact across messages, and cannot be bypassed by Archive recovery.
begin;
insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
values ('a6500000-0000-4000-8000-000000000001',
  '00000000-0000-0000-0000-000000000000','authenticated','authenticated',
  'dm-review@example.invalid','',now(),now());
insert into public.profiles(id,role,email)
values ('a6500000-0000-4000-8000-000000000001','admin',
  'dm-review@example.invalid');
insert into public.clients(id,name,initials)
values ('b6500000-0000-4000-8000-000000000001','DM review fixture','DR');
select set_config('request.jwt.claim.role','service_role',true);
select set_config('request.jwt.claims','{"role":"service_role"}',true);
do $fixture$
declare cid uuid:='b6500000-0000-4000-8000-000000000001';
  old_id uuid; identity_id uuid; v_conversation_id uuid;
  first_packet jsonb; next_packet jsonb; refused boolean;
begin
  insert into public.client_leads(client_id,name,stage,source,source_channel)
    values(cid,'DM original','conversation','direct_message','instagram')
    returning id into old_id;
  insert into public.dm_identities(client_id,platform,external_user_id,
    display_name,lead_id)
    values(cid,'instagram','dm-review-fixture-user','DM original',old_id)
    returning id into identity_id;
  insert into public.dm_conversations(client_id,identity_id,platform,lead_id,
    status,closed_reason)
    values(cid,identity_id,'instagram',old_id,'closed','finished')
    returning id into v_conversation_id;
  perform public.archive_lead(old_id,'Finished DM history');
  perform public.record_inbound_dm_v6(cid,'instagram','dm-review-fixture-user',
    'dm-review-first','Hello again','DM returning',now());
  perform set_config('request.jwt.claim.role','authenticated',true);
  perform set_config('request.jwt.claim.sub',
    'a6500000-0000-4000-8000-000000000099',true);
  perform set_config('request.jwt.claims',
    '{"sub":"a6500000-0000-4000-8000-000000000099","role":"authenticated","aal":"aal2"}',true);
  refused:=false;
  begin perform public.archived_dm_return_review_packet_v11(v_conversation_id);
  exception when insufficient_privilege then refused:=true; end;
  if not refused then raise exception 'Unprovisioned reviewer read an archived DM'; end if;
  perform set_config('request.jwt.claim.sub',
    'a6500000-0000-4000-8000-000000000001',true);
  perform set_config('request.jwt.claims',
    '{"sub":"a6500000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal2"}',true);
  first_packet:=public.archived_dm_return_review_packet_v11(v_conversation_id);
  if first_packet->>'archived_lead_id'<>old_id::text
     or first_packet->>'identity_id'<>identity_id::text
     or first_packet->>'source_hash' !~ '^[0-9a-f]{64}$'
     or jsonb_array_length(first_packet->'messages')<>1
     or first_packet->'messages'->0->>'body'<>'Hello again'
     or (select count(*) from public.list_archived_dm_returns_v11(cid))<>1 then
    raise exception 'Exact DM review packet or due list omitted its source';
  end if;
  refused:=false;
  begin perform public.recover_lead(old_id);
  exception when check_violation then refused:=true; end;
  if not refused or exists(select 1 from public.client_leads where id=old_id) then
    raise exception 'Archive recovery bypassed the held DM';
  end if;
  perform set_config('request.jwt.claim.role','service_role',true);
  perform set_config('request.jwt.claim.sub','',true);
  perform set_config('request.jwt.claims','{"role":"service_role"}',true);
  perform public.record_inbound_dm_v6(cid,'instagram','dm-review-fixture-user',
    'dm-review-second','I have another question','DM returning',now());
  perform public.record_inbound_dm_v6(cid,'instagram','dm-review-fixture-user',
    'dm-review-second','I have another question','DM returning',now());
  perform set_config('request.jwt.claim.role','authenticated',true);
  perform set_config('request.jwt.claim.sub',
    'a6500000-0000-4000-8000-000000000001',true);
  perform set_config('request.jwt.claims',
    '{"sub":"a6500000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal2"}',true);
  next_packet:=public.archived_dm_return_review_packet_v11(v_conversation_id);
  if next_packet->>'source_hash'=first_packet->>'source_hash'
     or jsonb_array_length(next_packet->'messages')<>2
     or (select count(*) from public.dm_messages
       where conversation_id=v_conversation_id)<>2
     or not exists(select 1 from public.dm_conversations
       where id=v_conversation_id and status='closed'
         and closed_reason='archived_lead_return_review') then
    raise exception 'A new DM failed to stale the review or reopened its thread';
  end if;
end $fixture$;
rollback;

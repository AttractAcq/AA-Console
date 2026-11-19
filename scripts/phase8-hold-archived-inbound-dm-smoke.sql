-- An archived contact may message again. Store the inbound event, preserve the
-- historical lead identity and leave reply/reopening behind human review.
begin;
insert into public.clients(id,name,initials)
values ('b6420000-0000-4000-8000-000000000001','Archived DM fixture','DM');
select set_config('request.jwt.claim.role','service_role',true);
select set_config('request.jwt.claims','{"role":"service_role"}',true);
do $fixture$
declare
  cid uuid:='b6420000-0000-4000-8000-000000000001';
  lid uuid; iid uuid; conversation uuid; answer record; second record;
begin
  insert into public.client_leads(client_id,name,stage,source,source_channel)
    values(cid,'DM archive fixture','conversation','direct_message','instagram')
    returning id into lid;
  insert into public.dm_identities(client_id,platform,external_user_id,lead_id)
    values(cid,'instagram','archived-dm-fixture',lid) returning id into iid;
  insert into public.dm_conversations(client_id,identity_id,platform,lead_id,
    status,closed_reason)
    values(cid,iid,'instagram',lid,'closed','finished') returning id into conversation;
  perform public.archive_lead(lid,'Finished DM fixture');
  select * into answer from public.record_inbound_dm_v6(cid,'instagram',
    'archived-dm-fixture','archived-dm-msg-1','Hello again',null,now());
  if answer.conversation_id is distinct from conversation or answer.lead_id is not null
    or exists(select 1 from public.client_leads where id=lid)
    or not exists(select 1 from public.dm_conversations where id=conversation
      and status='closed' and closed_reason='archived_lead_return_review'
      and unread_inbound=1 and lead_id=lid)
    or not exists(select 1 from public.dm_messages where conversation_id=conversation
      and external_message_id='archived-dm-msg-1' and body='Hello again')
    or public.dm_reply_refusal_v6(conversation) is null then
    raise exception 'Archived inbound DM was not preserved and held';
  end if;
  select * into second from public.record_inbound_dm_v6(cid,'instagram',
    'archived-dm-fixture','archived-dm-msg-1','Hello again',null,now());
  if second.conversation_id is distinct from conversation
    or (select count(*) from public.dm_messages where conversation_id=conversation)<>1
    or (select unread_inbound from public.dm_conversations where id=conversation)<>1 then
    raise exception 'Archived DM replay created a second event';
  end if;
  -- An existing identity may lack a conversation after an older import.
  delete from public.dm_messages where conversation_id=conversation;
  delete from public.dm_conversations where id=conversation;
  select * into answer from public.record_inbound_dm_v6(cid,'instagram',
    'archived-dm-fixture','archived-dm-msg-2','Second message',null,now());
  if answer.lead_id is not null or not exists(
    select 1 from public.dm_conversations where id=answer.conversation_id
      and lead_id is null and status='closed'
      and closed_reason='archived_lead_return_review') then
    raise exception 'Imported archived DM thread was reopened';
  end if;
end $fixture$;
rollback;

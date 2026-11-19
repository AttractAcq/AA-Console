-- Keep an inbound DM from an archived contact while refusing automatic
-- reactivation or reply. Historical identity remains linked to the archive.
begin;
create or replace function public.record_inbound_dm_v6(
  p_client_id uuid, p_platform text, p_external_user_id text,
  p_external_message_id text, p_body text, p_display_name text default null,
  p_occurred_at timestamptz default null)
returns table (conversation_id uuid, lead_id uuid, is_new boolean)
language plpgsql security definer
set search_path = pg_catalog, public as $fn$
declare
  v_identity public.dm_identities%rowtype;
  v_conversation public.dm_conversations%rowtype;
  v_lead public.client_leads%rowtype;
  v_at timestamptz := coalesce(p_occurred_at, now());
  v_new boolean := false;
  v_existing record;
  v_archived boolean := false;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Only the internal service may record an inbound message.';
  end if;
  if p_platform not in ('instagram', 'facebook') then
    raise exception 'Unknown platform.';
  end if;
  if nullif(btrim(coalesce(p_external_user_id, '')), '') is null then
    raise exception 'An inbound message needs the sender''s scoped id.';
  end if;

  -- Meta re-delivers. The platform's message id is the only thing that makes
  -- the second delivery a no-op.
  if p_external_message_id is not null then
    select c.id as cid, c.lead_id as lid into v_existing
      from public.dm_messages m
      join public.dm_conversations c on c.id = m.conversation_id
     where m.client_id = p_client_id and m.external_message_id = p_external_message_id
     limit 1;
    if v_existing.cid is not null then
      return query select v_existing.cid, v_existing.lid, false;
      return;
    end if;
  end if;

  select * into v_identity from public.dm_identities
   where client_id = p_client_id and platform = p_platform
     and external_user_id = p_external_user_id;

  if v_identity.id is null then
    insert into public.dm_identities (
      client_id, platform, external_user_id, display_name, last_seen_at)
    values (p_client_id, p_platform, p_external_user_id,
            nullif(btrim(coalesce(p_display_name, '')), ''), v_at)
    returning * into v_identity;
    v_new := true;
  else
    update public.dm_identities
       set last_seen_at = v_at,
           display_name = coalesce(nullif(btrim(coalesce(p_display_name, '')), ''), display_name)
     where id = v_identity.id returning * into v_identity;
  end if;

  -- A person in a DM is a lead. Created at `conversation` rather than
  -- `lead`, because they have done more than hand over an address.
  --
  -- No consent is recorded. They messaged a business, which is consent to be
  -- answered in that thread and nothing else, so the governed send path will
  -- refuse to email them. That is correct.
  if v_identity.lead_id is null then
    insert into public.client_leads (
      client_id, name, stage, source, source_channel)
    values (p_client_id, coalesce(v_identity.display_name, 'A ' || p_platform || ' conversation'),
            'conversation', 'direct_message', p_platform)
    returning * into v_lead;
    update public.dm_identities set lead_id = v_lead.id where id = v_identity.id;
    v_identity.lead_id := v_lead.id;
  end if;

  -- The durable identity survives archive. Serialize with archive_lead's row
  -- lock, then retain the inbound message without reopening archived work.
  if v_identity.lead_id is not null then
    perform 1 from public.client_leads l
      where l.id=v_identity.lead_id and l.client_id=p_client_id for key share;
    v_archived:=not found;
  end if;

  select * into v_conversation from public.dm_conversations
   where client_id = p_client_id and identity_id = v_identity.id;

  if v_conversation.id is null then
    -- The active-reference trigger forbids attaching an archived lead to a
    -- new operational conversation. The identity retains the historical link.
    insert into public.dm_conversations (
      client_id, identity_id, platform, lead_id, last_inbound_at,
      window_expires_at, unread_inbound, status, closed_reason)
    values (p_client_id, v_identity.id, p_platform,
            case when v_archived then null else v_identity.lead_id end,
            v_at, v_at + interval '24 hours', 1,
            case when v_archived then 'closed' else 'open' end,
            case when v_archived then 'archived_lead_return_review' else null end)
    returning * into v_conversation;
  elsif v_archived then
    -- Do not update lead_id: the active-reference guard correctly rejects a
    -- new operational reference to an archived lead, even if unchanged.
    update public.dm_conversations
       set last_inbound_at=v_at,
           window_expires_at=v_at + interval '24 hours',
           unread_inbound=unread_inbound + 1,
           status='closed', closed_reason='archived_lead_return_review'
     where id=v_conversation.id returning * into v_conversation;
  else
    update public.dm_conversations
       set last_inbound_at = v_at,
           window_expires_at = v_at + interval '24 hours',
           unread_inbound = unread_inbound + 1,
           status = 'open', closed_reason = null,
           lead_id = coalesce(dm_conversations.lead_id, v_identity.lead_id)
     where id = v_conversation.id returning * into v_conversation;
  end if;

  insert into public.dm_messages (
    conversation_id, client_id, direction, external_message_id, body, occurred_at)
  values (v_conversation.id, p_client_id, 'inbound', p_external_message_id,
          nullif(btrim(coalesce(p_body, '')), ''), v_at);

  return query select v_conversation.id,
    case when v_archived then null::uuid else v_identity.lead_id end, v_new;
end $fn$;

comment on function public.record_inbound_dm_v6(uuid,text,text,text,text,text,timestamptz) is
  'Records inbound DM exactly once. Archived contacts stay closed for review while their messages are retained.';
select public.lock_down_definer_functions();
commit;

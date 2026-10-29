-- G01: somewhere for a conversation to live.
--
-- There is no DM path in this system at all. No webhook, no adapter, no
-- record of a conversation. Template P3's destination is `message`, so it
-- buys conversations that nothing can hold, and the flagship journey --
-- ad, profile, trust, DM, booked call -- has a person watching an inbox in
-- the middle of it with nothing written down.
--
-- WHAT A DM IS NOT
--
-- It is not email with a different address. Meta permits a business to reply
-- only inside a window the person opened by messaging first, and that window
-- closes. `message_channels.can_initiate` has recorded this since 248; here
-- it becomes enforcement, because a reply queued on Friday and sent on
-- Monday is a reply Meta rejects and a prospect never sees.
--
-- SO THE WINDOW IS A COLUMN, NOT A COMMENT
--
-- `window_expires_at` moves forward every time the person writes. Queueing a
-- reply checks it, and the sweep checks it again at the claim -- the same
-- shape as suppression in 249, and for the same reason: the gap between
-- deciding and sending is where the thing goes stale.
--
-- IDEMPOTENCY IS NOT OPTIONAL HERE
--
-- Meta re-delivers webhooks, deliberately and often. Every inbound message
-- therefore keys on the platform's own message id, so the third delivery of
-- somebody's "yes please" does not become three leads, three conversations
-- and three replies.

create table if not exists public.dm_identities (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  platform text not null check (platform in ('instagram', 'facebook')),
  -- The platform's own scoped id for this person against this business. Not
  -- an account name: those change, and a scoped id is what the API answers.
  external_user_id text not null,
  display_name text,
  lead_id uuid references public.client_leads(id) on delete set null,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  unique (client_id, platform, external_user_id)
);

comment on table public.dm_identities is
  'A person as a platform knows them, tied to the lead they turned out to be. The scoped id rather than a handle, because handles change and a scoped id is what the API gives us.';

create table if not exists public.dm_conversations (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  identity_id uuid not null references public.dm_identities(id) on delete cascade,
  platform text not null check (platform in ('instagram', 'facebook')),
  lead_id uuid references public.client_leads(id) on delete set null,
  campaign_id uuid references public.client_campaigns(id) on delete set null,

  last_inbound_at timestamptz,
  last_outbound_at timestamptz,
  -- Twenty-four hours after their last message. The whole reason a DM is not
  -- email.
  window_expires_at timestamptz,
  unread_inbound integer not null default 0,

  status text not null default 'open' check (status in ('open', 'closed')),
  closed_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (client_id, identity_id)
);

comment on table public.dm_conversations is
  'One thread with one person. window_expires_at is the only thing standing between a reply that arrives and one the platform silently drops.';

create index if not exists dm_conversations_client_idx
  on public.dm_conversations (client_id, last_inbound_at desc);
create index if not exists dm_conversations_open_idx
  on public.dm_conversations (client_id, window_expires_at)
  where status = 'open' and unread_inbound > 0;

create table if not exists public.dm_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.dm_conversations(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  direction text not null check (direction in ('inbound', 'outbound')),
  -- The platform's id. Unique per client, which is what makes a re-delivered
  -- webhook a no-op rather than a duplicate.
  external_message_id text,
  body text,
  -- Set when the reply went through the governed send path, so a message
  -- here can be traced to the approval that allowed it.
  outbound_message_id uuid references public.outbound_messages(id) on delete set null,
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

comment on table public.dm_messages is
  'Every message either way. An outbound one points at the governed send that produced it, so "who said this could be sent" has an answer per message.';

create unique index if not exists dm_messages_external_idx
  on public.dm_messages (client_id, external_message_id)
  where external_message_id is not null;
create index if not exists dm_messages_conversation_idx
  on public.dm_messages (conversation_id, occurred_at);

alter table public.dm_identities enable row level security;
alter table public.dm_conversations enable row level security;
alter table public.dm_messages enable row level security;
drop policy if exists dm_identities_read on public.dm_identities;
create policy dm_identities_read on public.dm_identities
  for select to authenticated using (public.can_access_client(client_id));
drop policy if exists dm_conversations_read on public.dm_conversations;
create policy dm_conversations_read on public.dm_conversations
  for select to authenticated using (public.can_access_client(client_id));
drop policy if exists dm_messages_read on public.dm_messages;
create policy dm_messages_read on public.dm_messages
  for select to authenticated using (public.can_access_client(client_id));
grant select on public.dm_identities, public.dm_conversations, public.dm_messages
  to authenticated;
grant all on public.dm_identities, public.dm_conversations, public.dm_messages
  to service_role;

drop trigger if exists dm_conversations_updated_at on public.dm_conversations;
create trigger dm_conversations_updated_at before update on public.dm_conversations
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- An inbound message
-- ---------------------------------------------------------------------------

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

  select * into v_conversation from public.dm_conversations
   where client_id = p_client_id and identity_id = v_identity.id;

  if v_conversation.id is null then
    insert into public.dm_conversations (
      client_id, identity_id, platform, lead_id, last_inbound_at,
      window_expires_at, unread_inbound)
    values (p_client_id, v_identity.id, p_platform, v_identity.lead_id, v_at,
            v_at + interval '24 hours', 1)
    returning * into v_conversation;
  else
    update public.dm_conversations
       set last_inbound_at = v_at,
           -- Every inbound message reopens the window.
           window_expires_at = v_at + interval '24 hours',
           unread_inbound = unread_inbound + 1,
           status = 'open', closed_reason = null,
           -- Qualified: `lead_id` is also one of this function's OUT
           -- parameters, so the bare name is ambiguous here. It only bites on
           -- the second message, which is a good way to ship a bug.
           lead_id = coalesce(dm_conversations.lead_id, v_identity.lead_id)
     where id = v_conversation.id returning * into v_conversation;
  end if;

  insert into public.dm_messages (
    conversation_id, client_id, direction, external_message_id, body, occurred_at)
  values (v_conversation.id, p_client_id, 'inbound', p_external_message_id,
          nullif(btrim(coalesce(p_body, '')), ''), v_at);

  return query select v_conversation.id, v_identity.lead_id, v_new;
end $fn$;

comment on function public.record_inbound_dm_v6(uuid, text, text, text, text, text, timestamptz) is
  'Records one inbound message, creating the identity, the lead and the conversation if they are new, and reopening the reply window. Idempotent on the platform''s message id, because Meta re-delivers.';

revoke all on function public.record_inbound_dm_v6(uuid, text, text, text, text, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.record_inbound_dm_v6(uuid, text, text, text, text, text, timestamptz)
  to service_role;

-- ---------------------------------------------------------------------------
-- Replying inside the window
-- ---------------------------------------------------------------------------

create or replace function public.dm_reply_refusal_v6(p_conversation_id uuid)
returns text language plpgsql stable security definer
set search_path = pg_catalog, public as $fn$
declare c public.dm_conversations%rowtype;
begin
  select * into c from public.dm_conversations where id = p_conversation_id;
  if not found then return 'That conversation does not exist.'; end if;
  if c.status = 'closed' then
    return 'That conversation is closed' || coalesce(': ' || c.closed_reason, '') || '.';
  end if;
  if c.lead_id is null then return 'That conversation has no lead attached.'; end if;
  if c.window_expires_at is null or c.window_expires_at <= now() then
    -- The honest sentence. Nothing we can do opens it again.
    return 'The reply window closed at '
      || coalesce(to_char(c.window_expires_at, 'YYYY-MM-DD HH24:MI'), 'an unknown time')
      || '. Only another message from them reopens it.';
  end if;
  return null;
end $fn$;

comment on function public.dm_reply_refusal_v6(uuid) is
  'Why this conversation cannot be replied to, or null. The window is the platform''s rule, not ours, and nothing on our side reopens it.';

revoke all on function public.dm_reply_refusal_v6(uuid) from public, anon;
grant execute on function public.dm_reply_refusal_v6(uuid) to authenticated, service_role;

drop view if exists dm_conversation_due;

create view dm_conversation_due with (security_invoker = true) as
select
  c.id as conversation_id,
  c.client_id,
  c.platform,
  c.lead_id,
  c.campaign_id,
  i.display_name,
  i.external_user_id,
  c.status,
  c.unread_inbound,
  c.last_inbound_at,
  c.last_outbound_at,
  c.window_expires_at,
  (c.window_expires_at > now()) as window_open,
  -- Hours left to answer. The number that decides whether this is urgent.
  case when c.window_expires_at > now()
       then round(extract(epoch from (c.window_expires_at - now())) / 3600, 1)
       else 0 end as hours_left,
  (select body from public.dm_messages m
    where m.conversation_id = c.id and m.direction = 'inbound'
    order by m.occurred_at desc limit 1) as last_inbound_body,
  public.dm_reply_refusal_v6(c.id) as blocker
from public.dm_conversations c
join public.dm_identities i on i.id = c.identity_id;

comment on view dm_conversation_due is
  'Open threads, what they last said, and how long is left to answer. hours_left is the number that matters: once it reaches zero only another message from them reopens the window.';

grant select on dm_conversation_due to authenticated;

select lock_down_definer_functions();

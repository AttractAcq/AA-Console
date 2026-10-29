-- G01, the reply: teaching the governed send path about a thread.
--
-- 249's queue resolved an address from the lead's email or phone, because
-- those were the only channels that existed. A DM has neither: the address
-- is the platform's scoped id, and it lives on the conversation.
--
-- WHY A DM NEEDS NO CONSENT ROW AND STILL IS NOT A FREE PASS
--
-- Somebody who messages a business has consented to be answered in that
-- thread. They have not consented to an email, and they have not consented
-- to being messaged next month. So the DM branch skips the consent check --
-- which would otherwise refuse every reply, since nothing records consent
-- for a person who simply wrote to us -- and instead the window is the
-- constraint. The consent for a DM is the thread, and the thread expires.
--
-- Suppression still applies. A person who asked not to be contacted has
-- asked, whatever surface they asked on.
--
-- WHAT STAYS UNCHANGED
--
-- Every other refusal in 249, in the same order and the same words. The only
-- additions are the DM address, the window, and the thread's own record of
-- the reply pointing at the approval that allowed it.

create or replace function public.queue_lead_message_v6(
  p_lead_id uuid, p_template_version_id uuid)
returns public.outbound_messages language plpgsql security definer
set search_path = pg_catalog, public as $fn$
declare
  l public.client_leads%rowtype;
  v public.message_template_versions%rowtype;
  t public.message_templates%rowtype;
  a public.message_template_approvals%rowtype;
  ch public.message_channels%rowtype;
  m public.outbound_messages%rowtype;
  v_address text;
  v_conversation uuid;
  v_refusal text;
  v_sent_today integer;
  v_cap integer;
  v_key text;
begin
  select * into l from public.client_leads where id = p_lead_id;
  if not found then raise exception 'No such lead.' using errcode = 'P0001'; end if;
  if coalesce(auth.role(), '') <> 'service_role'
     and not (coalesce(public.is_admin(), false)
              or coalesce(public.can_access_client(l.client_id), false)) then
    raise exception 'Not permitted for this client.' using errcode = 'P0001';
  end if;
  if l.is_probe then
    raise exception 'That is a probe lead. Messaging it would be testing the wrong thing.'
      using errcode = 'P0001';
  end if;

  select * into v from public.message_template_versions where id = p_template_version_id;
  if not found then raise exception 'No such message version.' using errcode = 'P0001'; end if;
  select * into t from public.message_templates where id = v.template_id;
  if t.client_id <> l.client_id then
    raise exception 'That message belongs to a different client.' using errcode = 'P0001';
  end if;

  select * into ch from public.message_channels where channel_key = t.channel_key;
  if not coalesce(ch.supported, false) then
    raise exception 'There is no transport for %: %', t.channel_key, ch.note
      using errcode = 'P0001';
  end if;

  select * into a from public.message_template_approvals
   where template_version_id = p_template_version_id
     and channel_key = t.channel_key and status = 'approved';
  if not found then
    raise exception 'No standing approval for this version on %. A changed word is a new version and needs its own.',
      t.channel_key using errcode = 'P0001';
  end if;

  if t.channel_key in ('instagram_dm', 'messenger') then
    -- The address is the thread, so the thread has to exist.
    select c.id into v_conversation from public.dm_conversations c
      join public.dm_identities i on i.id = c.identity_id
     where c.lead_id = p_lead_id
       and i.platform = case t.channel_key when 'instagram_dm' then 'instagram'
                                           else 'facebook' end
     order by c.last_inbound_at desc nulls last limit 1;
    if v_conversation is null then
      raise exception 'This lead has no % conversation to reply in.', t.channel_key
        using errcode = 'P0001';
    end if;
    v_refusal := public.dm_reply_refusal_v6(v_conversation);
    if v_refusal is not null then
      raise exception '%', v_refusal using errcode = 'P0001';
    end if;
    select i.external_user_id into v_address
      from public.dm_conversations c
      join public.dm_identities i on i.id = c.identity_id
     where c.id = v_conversation;
  else
    if l.consent_given_at is null then
      raise exception 'This lead has no recorded consent, so nothing may be sent to them.'
        using errcode = 'P0001';
    end if;
    v_address := case t.channel_key
      when 'email' then l.email
      when 'sms' then l.phone
      when 'whatsapp' then l.phone
      else null end;
  end if;

  if exists (select 1 from public.lead_suppressions s
              where s.client_id = l.client_id and s.dedupe_key = l.dedupe_key) then
    raise exception 'This person is suppressed for this client. Nothing may be sent to them.'
      using errcode = 'P0001';
  end if;

  select coalesce(outbound_daily_cap, 200) into v_cap
    from public.client_engine_settings where client_id = l.client_id;
  v_cap := coalesce(v_cap, 200);
  select count(*)::int into v_sent_today from public.outbound_messages
   where client_id = l.client_id and created_at >= date_trunc('day', now());
  if v_sent_today >= v_cap then
    raise exception 'This client''s daily message cap of % is spent. Nothing further is queued today.',
      v_cap using errcode = 'P0001';
  end if;

  if nullif(btrim(coalesce(v_address, '')), '') is null then
    raise exception 'This lead has no % address.', t.channel_key using errcode = 'P0001';
  end if;

  v_key := p_lead_id::text || ':' || p_template_version_id::text;

  insert into public.outbound_messages (
    client_id, lead_id, template_version_id, approval_id, channel_key, campaign_id,
    address, rendered_subject, rendered_body, consent_given_at, consent_wording,
    idempotency_key)
  values (
    l.client_id, p_lead_id, p_template_version_id, a.id, t.channel_key,
    coalesce(t.campaign_id, l.source_client_campaign_id),
    btrim(v_address), v.subject, public.render_message_v6(v.body, l),
    l.consent_given_at, l.consent_wording, v_key)
  on conflict (idempotency_key) do nothing
  returning * into m;

  if m.id is null then
    select * into m from public.outbound_messages where idempotency_key = v_key;
  end if;

  -- The thread keeps its own record, pointing at the governed send, so a
  -- message read in the inbox can be traced to the approval that allowed it.
  if v_conversation is not null and m.id is not null then
    insert into public.dm_messages (
      conversation_id, client_id, direction, body, outbound_message_id, occurred_at)
    select v_conversation, l.client_id, 'outbound', m.rendered_body, m.id, now()
     where not exists (
       select 1 from public.dm_messages d where d.outbound_message_id = m.id);
    update public.dm_conversations
       set unread_inbound = 0, last_outbound_at = now()
     where id = v_conversation;
  end if;
  return m;
end $fn$;

revoke all on function public.queue_lead_message_v6(uuid, uuid) from public, anon;
grant execute on function public.queue_lead_message_v6(uuid, uuid) to authenticated, service_role;

-- The sweep re-checks the window at the claim, for the same reason it
-- re-checks suppression: a reply queued with two hours left and claimed
-- three hours later is a reply the platform drops.
create or replace function public.claim_outbound_messages(p_limit integer default 10)
returns table (
  message_id uuid, client_id uuid, lead_id uuid, channel_key text,
  address text, rendered_subject text, rendered_body text, attempts integer)
language plpgsql security definer
set search_path = pg_catalog, public as $fn$
begin
  if auth.role() <> 'service_role' then
    raise exception 'Only the internal service may claim messages.';
  end if;
  return query
  with claimable as (
    select m.id from public.outbound_messages m
    join public.client_engine_settings s on s.client_id = m.client_id
    join public.message_template_approvals a on a.id = m.approval_id
    join public.message_channels ch on ch.channel_key = m.channel_key
    where m.status in ('queued', 'sending')
      and (m.lease_until is null or m.lease_until < now())
      and m.attempts < 5
      and s.outbound_messaging_enabled
      and a.status = 'approved'
      and ch.supported
      and not exists (
        select 1 from public.lead_suppressions sup
         join public.client_leads l on l.id = m.lead_id
         where sup.client_id = m.client_id and sup.dedupe_key = l.dedupe_key)
      -- A DM whose window has closed is not claimable. Left queued rather
      -- than failed, because `outbound_message_due` can then say why.
      and (m.channel_key not in ('instagram_dm', 'messenger')
           or exists (
             select 1 from public.dm_messages d
              join public.dm_conversations c on c.id = d.conversation_id
              where d.outbound_message_id = m.id and c.window_expires_at > now()))
    order by m.created_at
    limit greatest(coalesce(p_limit, 10), 1)
    for update of m skip locked
  )
  update public.outbound_messages m
     set status = 'sending', attempts = m.attempts + 1,
         claimed_at = now(), lease_until = now() + interval '5 minutes'
   where m.id in (select id from claimable)
  returning m.id, m.client_id, m.lead_id, m.channel_key, m.address,
            m.rendered_subject, m.rendered_body, m.attempts;
end $fn$;

revoke all on function public.claim_outbound_messages(integer) from public, anon, authenticated;
grant execute on function public.claim_outbound_messages(integer) to service_role;

drop view if exists outbound_message_due;

create view outbound_message_due with (security_invoker = true) as
select
  m.id as message_id,
  m.client_id,
  m.lead_id,
  m.campaign_id,
  m.channel_key,
  m.status,
  m.attempts,
  m.sent_at,
  m.external_id,
  m.last_error,
  t.name as template_name,
  t.purpose,
  v.version as template_version,
  a.status as approval_status,
  a.consent_basis,
  case
    when m.status = 'sent' then null
    when m.status = 'cancelled' then coalesce(m.last_error, 'Cancelled.')
    when a.status <> 'approved'
      then 'The approval for this version was revoked' ||
           coalesce(': ' || a.revoked_reason, '') || '.'
    when not ch.supported
      then 'There is no transport for ' || m.channel_key || '. ' || ch.note
    when exists (select 1 from public.lead_suppressions sup
                  join public.client_leads l on l.id = m.lead_id
                  where sup.client_id = m.client_id and sup.dedupe_key = l.dedupe_key)
      then 'That person is suppressed for this client, so this will never send.'
    when m.channel_key in ('instagram_dm', 'messenger')
         and not exists (
           select 1 from public.dm_messages d
            join public.dm_conversations c on c.id = d.conversation_id
            where d.outbound_message_id = m.id and c.window_expires_at > now())
      then 'The reply window on that conversation has closed, so this will never send. Only another message from them reopens it.'
    when not coalesce(s.outbound_messaging_enabled, false)
      then 'Outbound messaging is off for this client.'
    when m.status = 'failed'
      then 'Failed after ' || m.attempts::text || ' attempts: ' ||
           coalesce(m.last_error, 'no error recorded') || '.'
    when m.attempts >= 5 then 'Five attempts have been made. It needs a person.'
    else null
  end as blocker
from public.outbound_messages m
join public.message_template_versions v on v.id = m.template_version_id
join public.message_templates t on t.id = v.template_id
join public.message_template_approvals a on a.id = m.approval_id
join public.message_channels ch on ch.channel_key = m.channel_key
left join public.client_engine_settings s on s.client_id = m.client_id;

comment on view outbound_message_due is
  'Every governed message and what stops it. A closed DM window is called out as never sending, because unlike a switch nothing on our side can reopen it.';

grant select on outbound_message_due to authenticated;

-- Both Meta channels get a transport. can_initiate stays false: the window
-- is the platform's rule and no adapter changes it.
update public.message_channels set supported = true, transport = 'meta_send_api', note =
  'Replies through the Meta Send API, inside the window the person opened by messaging first. Cannot start a conversation and cannot reopen a closed window. Needs the messaging permissions Meta grants by app review.'
 where channel_key in ('instagram_dm', 'messenger');

select lock_down_definer_functions();

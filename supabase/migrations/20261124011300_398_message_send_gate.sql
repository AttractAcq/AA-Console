-- Bind every queued and claimed send to a current exact Inbox decision.
begin;
create function public.message_template_approval_current_v6(p_approval_id uuid)
returns boolean language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare a public.message_template_approvals%rowtype;
 q public.message_template_review_requests_v6%rowtype;
 v public.message_template_versions%rowtype;
 t public.message_templates%rowtype;
 e public.approval_decision_events_v6%rowtype;
begin
 select * into a from public.message_template_approvals where id=p_approval_id;
 if a.id is null or a.status<>'approved' or a.approved_request_id is null then return false; end if;
 select * into q from public.message_template_review_requests_v6
  where canonical_request_id=a.approved_request_id and template_version_id=a.template_version_id
   and client_id=a.client_id;
 select * into v from public.message_template_versions where id=a.template_version_id;
 select * into t from public.message_templates where id=v.template_id;
 select * into e from public.approval_decision_events_v6 where request_id=a.approved_request_id
  order by event_order desc limit 1;
 if q.id is null or v.id is null or t.id is null or e.id is null
  or a.client_id<>t.client_id or v.client_id<>t.client_id
  or a.channel_key<>t.channel_key or a.purpose<>t.purpose
  or a.consent_basis<>q.consent_basis or t.archived_at is not null
  or a.approved_content_hash is distinct from q.source_hash
  or e.decision<>'approved' or e.actor_aal<>'aal2'
  or e.artifact_hash is distinct from q.source_hash
  or not exists(select 1 from public.approval_inbox_v6 i
   where i.id=a.approved_request_id and i.status='approved'
    and i.source_state='source_decided' and i.preview_blocker is null)
  then return false; end if;
 return true;
end $$;
revoke all on function public.message_template_approval_current_v6(uuid) from public,anon,authenticated,service_role;
grant execute on function public.message_template_approval_current_v6(uuid) to authenticated,service_role;

create function public.guard_outbound_exact_message_v6()
returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
declare l public.client_leads%rowtype;
 v public.message_template_versions%rowtype;
 t public.message_templates%rowtype;
 a public.message_template_approvals%rowtype;
begin
 if tg_op='UPDATE' then
  if (new.client_id,new.lead_id,new.template_version_id,new.approval_id,new.channel_key,
    new.campaign_id,new.address,new.rendered_subject,new.rendered_body,
    new.consent_given_at,new.consent_wording,new.idempotency_key) is distinct from
   (old.client_id,old.lead_id,old.template_version_id,old.approval_id,old.channel_key,
    old.campaign_id,old.address,old.rendered_subject,old.rendered_body,
    old.consent_given_at,old.consent_wording,old.idempotency_key) then
   raise exception 'A queued message is immutable; create a new exact version.' using errcode='42501';
  end if;
  return new;
 end if;
 select * into l from public.client_leads where id=new.lead_id;
 select * into v from public.message_template_versions where id=new.template_version_id;
 select * into t from public.message_templates where id=v.template_id;
 select * into a from public.message_template_approvals where id=new.approval_id;
 if l.id is null or v.id is null or t.id is null or a.id is null or l.is_probe
  or new.client_id<>l.client_id or new.client_id<>v.client_id or new.client_id<>t.client_id
  or new.client_id<>a.client_id or new.template_version_id<>a.template_version_id
  or new.channel_key<>t.channel_key or new.channel_key<>a.channel_key
  or new.rendered_subject is distinct from v.subject
  or new.rendered_body is distinct from public.render_message_v6(v.body,l)
  or new.consent_given_at is distinct from l.consent_given_at
  or new.consent_wording is distinct from l.consent_wording
  or not public.message_template_approval_current_v6(a.id)
  then raise exception 'The queued message does not match its exact approved version and lead.' using errcode='42501';
 end if;
 return new;
end $$;
create trigger outbound_exact_message_guard_v6
 before insert or update on public.outbound_messages for each row
 execute function public.guard_outbound_exact_message_v6();
revoke all on function public.guard_outbound_exact_message_v6() from public,anon,authenticated,service_role;

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
  v_campaign_id uuid;
begin
  select * into l from public.client_leads where id = p_lead_id;
  if not found then raise exception 'No such lead.' using errcode = 'P0001'; end if;
  if not coalesce(public.may_manage_client_leads(l.client_id), false) then
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
  v_campaign_id := coalesce(t.campaign_id, l.source_client_campaign_id);
  if v_campaign_id is not null and not exists (
    select 1 from public.client_campaigns c
     where c.id = v_campaign_id and c.client_id = l.client_id) then
    raise exception 'That campaign belongs to a different client.' using errcode = 'P0001';
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
  if not public.message_template_approval_current_v6(a.id) then
    raise exception 'The exact Inbox decision for this message is no longer current.' using errcode='42501';
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
    v_campaign_id,
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
      and public.message_template_approval_current_v6(a.id)
      and ch.supported
      and exists (select 1 from public.client_leads l where l.id=m.lead_id
        and l.client_id=m.client_id and not l.is_probe
        and (m.channel_key in ('instagram_dm','messenger')
          or (l.consent_given_at is not null and m.consent_given_at is not null
           and l.consent_given_at=m.consent_given_at
           and l.consent_wording is not distinct from m.consent_wording
           and btrim(coalesce(l.consent_wording,''))<>'')))
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
-- The provider-facing worker must recheck after claim and immediately before POST.
create function public.outbound_message_send_ready_v6(p_message_id uuid)
returns boolean language plpgsql volatile security definer set search_path=pg_catalog,public as $$
declare m public.outbound_messages%rowtype;
 l public.client_leads%rowtype;
 v public.message_template_versions%rowtype;
 t public.message_templates%rowtype;
 a public.message_template_approvals%rowtype;
 s public.client_engine_settings%rowtype;
begin
 if auth.role()<>'service_role' then raise exception 'Only the courier may preflight a send.' using errcode='42501'; end if;
 select * into m from public.outbound_messages where id=p_message_id for update;
 select * into l from public.client_leads where id=m.lead_id;
 select * into v from public.message_template_versions where id=m.template_version_id;
 select * into t from public.message_templates where id=v.template_id;
 select * into a from public.message_template_approvals where id=m.approval_id;
 select * into s from public.client_engine_settings where client_id=m.client_id;
 if m.id is null or l.id is null or v.id is null or t.id is null or a.id is null
  or m.status<>'sending' or m.lease_until is null or m.lease_until<=now() or m.attempts>5
  or m.client_id<>l.client_id or m.client_id<>v.client_id or m.client_id<>t.client_id
  or m.client_id<>a.client_id or m.template_version_id<>a.template_version_id
  or m.channel_key<>t.channel_key or l.is_probe or not coalesce(s.outbound_messaging_enabled,false)
  or not public.message_template_approval_current_v6(m.approval_id)
  or not exists(select 1 from public.message_channels ch
   where ch.channel_key=m.channel_key and ch.supported)
  or exists(select 1 from public.lead_suppressions sup
   where sup.client_id=m.client_id and sup.dedupe_key=l.dedupe_key)
  then return false; end if;
 if m.channel_key in ('instagram_dm','messenger') then
  return exists(select 1 from public.dm_messages d
   join public.dm_conversations c on c.id=d.conversation_id
   join public.dm_identities i on i.id=c.identity_id
   where d.outbound_message_id=m.id and c.lead_id=l.id and c.client_id=m.client_id
    and c.window_expires_at>now() and i.external_user_id=m.address
    and i.platform=case m.channel_key when 'instagram_dm' then 'instagram' else 'facebook' end);
 end if;
 if l.consent_given_at is null or m.consent_given_at is null
  or l.consent_given_at<>m.consent_given_at
  or l.consent_wording is distinct from m.consent_wording
  or btrim(coalesce(l.consent_wording,''))='' then return false; end if;
 return case m.channel_key when 'email' then btrim(coalesce(l.email,''))=m.address
  when 'sms' then btrim(coalesce(l.phone,''))=m.address
  when 'whatsapp' then btrim(coalesce(l.phone,''))=m.address
  else false end;
end $$;
revoke all on function public.outbound_message_send_ready_v6(uuid) from public,anon,authenticated,service_role;
grant execute on function public.outbound_message_send_ready_v6(uuid) to service_role;
select public.lock_down_definer_functions();
commit;

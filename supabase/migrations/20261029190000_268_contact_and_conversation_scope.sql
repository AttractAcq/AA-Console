-- B005: a creative job/client assignment is not permission to read a lead's
-- contact, consent, appointment, send, or conversation history. Keep existing
-- admin, same-client user and service routes, and admit only an explicitly
-- entitled sales employee once migration 267's Inbox gate is actually live.

create or replace function public.can_read_client_sales_data(target uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  -- Reuse the lead permission contract. Its direct EXECUTE remains closed to
  -- authenticated users; this wrapper is limited to row-policy use.
  select public.may_manage_client_leads(target);
$$;
revoke execute on function public.can_read_client_sales_data(uuid)
  from public, anon;
grant execute on function public.can_read_client_sales_data(uuid)
  to authenticated, service_role;

drop policy if exists lead_submissions_read on public.lead_submissions;
create policy lead_submissions_read on public.lead_submissions
  for select to authenticated
  using (public.can_read_client_sales_data(client_id));

drop policy if exists lead_magnet_deliveries_read on public.lead_magnet_deliveries;
create policy lead_magnet_deliveries_read on public.lead_magnet_deliveries
  for select to authenticated
  using (public.can_read_client_sales_data(client_id));

drop policy if exists lead_sequence_enrollments_read on public.lead_sequence_enrollments;
create policy lead_sequence_enrollments_read on public.lead_sequence_enrollments
  for select to authenticated
  using (public.can_read_client_sales_data(client_id));

-- Run attribution includes lead IDs, evidence and labels. workflow_runs has
-- its own creative-assignment RLS, so a sales-only seat cannot use an invoker
-- subquery to resolve run_id -> client_id. Resolve only that scope inside a
-- definer helper; do not grant the seat workflow_runs SELECT.
create or replace function public.can_read_workflow_lead_attribution(p_run_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.workflow_runs r
     where r.id = p_run_id
       and public.can_read_client_sales_data(r.client_id));
$$;
revoke execute on function public.can_read_workflow_lead_attribution(uuid)
  from public, anon;
grant execute on function public.can_read_workflow_lead_attribution(uuid)
  to authenticated, service_role;

drop policy if exists workflow_lead_attribution_read on public.workflow_lead_attribution;
create policy workflow_lead_attribution_read on public.workflow_lead_attribution
  for select to authenticated
  using (public.can_read_workflow_lead_attribution(run_id));

drop policy if exists lead_suppressions_read on public.lead_suppressions;
create policy lead_suppressions_read on public.lead_suppressions
  for select to authenticated
  using (public.can_read_client_sales_data(client_id));

drop policy if exists outbound_messages_read on public.outbound_messages;
create policy outbound_messages_read on public.outbound_messages
  for select to authenticated
  using (public.can_read_client_sales_data(client_id));

drop policy if exists client_appointments_read on public.client_appointments;
create policy client_appointments_read on public.client_appointments
  for select to authenticated
  using (public.can_read_client_sales_data(client_id));

drop policy if exists dm_identities_read on public.dm_identities;
create policy dm_identities_read on public.dm_identities
  for select to authenticated
  using (public.can_read_client_sales_data(client_id));

drop policy if exists dm_conversations_read on public.dm_conversations;
create policy dm_conversations_read on public.dm_conversations
  for select to authenticated
  using (public.can_read_client_sales_data(client_id));

drop policy if exists dm_messages_read on public.dm_messages;
create policy dm_messages_read on public.dm_messages
  for select to authenticated
  using (public.can_read_client_sales_data(client_id));

-- The original sales-agent transcript policy was client-only. Preserve it;
-- add a second read path for a live explicit sales employee without exposing
-- the agent's configuration or its deployment controls.
create policy sac_sales_read on public.sales_agent_conversations
  for select to authenticated
  using (public.has_client_sales_entitlement(client_id));
grant select on public.sales_agent_conversations to authenticated;

-- Security-definer RPCs below bypass table RLS. Reassert the same client/sales
-- scope before returning a conversation or queueing a person-specific send.
create or replace function public.dm_reply_refusal_v6(p_conversation_id uuid)
returns text language plpgsql stable security definer
set search_path = pg_catalog, public as $fn$
declare c public.dm_conversations%rowtype;
begin
  select * into c from public.dm_conversations where id = p_conversation_id;
  if not found or not coalesce(public.may_manage_client_leads(c.client_id), false) then
    return 'That conversation does not exist.';
  end if;
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

create or replace function public.close_dm_conversation_v6(
  p_conversation_id uuid, p_reason text)
returns public.dm_conversations language plpgsql security definer
set search_path = pg_catalog, public as $fn$
declare c public.dm_conversations%rowtype;
begin
  select * into c from public.dm_conversations where id = p_conversation_id for update;
  if not found then raise exception 'No such conversation.' using errcode = 'P0001'; end if;
  if not coalesce(public.may_manage_client_leads(c.client_id), false) then
    raise exception 'Not permitted for this client.' using errcode = 'P0001';
  end if;
  if nullif(btrim(coalesce(p_reason, '')), '') is null then
    raise exception 'Say why it was closed.' using errcode = 'P0001';
  end if;
  update public.dm_conversations
     set status = 'closed', closed_reason = btrim(p_reason), unread_inbound = 0
   where id = p_conversation_id returning * into c;
  return c;
end $fn$;

create or replace function public.merge_dm_lead_v6(
  p_conversation_id uuid, p_lead_id uuid)
returns public.dm_conversations language plpgsql security definer
set search_path = pg_catalog, public as $fn$
declare
  c public.dm_conversations%rowtype;
  l public.client_leads%rowtype;
  v_old uuid;
begin
  select * into c from public.dm_conversations where id = p_conversation_id for update;
  if not found then raise exception 'No such conversation.' using errcode = 'P0001'; end if;
  if not coalesce(public.may_manage_client_leads(c.client_id), false) then
    raise exception 'Not permitted for this client.' using errcode = 'P0001';
  end if;
  select * into l from public.client_leads where id = p_lead_id;
  if not found then raise exception 'No such lead.' using errcode = 'P0001'; end if;
  if l.client_id <> c.client_id then
    raise exception 'That lead belongs to a different client.' using errcode = 'P0001';
  end if;
  if l.is_probe then
    raise exception 'That is a probe lead.' using errcode = 'P0001';
  end if;

  v_old := c.lead_id;
  update public.dm_conversations set lead_id = p_lead_id where id = p_conversation_id
    returning * into c;
  update public.dm_identities set lead_id = p_lead_id where id = c.identity_id;

  -- The lead the thread invented is archived rather than deleted: its events
  -- are the history of this conversation and deleting them would lose it.
  if v_old is not null and v_old <> p_lead_id then
    insert into public.lead_events (lead_id, client_id, kind, detail)
    values (p_lead_id, c.client_id, 'note',
            'A ' || c.platform || ' conversation was merged into this lead from ' || v_old::text || '.');
  end if;
  return c;
end $fn$;

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

-- Existing authenticated EXECUTE grants remain after CREATE OR REPLACE.
-- Allow trusted service callers to close/merge alongside admin/client/sales.
grant execute on function public.close_dm_conversation_v6(uuid, text),
  public.merge_dm_lead_v6(uuid, uuid) to service_role;

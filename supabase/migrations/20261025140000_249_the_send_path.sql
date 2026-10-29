-- G02, the send path: the functions migration 248's tables are for.
--
-- Split from 248 the way 160 and 161 were split -- the tables are the
-- contract and these are the rules, and the rules are where the arguing is.
--
-- THE ORDER OF THE CHECKS IS THE DESIGN
--
-- Queueing refuses in this order, and the order is deliberate: each refusal
-- is phrased for whoever can fix it, and the earlier ones are the ones a
-- person can act on.
--
--   1. the channel has a transport at all
--   2. a standing approval exists for this version on this channel
--   3. consent is recorded on the lead
--   4. the lead is not suppressed
--   5. the client's daily cap is not spent
--   6. every placeholder in the body resolves
--
-- Suppression could be first and is not, because "there is no SMS provider"
-- is more useful to hear than "that person unsubscribed" when the real
-- problem is that nothing could have been sent anyway. But suppression is
-- the only one with no override anywhere in the system.
--
-- WHY RENDERING REFUSES
--
-- A message that goes out saying "Hi {{first_name}}," is worse than one that
-- never goes out. So the body is rendered at queue time, from the lead row,
-- and an unresolved placeholder is a refusal naming the placeholder rather
-- than a send with a hole in it.

-- ---------------------------------------------------------------------------
-- Authoring
-- ---------------------------------------------------------------------------

create or replace function public.create_message_template_v6(
  p_client_id uuid, p_name text, p_purpose text, p_channel_key text,
  p_campaign_id uuid default null)
returns public.message_templates language plpgsql security definer
set search_path = pg_catalog, public as $$
declare v public.message_templates%rowtype;
begin
  if coalesce(auth.role(), '') <> 'service_role'
     and not (coalesce(public.is_admin(), false)
              or coalesce(public.can_access_client(p_client_id), false)) then
    raise exception 'Not permitted for this client.' using errcode = 'P0001';
  end if;
  insert into public.message_templates (
    client_id, name, purpose, channel_key, campaign_id, created_by)
  values (p_client_id, btrim(p_name), p_purpose, p_channel_key, p_campaign_id, auth.uid())
  returning * into v;
  return v;
end $$;

revoke all on function public.create_message_template_v6(uuid, text, text, text, uuid)
  from public, anon;
grant execute on function public.create_message_template_v6(uuid, text, text, text, uuid)
  to authenticated, service_role;

create or replace function public.add_message_template_version_v6(
  p_template_id uuid, p_subject text, p_body text, p_placeholders text[] default '{}')
returns public.message_template_versions language plpgsql security definer
set search_path = pg_catalog, public as $$
declare
  t public.message_templates%rowtype;
  v public.message_template_versions%rowtype;
  v_next integer;
begin
  select * into t from public.message_templates where id = p_template_id;
  if not found then raise exception 'No such template.' using errcode = 'P0001'; end if;
  if coalesce(auth.role(), '') <> 'service_role'
     and not (coalesce(public.is_admin(), false)
              or coalesce(public.can_access_client(t.client_id), false)) then
    raise exception 'Not permitted for this client.' using errcode = 'P0001';
  end if;

  -- An email with no subject is a message a provider will mangle or drop.
  if t.channel_key = 'email'
     and nullif(btrim(coalesce(p_subject, '')), '') is null then
    raise exception 'An email version needs a subject.' using errcode = 'P0001';
  end if;

  select coalesce(max(version), 0) + 1 into v_next
    from public.message_template_versions where template_id = p_template_id;

  insert into public.message_template_versions (
    template_id, client_id, version, subject, body, placeholders, payload_hash, created_by)
  values (
    p_template_id, t.client_id, v_next, nullif(btrim(coalesce(p_subject, '')), ''),
    p_body, coalesce(p_placeholders, '{}'),
    public.message_payload_hash_v6(p_subject, p_body, t.channel_key), auth.uid())
  returning * into v;
  return v;
end $$;

revoke all on function public.add_message_template_version_v6(uuid, text, text, text[])
  from public, anon;
grant execute on function public.add_message_template_version_v6(uuid, text, text, text[])
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Approving a version for a channel and a purpose
-- ---------------------------------------------------------------------------

create or replace function public.approve_message_template_v6(
  p_template_version_id uuid, p_consent_basis text)
returns public.message_template_approvals language plpgsql security definer
set search_path = pg_catalog, public as $$
declare
  v public.message_template_versions%rowtype;
  t public.message_templates%rowtype;
  a public.message_template_approvals%rowtype;
  v_supported boolean;
begin
  select * into v from public.message_template_versions where id = p_template_version_id;
  if not found then raise exception 'No such message version.' using errcode = 'P0001'; end if;
  select * into t from public.message_templates where id = v.template_id;

  if auth.role() is distinct from 'authenticated'
     or not (coalesce(public.is_admin(), false)
             or coalesce(auth.uid() = public.active_video_approval_manager(t.client_id), false)) then
    raise exception 'A signed-in admin or the assigned client manager must approve a message.'
      using errcode = 'P0001';
  end if;

  -- Stated, not inferred. Nothing reads consent_wording, so this sentence is
  -- the record of the judgement that the consent covers a message like this.
  if nullif(btrim(coalesce(p_consent_basis, '')), '') is null then
    raise exception 'Say why the consent these leads gave covers a message of this purpose.'
      using errcode = 'P0001';
  end if;

  select supported into v_supported from public.message_channels
   where channel_key = t.channel_key;
  if not coalesce(v_supported, false) then
    raise exception 'There is no transport for %. Approving it would authorise something that cannot happen.',
      t.channel_key using errcode = 'P0001';
  end if;

  insert into public.message_template_approvals (
    template_version_id, client_id, channel_key, purpose, consent_basis, approved_by)
  values (p_template_version_id, t.client_id, t.channel_key, t.purpose,
          btrim(p_consent_basis), auth.uid())
  on conflict (template_version_id, channel_key) do update
    set status = 'approved', consent_basis = excluded.consent_basis,
        approved_by = excluded.approved_by, approved_at = now(),
        revoked_by = null, revoked_at = null, revoked_reason = null
  returning * into a;
  return a;
end $$;

revoke all on function public.approve_message_template_v6(uuid, text) from public, anon;
grant execute on function public.approve_message_template_v6(uuid, text) to authenticated;

create or replace function public.revoke_message_template_approval_v6(
  p_approval_id uuid, p_reason text)
returns void language plpgsql security definer
set search_path = pg_catalog, public as $$
declare a public.message_template_approvals%rowtype;
begin
  select * into a from public.message_template_approvals where id = p_approval_id for update;
  if not found then raise exception 'No such approval.' using errcode = 'P0001'; end if;
  if not (coalesce(public.is_admin(), false)
          or coalesce(auth.uid() = public.active_video_approval_manager(a.client_id), false)) then
    raise exception 'Only an admin or the assigned client manager can revoke an approval.'
      using errcode = 'P0001';
  end if;
  if nullif(btrim(coalesce(p_reason, '')), '') is null then
    raise exception 'Say why it was revoked.' using errcode = 'P0001';
  end if;

  update public.message_template_approvals
     set status = 'revoked', revoked_by = auth.uid(), revoked_at = now(),
         revoked_reason = btrim(p_reason)
   where id = p_approval_id;

  -- Anything not yet gone is cancelled. A revocation that left a queue
  -- draining would be a revocation in name only.
  update public.outbound_messages
     set status = 'cancelled',
         last_error = 'The approval was revoked before this was sent: ' || btrim(p_reason)
   where approval_id = p_approval_id and status in ('queued', 'sending');
end $$;

revoke all on function public.revoke_message_template_approval_v6(uuid, text) from public, anon;
grant execute on function public.revoke_message_template_approval_v6(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Rendering, which refuses rather than sending a hole
-- ---------------------------------------------------------------------------

create or replace function public.render_message_v6(p_body text, p_lead public.client_leads)
returns text language plpgsql immutable
set search_path = pg_catalog, public as $$
declare
  v_out text := p_body;
  v_first text;
  v_left text;
begin
  v_first := nullif(btrim(split_part(coalesce(p_lead.name, ''), ' ', 1)), '');
  v_out := replace(v_out, '{{first_name}}', coalesce(v_first, ''));
  v_out := replace(v_out, '{{name}}', coalesce(nullif(btrim(p_lead.name), ''), ''));
  v_out := replace(v_out, '{{email}}', coalesce(p_lead.email, ''));
  v_out := replace(v_out, '{{phone}}', coalesce(p_lead.phone, ''));

  -- Anything still in moustaches never resolved. Named, so the person
  -- fixing the template knows which one.
  v_left := substring(v_out from '\{\{[a-zA-Z0-9_]+\}\}');
  if v_left is not null then
    raise exception 'This message still contains % after rendering. Remove it or fill it from the lead.',
      v_left using errcode = 'P0001';
  end if;
  -- A placeholder that resolved to nothing leaves "Hi ," which reads worse
  -- than no name at all.
  if v_out ~ '(^|\s)(Hi|Hello|Dear)\s*[,.]' then
    raise exception 'This message greets nobody: the name placeholder resolved to an empty string for this lead.'
      using errcode = 'P0001';
  end if;
  return v_out;
end $$;

revoke all on function public.render_message_v6(text, public.client_leads) from public, anon;
grant execute on function public.render_message_v6(text, public.client_leads)
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Queueing one message to one person
-- ---------------------------------------------------------------------------

create or replace function public.queue_lead_message_v6(
  p_lead_id uuid, p_template_version_id uuid)
returns public.outbound_messages language plpgsql security definer
set search_path = pg_catalog, public as $$
declare
  l public.client_leads%rowtype;
  v public.message_template_versions%rowtype;
  t public.message_templates%rowtype;
  a public.message_template_approvals%rowtype;
  ch public.message_channels%rowtype;
  m public.outbound_messages%rowtype;
  v_address text;
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

  -- 1. A channel with no transport.
  select * into ch from public.message_channels where channel_key = t.channel_key;
  if not coalesce(ch.supported, false) then
    raise exception 'There is no transport for %: %', t.channel_key, ch.note
      using errcode = 'P0001';
  end if;

  -- 2. A standing approval for this exact version on this channel.
  select * into a from public.message_template_approvals
   where template_version_id = p_template_version_id
     and channel_key = t.channel_key and status = 'approved';
  if not found then
    raise exception 'No standing approval for this version on %. A changed word is a new version and needs its own.',
      t.channel_key using errcode = 'P0001';
  end if;

  -- 3. Consent.
  if l.consent_given_at is null then
    raise exception 'This lead has no recorded consent, so nothing may be sent to them.'
      using errcode = 'P0001';
  end if;

  -- 4. Suppression. The one check with no override anywhere.
  if exists (select 1 from public.lead_suppressions s
              where s.client_id = l.client_id and s.dedupe_key = l.dedupe_key) then
    raise exception 'This person is suppressed for this client. Nothing may be sent to them.'
      using errcode = 'P0001';
  end if;

  -- 5. The daily cap.
  select coalesce(outbound_daily_cap, 200) into v_cap
    from public.client_engine_settings where client_id = l.client_id;
  v_cap := coalesce(v_cap, 200);
  select count(*)::int into v_sent_today from public.outbound_messages
   where client_id = l.client_id and created_at >= date_trunc('day', now());
  if v_sent_today >= v_cap then
    raise exception 'This client''s daily message cap of % is spent. Nothing further is queued today.',
      v_cap using errcode = 'P0001';
  end if;

  v_address := case t.channel_key
    when 'email' then l.email
    when 'sms' then l.phone
    when 'whatsapp' then l.phone
    else null end;
  if nullif(btrim(coalesce(v_address, '')), '') is null then
    raise exception 'This lead has no % address.', t.channel_key using errcode = 'P0001';
  end if;

  -- One per lead per version, which is what stops a re-fired sequence or a
  -- retry sending the same words twice.
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
  return m;
end $$;

comment on function public.queue_lead_message_v6(uuid, uuid) is
  'Queues one approved message to one consenting, unsuppressed person, rendering it from the lead and refusing rather than sending a hole. Idempotent per lead and version.';

revoke all on function public.queue_lead_message_v6(uuid, uuid) from public, anon;
grant execute on function public.queue_lead_message_v6(uuid, uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- The sweep
-- ---------------------------------------------------------------------------

create or replace function public.claim_outbound_messages(p_limit integer default 10)
returns table (
  message_id uuid, client_id uuid, lead_id uuid, channel_key text,
  address text, rendered_subject text, rendered_body text, attempts integer)
language plpgsql security definer
set search_path = pg_catalog, public as $$
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
      -- Re-checked at the claim, not trusted from the queue: somebody may
      -- have unsubscribed between queueing and sending, and that is exactly
      -- the window that matters.
      and not exists (
        select 1 from public.lead_suppressions sup
         join public.client_leads l on l.id = m.lead_id
         where sup.client_id = m.client_id and sup.dedupe_key = l.dedupe_key)
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
end $$;

revoke all on function public.claim_outbound_messages(integer) from public, anon, authenticated;
grant execute on function public.claim_outbound_messages(integer) to service_role;

create or replace function public.record_outbound_message_sent(
  p_message_id uuid, p_external_id text)
returns void language plpgsql security definer
set search_path = pg_catalog, public as $$
begin
  if auth.role() <> 'service_role' then
    raise exception 'Only the internal service may record a send.';
  end if;
  update public.outbound_messages
     set status = 'sent', sent_at = now(), external_id = p_external_id,
         lease_until = null, last_error = null
   where id = p_message_id;
  if not found then raise exception 'No such message.'; end if;
end $$;

revoke all on function public.record_outbound_message_sent(uuid, text)
  from public, anon, authenticated;
grant execute on function public.record_outbound_message_sent(uuid, text) to service_role;

create or replace function public.record_outbound_message_failure(
  p_message_id uuid, p_reason text, p_retryable boolean default true)
returns void language plpgsql security definer
set search_path = pg_catalog, public as $$
declare v public.outbound_messages%rowtype;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Only the internal service may record a failure.';
  end if;
  select * into v from public.outbound_messages where id = p_message_id for update;
  if not found then raise exception 'No such message.'; end if;

  update public.outbound_messages
     set status = case
           when not coalesce(p_retryable, true) then 'failed'
           when v.attempts >= 5 then 'failed'
           else 'queued' end,
         lease_until = null,
         last_error = p_reason
   where id = p_message_id;
end $$;

revoke all on function public.record_outbound_message_failure(uuid, text, boolean)
  from public, anon, authenticated;
grant execute on function public.record_outbound_message_failure(uuid, text, boolean)
  to service_role;

create or replace function public.reap_stale_outbound_claims()
returns integer language plpgsql security definer
set search_path = pg_catalog, public as $$
declare v_count integer;
begin
  with released as (
    update public.outbound_messages
       set status = case when attempts >= 5 then 'failed' else 'queued' end,
           lease_until = null,
           last_error = coalesce(last_error, 'The worker holding this stopped before it finished.')
     where status = 'sending' and lease_until < now() - interval '10 minutes'
     returning 1)
  select count(*)::int into v_count from released;
  return v_count;
end $$;

revoke all on function public.reap_stale_outbound_claims() from public, anon, authenticated;
grant execute on function public.reap_stale_outbound_claims() to service_role;

-- ---------------------------------------------------------------------------
-- What is stopping a message
-- ---------------------------------------------------------------------------

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
  'Every governed message and what stops it. A null blocker on an unsent message means it goes on the next sweep.';

grant select on outbound_message_due to authenticated;

-- ---------------------------------------------------------------------------
-- email_sms_nurture can now carry proof
-- ---------------------------------------------------------------------------

update public.proof_destinations set supported = true, note =
  'A proof-carrying nurture template. The placement is the approved template version that cites the proof, not each send -- so retracting it stops every future send of that version rather than chasing messages already delivered.'
 where destination_key = 'email_sms_nurture';

select lock_down_definer_functions();

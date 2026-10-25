-- G04, the booking: computing free slots and taking one.
--
-- Availability is computed rather than materialised. A table of slots would
-- need generating forward forever, pruning behind, and regenerating whenever
-- a client changed their hours — and every one of those is a job that can
-- fail quietly and leave a prospect looking at times nobody will honour.
-- Computing from the rules means the answer is always current by
-- construction.
--
-- THE TIMEZONE IS THE SUBTLE PART
--
-- Windows are minutes from midnight in the client's own zone, and slots are
-- built by adding those minutes to local midnight and converting out. Doing
-- it the other way — working in UTC and adding an offset — gives a nine
-- o'clock appointment that becomes ten o'clock when the clocks change.

-- ---------------------------------------------------------------------------
-- What is free
-- ---------------------------------------------------------------------------

create or replace function public.available_slots_v6(
  p_client_id uuid, p_days integer default 14)
returns table (starts_at timestamptz, ends_at timestamptz)
language plpgsql stable security definer
set search_path = pg_catalog, public as $$
declare s public.client_booking_settings%rowtype;
begin
  select * into s from public.client_booking_settings where client_id = p_client_id;
  if not found or not s.enabled then return; end if;

  return query
  with bounds as (
    select
      -- Nothing sooner than the notice period, nothing beyond the horizon.
      (now() + make_interval(hours => s.min_notice_hours)) as earliest,
      (now() + make_interval(
         days => least(coalesce(p_days, 14), s.max_days_ahead))) as latest
  ), days as (
    select generate_series(
      (now() at time zone s.timezone)::date,
      ((select latest from bounds) at time zone s.timezone)::date,
      interval '1 day')::date as day
  ), candidate as (
    select
      -- Local midnight in the client's zone, plus the window offset, back to
      -- an absolute instant. This is the part that survives a clock change.
      ((d.day::text || ' 00:00')::timestamp
        + make_interval(mins => w.starts_at_minute + (n * s.slot_minutes)))
        at time zone s.timezone as starts_at,
      ((d.day::text || ' 00:00')::timestamp
        + make_interval(mins => w.starts_at_minute + ((n + 1) * s.slot_minutes)))
        at time zone s.timezone as ends_at,
      d.day
    from days d
    join public.client_booking_windows w
      on w.client_id = p_client_id and w.day_of_week = extract(dow from d.day)::int
    cross join generate_series(
      0, greatest(((w.ends_at_minute - w.starts_at_minute) / s.slot_minutes) - 1, 0)) as n
  ), in_range as (
    select c.* from candidate c, bounds b
     where c.starts_at >= b.earliest and c.starts_at < b.latest
  ), per_day as (
    select r.*, (
      select count(*) from public.client_appointments a
       where a.client_id = p_client_id
         and a.status in ('booked', 'attended')
         and (a.starts_at at time zone s.timezone)::date = r.day) as booked_that_day
    from in_range r
  )
  select p.starts_at, p.ends_at
    from per_day p
   where p.booked_that_day < s.max_per_day
     -- The buffer applies on both sides of an existing appointment, so a
     -- fifteen-minute gap is a gap however the two are ordered.
     and not exists (
       select 1 from public.client_appointments a
        where a.client_id = p_client_id
          and a.status in ('booked', 'attended')
          and tstzrange(
                a.starts_at - make_interval(mins => s.buffer_minutes),
                a.ends_at + make_interval(mins => s.buffer_minutes))
              && tstzrange(p.starts_at, p.ends_at))
   order by p.starts_at;
end $$;

comment on function public.available_slots_v6(uuid, integer) is
  'The slots a client would actually honour: inside their stated windows, past the notice period, within the horizon, under the daily maximum, and not inside the buffer around something already booked.';

revoke all on function public.available_slots_v6(uuid, integer) from public, anon;
grant execute on function public.available_slots_v6(uuid, integer) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Taking one
-- ---------------------------------------------------------------------------

create or replace function public.book_appointment_v6(
  p_lead_id uuid, p_starts_at timestamptz, p_booked_via text,
  p_campaign_id uuid default null)
returns public.client_appointments
language plpgsql security definer
set search_path = pg_catalog, public as $$
declare
  l public.client_leads%rowtype;
  s public.client_booking_settings%rowtype;
  a public.client_appointments%rowtype;
  v_ends timestamptz;
begin
  select * into l from public.client_leads where id = p_lead_id;
  if not found then raise exception 'No such lead.' using errcode = 'P0001'; end if;

  if p_booked_via not in ('public_link', 'sales_agent', 'person') then
    raise exception 'Unknown booking route.' using errcode = 'P0001';
  end if;
  -- A person or an agent books on the client's behalf; the public link books
  -- as the prospect. Only the first needs a signed-in caller.
  if p_booked_via = 'person'
     and not (coalesce(public.is_admin(), false)
              or coalesce(public.can_access_client(l.client_id), false)) then
    raise exception 'Not permitted for this client.' using errcode = 'P0001';
  end if;
  if p_booked_via <> 'person' and coalesce(auth.role(), '') <> 'service_role'
     and not (coalesce(public.is_admin(), false)
              or coalesce(public.can_access_client(l.client_id), false)) then
    raise exception 'Only the internal service books on a prospect''s behalf.'
      using errcode = 'P0001';
  end if;

  if l.is_probe then
    raise exception 'That is a probe lead. Booking it would put a fake call in the diary.'
      using errcode = 'P0001';
  end if;

  select * into s from public.client_booking_settings where client_id = l.client_id;
  if not found or not s.enabled then
    raise exception 'This client is not taking bookings.' using errcode = 'P0001';
  end if;

  -- One lock per client for the whole check-and-insert. Two requests in the
  -- same millisecond cannot both find the slot free.
  perform pg_advisory_xact_lock(hashtextextended(l.client_id::text, 0));

  v_ends := p_starts_at + make_interval(mins => s.slot_minutes);

  -- The slot has to be one the computation would actually offer. Checked
  -- here rather than trusted from whatever the caller was shown, because
  -- what they were shown may be minutes old.
  if not exists (
    select 1 from public.available_slots_v6(l.client_id, s.max_days_ahead) av
     where av.starts_at = p_starts_at) then
    raise exception 'That slot is not available. Read the free slots again and choose another.'
      using errcode = 'P0001';
  end if;

  insert into public.client_appointments (
    client_id, lead_id, campaign_id, starts_at, ends_at, booked_via, booked_by)
  values (
    l.client_id, p_lead_id, coalesce(p_campaign_id, l.source_client_campaign_id),
    p_starts_at, v_ends, p_booked_via,
    case when p_booked_via = 'person' then auth.uid() else null end)
  returning * into a;

  -- The pipeline moves with it. An appointment that left the lead at `lead`
  -- is the state Sales OS could never tell apart from a booking that had not
  -- happened.
  update public.client_leads
     set stage = 'appointment', stage_at = now(), appointment_at = p_starts_at
   where id = p_lead_id
     and stage not in ('appointment', 'qualified_appointment', 'shown', 'sale', 'cash');

  insert into public.lead_events (lead_id, client_id, kind, detail)
  values (p_lead_id, l.client_id, 'appointment',
          'Booked for ' || to_char(p_starts_at at time zone s.timezone, 'FMDay DD FMMonth, HH24:MI')
          || ' (' || p_booked_via || ').');
  return a;
end $$;

comment on function public.book_appointment_v6(uuid, timestamptz, text, uuid) is
  'Takes one slot, under an advisory lock so two requests cannot take the same one, and moves the lead to appointment. Re-checks availability rather than trusting what the caller was shown.';

revoke all on function public.book_appointment_v6(uuid, timestamptz, text, uuid) from public, anon;
grant execute on function public.book_appointment_v6(uuid, timestamptz, text, uuid)
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- What became of it
-- ---------------------------------------------------------------------------

create or replace function public.record_appointment_outcome_v6(
  p_appointment_id uuid, p_status text, p_note text default null)
returns public.client_appointments
language plpgsql security definer
set search_path = pg_catalog, public as $$
declare a public.client_appointments%rowtype;
begin
  select * into a from public.client_appointments where id = p_appointment_id for update;
  if not found then raise exception 'No such appointment.' using errcode = 'P0001'; end if;
  if not (coalesce(public.is_admin(), false)
          or coalesce(public.can_access_client(a.client_id), false)) then
    raise exception 'Not permitted for this client.' using errcode = 'P0001';
  end if;
  if p_status not in ('attended', 'no_show', 'cancelled') then
    raise exception 'An outcome is attended, no_show or cancelled.' using errcode = 'P0001';
  end if;
  if p_status = 'cancelled' and nullif(btrim(coalesce(p_note, '')), '') is null then
    raise exception 'Say why it was cancelled.' using errcode = 'P0001';
  end if;

  update public.client_appointments
     set status = p_status,
         outcome_note = coalesce(nullif(btrim(coalesce(p_note, '')), ''), outcome_note),
         cancelled_reason = case when p_status = 'cancelled'
                                 then btrim(p_note) else cancelled_reason end
   where id = p_appointment_id returning * into a;

  -- Attending is its own stage, because the gap between booked and attended
  -- is the no-show rate and it is usually the cheapest thing to fix.
  if p_status = 'attended' then
    update public.client_leads set stage = 'shown', stage_at = now()
     where id = a.lead_id and stage in ('appointment', 'qualified_appointment');
  end if;

  insert into public.lead_events (lead_id, client_id, kind, detail)
  values (a.lead_id, a.client_id, 'outcome',
          'Appointment ' || p_status || coalesce(': ' || btrim(p_note), '') || '.');
  return a;
end $$;

revoke all on function public.record_appointment_outcome_v6(uuid, text, text) from public, anon;
grant execute on function public.record_appointment_outcome_v6(uuid, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- The public link
-- ---------------------------------------------------------------------------

-- Takes the hash, not the token. Migration 235 set this pattern for capture
-- endpoints and it is the right one twice over: the secret never exists in
-- the database at all, and the function does not depend on pgcrypto -- which
-- lives in the `extensions` schema and is therefore unreachable from a
-- function with a pinned `search_path` of pg_catalog, public. A caller that
-- generated the token here would compile fine and fail at runtime.
create or replace function public.create_booking_link_v6(
  p_client_id uuid, p_purpose text, p_token_hash text,
  p_campaign_id uuid default null, p_expires_at timestamptz default null)
returns public.booking_links
language plpgsql security definer
set search_path = pg_catalog, public as $$
declare v public.booking_links%rowtype;
begin
  if not (coalesce(public.is_admin(), false)
          or coalesce(public.can_access_client(p_client_id), false)) then
    raise exception 'Not permitted for this client.' using errcode = 'P0001';
  end if;
  if p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'A booking token hash is 64 hex characters.' using errcode = 'P0001';
  end if;
  insert into public.booking_links (
    client_id, campaign_id, purpose, token_hash, expires_at, created_by)
  values (
    p_client_id, p_campaign_id, btrim(p_purpose), p_token_hash, p_expires_at, auth.uid())
  returning * into v;
  return v;
end $$;

revoke all on function public.create_booking_link_v6(uuid, text, text, uuid, timestamptz)
  from public, anon;
grant execute on function public.create_booking_link_v6(uuid, text, text, uuid, timestamptz)
  to authenticated, service_role;

drop function if exists public.create_booking_link_v6(uuid, text, uuid, timestamptz);

create or replace function public.resolve_booking_link_v6(p_token text)
returns table (link_id uuid, client_id uuid, campaign_id uuid, purpose text)
language plpgsql security definer
set search_path = pg_catalog, public as $$
begin
  if auth.role() <> 'service_role' then
    raise exception 'Only the internal service may resolve a booking link.';
  end if;
  return query
  select b.id, b.client_id, b.campaign_id, b.purpose
    from public.booking_links b
   where b.token_hash = encode(sha256(convert_to(coalesce(p_token, ''), 'UTF8')), 'hex')
     and b.enabled and b.revoked_at is null
     and (b.expires_at is null or b.expires_at > now());
end $$;

revoke all on function public.resolve_booking_link_v6(text) from public, anon, authenticated;
grant execute on function public.resolve_booking_link_v6(text) to service_role;

-- ---------------------------------------------------------------------------
-- Why nobody can book
-- ---------------------------------------------------------------------------

drop view if exists booking_readiness;

create view booking_readiness with (security_invoker = true) as
select
  c.id as client_id,
  c.name,
  coalesce(s.enabled, false) as enabled,
  s.timezone,
  s.slot_minutes,
  s.min_notice_hours,
  s.max_per_day,
  (select count(*) from public.client_booking_windows w where w.client_id = c.id)::int as windows,
  (select count(*) from public.client_appointments a
    where a.client_id = c.id and a.status = 'booked' and a.starts_at > now())::int as upcoming,
  (select count(*) from public.booking_links b
    where b.client_id = c.id and b.enabled and b.revoked_at is null)::int as live_links,
  case
    when s.client_id is null then 'This client has no booking settings, so nothing can be booked.'
    when not s.enabled then 'Booking is switched off for this client.'
    when (select count(*) from public.client_booking_windows w where w.client_id = c.id) = 0
      then 'No hours are recorded, so every slot computation returns nothing.'
    when not exists (select 1 from public.available_slots_v6(c.id, s.max_days_ahead))
      then 'The hours are recorded but no slot is free inside the notice period and the horizon.'
    when (select count(*) from public.booking_links b
           where b.client_id = c.id and b.enabled and b.revoked_at is null) = 0
      then 'Slots are free and there is no live booking link, so only a person or the agent can book.'
    else null
  end as blocker
from public.clients c
left join public.client_booking_settings s on s.client_id = c.id;

comment on view booking_readiness is
  'Per client, whether a call could actually be booked right now, and if not which of the five reasons it is. "No hours recorded" and "no slot free" are different problems and are fixed in different places.';

grant select on booking_readiness to authenticated;

-- ---------------------------------------------------------------------------
-- Booking through the public link
-- ---------------------------------------------------------------------------

-- One function rather than a route that reads, decides and writes: finding
-- or creating the lead and taking the slot belong inside the same
-- transaction as the advisory lock. A route that created the lead, then
-- booked, could leave a lead behind whenever the slot went in between.
create or replace function public.book_from_public_link_v6(
  p_token text, p_name text, p_email text, p_phone text,
  p_starts_at timestamptz, p_consent_wording text)
returns table (appointment_id uuid, lead_id uuid, starts_at timestamptz)
language plpgsql security definer
set search_path = pg_catalog, public as $$
declare
  v_link record;
  v_key text;
  v_lead public.client_leads%rowtype;
  v_appointment public.client_appointments%rowtype;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Only the internal service may book through a public link.';
  end if;

  select * into v_link from public.resolve_booking_link_v6(p_token);
  if v_link.link_id is null then
    -- One sentence, whatever the reason. A link that explained whether it was
    -- revoked, disabled or expired would be a probing tool.
    raise exception 'This booking link is not accepting bookings.' using errcode = 'P0001';
  end if;

  if nullif(btrim(coalesce(p_email, '')), '') is null
     and nullif(btrim(coalesce(p_phone, '')), '') is null then
    raise exception 'An email address or a phone number is needed to hold the slot.'
      using errcode = 'P0001';
  end if;
  if nullif(btrim(coalesce(p_consent_wording, '')), '') is null then
    raise exception 'Record what they agreed to.' using errcode = 'P0001';
  end if;

  v_key := public.lead_dedupe_key(p_email, p_phone);

  -- The same person booking twice is one lead, so the second booking does
  -- not fork their history.
  select * into v_lead from public.client_leads
   where client_id = v_link.client_id and dedupe_key = v_key
   order by created_at limit 1;

  if v_lead.id is null then
    insert into public.client_leads (
      client_id, name, email, phone, stage, source, source_channel,
      source_client_campaign_id, consent_given_at, consent_wording)
    values (
      v_link.client_id, nullif(btrim(coalesce(p_name, '')), ''),
      nullif(btrim(coalesce(p_email, '')), ''), nullif(btrim(coalesce(p_phone, '')), ''),
      'lead', 'booking_link', 'booking_link', v_link.campaign_id,
      now(), btrim(p_consent_wording))
    returning * into v_lead;
  elsif v_lead.consent_given_at is null then
    -- They have consented now, by booking. Recorded rather than assumed.
    update public.client_leads
       set consent_given_at = now(), consent_wording = btrim(p_consent_wording)
     where id = v_lead.id returning * into v_lead;
  end if;

  select * into v_appointment from public.book_appointment_v6(
    v_lead.id, p_starts_at, 'public_link', v_link.campaign_id);

  return query select v_appointment.id, v_lead.id, v_appointment.starts_at;
end $$;

comment on function public.book_from_public_link_v6(text, text, text, text, timestamptz, text) is
  'Resolves a booking link, finds or creates the lead, and takes the slot in one transaction. A route that did these separately could leave a lead behind whenever the slot went in between.';

revoke all on function public.book_from_public_link_v6(text, text, text, text, timestamptz, text)
  from public, anon, authenticated;
grant execute on function public.book_from_public_link_v6(text, text, text, text, timestamptz, text)
  to service_role;

-- Slots for a link, so the public page does not need the client id.
create or replace function public.public_slots_for_link_v6(p_token text, p_days integer default 14)
returns table (starts_at timestamptz, ends_at timestamptz)
language plpgsql stable security definer
set search_path = pg_catalog, public as $$
declare v_link record;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Only the internal service may read slots for a link.';
  end if;
  select * into v_link from public.resolve_booking_link_v6(p_token);
  if v_link.link_id is null then return; end if;
  return query select * from public.available_slots_v6(v_link.client_id, p_days);
end $$;

revoke all on function public.public_slots_for_link_v6(text, integer)
  from public, anon, authenticated;
grant execute on function public.public_slots_for_link_v6(text, integer) to service_role;

select lock_down_definer_functions();

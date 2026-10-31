-- B066 and B068 / 281: the configuration nobody can enter.
--
-- Booking and nurture are built. 255 and 256 compute slots, hold them under
-- an advisory lock and record an appointment; 251 and 252 enrol a lead and
-- walk it through a sequence; 250's courier sends each message under the
-- per-message rules. `available_slots_v6`, `book_appointment_v6`,
-- `public_slots_for_link_v6`, `enroll_lead_in_sequence_v6`,
-- `advance_sequences_v6` and `approve_nurture_sequence_v6` all exist.
--
-- What does not exist is any way to put the configuration in. Nothing in the
-- database or the browser writes `client_booking_settings`,
-- `client_booking_windows`, `nurture_sequences` or `nurture_sequence_steps`.
-- Production holds zero rows in all four. So the machinery runs correctly
-- over an empty week and an empty sequence list, which is why
-- `available_slots_v6` returns nothing for every client and no lead can be
-- enrolled in anything.
--
-- That is the whole of B066 and B068's remaining gap. Not the booking loop,
-- not the sequencer: the entry points.
--
-- WHY A WEEK IS REPLACED AND NOT APPENDED TO
--
-- `replace_client_booking_windows_v6` takes the whole week and swaps it in
-- one statement. An add-one-window function would be easier to write and
-- would leave half a week live while somebody typed the rest, and the half
-- that is live is the half a prospect can book into. The same reasoning
-- applies to a sequence's steps: a sequence with steps 1 and 3 present and 2
-- still being written is a sequence that sends the wrong message next.
--
-- WHY ENABLING IS SEPARATE FROM CONFIGURING
--
-- The same split 160 and 218 use for publishing: stating the hours is not
-- the same decision as letting a stranger take one of them. So the settings
-- writer never touches `enabled`, and the switch refuses to go on when the
-- week is empty -- an enabled booking page with no windows offers slots that
-- do not exist, which is the failure 255's own header calls the worst one in
-- the convert layer.
--
-- WHAT THIS DOES NOT DO
--
-- It enables nothing and sends nothing. Every switch stays where it was.
-- A sequence created here is unapproved, so `enroll_due_leads_v6` will not
-- enrol anyone into it until a person approves it, and the courier still
-- requires the client's outbound switch and the runtime's. Editing an
-- approved sequence's steps un-approves it, which is 252's existing
-- `guard_sequence_shape_change` trigger doing its job rather than anything
-- added here: a changed shape has to be decided again.

-- ---------------------------------------------------------------------------
-- The hours a client will honour
-- ---------------------------------------------------------------------------

-- Small enough to inline, but it is asked twice and the answer has to be the
-- same both times.
create or replace function public.booking_enabled_for_client_v6(p_client_id uuid)
returns boolean
language sql stable security definer
set search_path = pg_catalog, public
as $$
  select coalesce((select s.enabled from public.client_booking_settings s
                    where s.client_id = p_client_id), false);
$$;


create or replace function public.set_client_booking_settings_v6(
  p_client_id uuid,
  p_timezone text,
  p_slot_minutes integer,
  p_buffer_minutes integer,
  p_min_notice_hours integer,
  p_max_days_ahead integer,
  p_max_per_day integer
) returns public.client_booking_settings
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare
  v_row public.client_booking_settings;
  v_zone text := btrim(coalesce(p_timezone, ''));
begin
  if not public.can_access_client(p_client_id) then
    raise exception 'Not permitted for this client';
  end if;

  -- A zone name the server does not know would make every slot this client
  -- offers land at the wrong clock time, and the failure would show up as a
  -- prospect arriving an hour late rather than as an error here.
  if v_zone = '' or not exists (
       select 1 from pg_catalog.pg_timezone_names where name = v_zone) then
    raise exception 'Unknown timezone: %. Use an IANA name such as Africa/Johannesburg.', p_timezone;
  end if;

  -- The column checks own the ranges. Reaching them with a clear message
  -- beats restating each bound here and letting the two drift apart.
  insert into public.client_booking_settings as s (
    client_id, timezone, slot_minutes, buffer_minutes,
    min_notice_hours, max_days_ahead, max_per_day)
  values (p_client_id, v_zone, p_slot_minutes, p_buffer_minutes,
          p_min_notice_hours, p_max_days_ahead, p_max_per_day)
  on conflict (client_id) do update
     set timezone = excluded.timezone,
         slot_minutes = excluded.slot_minutes,
         buffer_minutes = excluded.buffer_minutes,
         min_notice_hours = excluded.min_notice_hours,
         max_days_ahead = excluded.max_days_ahead,
         max_per_day = excluded.max_per_day,
         -- Deliberately not `enabled`. Stating the hours is not the decision
         -- to let somebody take one.
         updated_at = now()
  returning s.* into v_row;

  return v_row;
end $$;

comment on function public.set_client_booking_settings_v6(uuid, text, integer, integer, integer, integer, integer) is
  'Writes the booking rules a client will honour. Never changes the enabled switch: that is its own decision.';

-- ---------------------------------------------------------------------------
-- When in the week, as a whole week
-- ---------------------------------------------------------------------------

create or replace function public.replace_client_booking_windows_v6(
  p_client_id uuid,
  p_windows jsonb
) returns setof public.client_booking_windows
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare
  v_overlap record;
begin
  if not public.can_access_client(p_client_id) then
    raise exception 'Not permitted for this client';
  end if;
  if p_windows is null or jsonb_typeof(p_windows) <> 'array' then
    raise exception 'Pass the whole week as a JSON array of {day_of_week, starts_at_minute, ends_at_minute}.';
  end if;

  -- Parsed once per statement rather than into a temporary table: a temp
  -- table with `on commit drop` survives until commit, so a second call in
  -- the same transaction would collide with the first one's table.
  --
  -- Two windows on one day that overlap would offer the same minute twice.
  -- The table's unique key catches an identical start and its check catches a
  -- backwards window; neither catches 09:00-12:00 against 11:00-14:00, so it
  -- is caught here before anything is written.
  select a.dow as dow, a.starts as starts, b.starts as other_starts
    into v_overlap
    from (select (e->>'day_of_week')::integer as dow,
                 (e->>'starts_at_minute')::integer as starts,
                 (e->>'ends_at_minute')::integer as ends
            from jsonb_array_elements(p_windows) as e) a
    join (select (e->>'day_of_week')::integer as dow,
                 (e->>'starts_at_minute')::integer as starts,
                 (e->>'ends_at_minute')::integer as ends
            from jsonb_array_elements(p_windows) as e) b
      on b.dow = a.dow
     and (b.starts, b.ends) is distinct from (a.starts, a.ends)
     and b.starts < a.ends
     and a.starts < b.ends
   limit 1;
  if found then
    raise exception 'Two windows overlap on day %: one starts at minute % and another at minute %.',
      v_overlap.dow, v_overlap.starts, v_overlap.other_starts;
  end if;

  -- An empty week for a client whose booking is on would leave a live page
  -- offering nothing, so it is refused before the delete rather than after.
  if jsonb_array_length(p_windows) = 0 and public.booking_enabled_for_client_v6(p_client_id) then
    raise exception 'This client has booking switched on, so its week cannot be emptied. Switch booking off first.';
  end if;

  -- The swap. Both statements are in this function's transaction, so the
  -- client never has a partial week visible to the slot reader.
  delete from public.client_booking_windows where client_id = p_client_id;
  insert into public.client_booking_windows (client_id, day_of_week, starts_at_minute, ends_at_minute)
  select p_client_id,
         (e->>'day_of_week')::integer,
         (e->>'starts_at_minute')::integer,
         (e->>'ends_at_minute')::integer
    from jsonb_array_elements(p_windows) as e;

  return query
    select * from public.client_booking_windows
     where client_id = p_client_id
     order by day_of_week, starts_at_minute;
end $$;

comment on function public.replace_client_booking_windows_v6(uuid, jsonb) is
  'Swaps a client''s whole bookable week in one statement. A partial week is a week a prospect can book the wrong half of.';

-- ---------------------------------------------------------------------------
-- The switch
-- ---------------------------------------------------------------------------

create or replace function public.set_client_booking_enabled_v6(
  p_client_id uuid,
  p_enabled boolean
) returns public.client_booking_settings
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare
  v_row public.client_booking_settings;
  v_windows integer;
begin
  if not public.can_access_client(p_client_id) then
    raise exception 'Not permitted for this client';
  end if;

  select * into v_row from public.client_booking_settings where client_id = p_client_id;
  if not found then
    raise exception 'Set this client''s booking rules before switching booking on.';
  end if;

  if p_enabled then
    select count(*) into v_windows
      from public.client_booking_windows where client_id = p_client_id;
    if v_windows = 0 then
      raise exception 'This client has no bookable hours recorded, so switching booking on would offer slots that do not exist.';
    end if;
  end if;

  update public.client_booking_settings
     set enabled = p_enabled, updated_at = now()
   where client_id = p_client_id
  returning * into v_row;

  return v_row;
end $$;

comment on function public.set_client_booking_enabled_v6(uuid, boolean) is
  'Lets a prospect take a slot in this client''s week, or stops it. Refuses to go on over an empty week.';

-- ---------------------------------------------------------------------------
-- A sequence, and its shape
-- ---------------------------------------------------------------------------

create or replace function public.create_nurture_sequence_v6(
  p_client_id uuid,
  p_name text,
  p_purpose text,
  p_trigger_stage public.lead_stage,
  p_trigger_after_hours integer,
  p_exit_stages public.lead_stage[],
  p_enrolled_automatically boolean,
  p_campaign_id uuid
) returns public.nurture_sequences
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare
  v_row public.nurture_sequences;
begin
  if not public.can_access_client(p_client_id) then
    raise exception 'Not permitted for this client';
  end if;

  -- A campaign belonging to another client would attribute this client's
  -- sends to somebody else's campaign.
  if p_campaign_id is not null and not exists (
       select 1 from public.client_campaigns c
        where c.id = p_campaign_id and c.client_id = p_client_id) then
    raise exception 'That campaign does not belong to this client.';
  end if;

  if p_exit_stages is null or cardinality(p_exit_stages) = 0 then
    raise exception 'A sequence needs at least one exit stage, or it keeps messaging somebody who has already booked.';
  end if;
  if p_trigger_stage = any (p_exit_stages) then
    raise exception 'The trigger stage cannot also be an exit stage: a lead would be enrolled and exited at once.';
  end if;

  -- Created unapproved on purpose. approve_nurture_sequence_v6 is the human
  -- decision, and enroll_due_leads_v6 will not touch an unapproved sequence.
  insert into public.nurture_sequences (
    client_id, name, purpose, campaign_id, trigger_stage,
    trigger_after_hours, exit_stages, enrolled_automatically, created_by)
  values (p_client_id, btrim(p_name), p_purpose, p_campaign_id, p_trigger_stage,
          p_trigger_after_hours, p_exit_stages, coalesce(p_enrolled_automatically, false),
          auth.uid())
  returning * into v_row;

  return v_row;
end $$;

comment on function public.create_nurture_sequence_v6(uuid, text, text, public.lead_stage, integer, public.lead_stage[], boolean, uuid) is
  'Creates an unapproved nurture sequence. Approval is a separate human decision and nothing enrols into it before that.';

create or replace function public.set_nurture_sequence_steps_v6(
  p_sequence_id uuid,
  p_steps jsonb
) returns setof public.nurture_sequence_steps
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare
  v_sequence public.nurture_sequences;
  v_expected integer;
  v_bad uuid;
begin
  select * into v_sequence from public.nurture_sequences where id = p_sequence_id;
  if not found then raise exception 'No such sequence.'; end if;
  if not public.can_access_client(v_sequence.client_id) then
    raise exception 'Not permitted for this client';
  end if;
  if v_sequence.archived_at is not null then
    raise exception 'That sequence is archived.';
  end if;
  if p_steps is null or jsonb_typeof(p_steps) <> 'array' or jsonb_array_length(p_steps) = 0 then
    raise exception 'Pass the whole sequence as a JSON array of {position, delay_hours, template_version_id}.';
  end if;

  -- Same reasoning as the week: parsed per statement, because a temporary
  -- table with `on commit drop` would still exist on a second call in the
  -- same transaction.

  -- Positions have to run 1..n with no gaps: the sequencer reads them in
  -- order, and a missing 2 would send step 3 second.
  select count(*) into v_expected from jsonb_array_elements(p_steps);
  if exists (
       select 1 from jsonb_array_elements(p_steps) as e
        where (e->>'position')::integer < 1
           or (e->>'position')::integer > v_expected)
     or (select count(distinct (e->>'position')::integer)
           from jsonb_array_elements(p_steps) as e) <> v_expected then
    raise exception 'Step positions must run 1 to % with no gaps or repeats.', v_expected;
  end if;

  -- A template version that does not exist, which the foreign key would
  -- catch on insert but with a far less useful message.
  select (e->>'template_version_id')::uuid into v_bad
    from jsonb_array_elements(p_steps) as e
   where not exists (
     select 1 from public.message_template_versions v
      where v.id = (e->>'template_version_id')::uuid)
   limit 1;
  if v_bad is not null then
    raise exception 'There is no template version %.', v_bad;
  end if;

  -- Another client's template would send their words to this client's leads.
  select v.id into v_bad
    from jsonb_array_elements(p_steps) as e
    join public.message_template_versions v on v.id = (e->>'template_version_id')::uuid
   where v.client_id <> v_sequence.client_id
   limit 1;
  if v_bad is not null then
    raise exception 'Template version % belongs to another client.', v_bad;
  end if;

  -- An unapproved or withdrawn template has no consent basis recorded, and
  -- the courier would be sending words nobody cleared.
  select (e->>'template_version_id')::uuid into v_bad
    from jsonb_array_elements(p_steps) as e
   where not exists (
     select 1 from public.message_template_approvals a
      where a.template_version_id = (e->>'template_version_id')::uuid
        and a.status = 'approved' and a.revoked_at is null)
   limit 1;
  if v_bad is not null then
    raise exception 'Template version % has no current approval. Approve it before putting it in a sequence.', v_bad;
  end if;

  -- The swap. 252's guard_sequence_shape_change fires on these writes and
  -- clears any approval this sequence held, which is the point: a different
  -- shape is a different thing to agree to.
  delete from public.nurture_sequence_steps where sequence_id = p_sequence_id;
  insert into public.nurture_sequence_steps (
    sequence_id, client_id, position, delay_hours, template_version_id)
  select p_sequence_id, v_sequence.client_id,
         (e->>'position')::integer,
         (e->>'delay_hours')::integer,
         (e->>'template_version_id')::uuid
    from jsonb_array_elements(p_steps) as e;

  return query
    select * from public.nurture_sequence_steps
     where sequence_id = p_sequence_id
     order by position;
end $$;

comment on function public.set_nurture_sequence_steps_v6(uuid, jsonb) is
  'Replaces a sequence''s steps in one statement, refusing another client''s template or one without a current approval. Changing the shape clears the sequence''s own approval.';

-- ---------------------------------------------------------------------------
-- Exposure
-- ---------------------------------------------------------------------------

revoke all on function public.set_client_booking_settings_v6(uuid, text, integer, integer, integer, integer, integer) from public;
revoke all on function public.replace_client_booking_windows_v6(uuid, jsonb) from public;
revoke all on function public.booking_enabled_for_client_v6(uuid) from public;
revoke all on function public.set_client_booking_enabled_v6(uuid, boolean) from public;
revoke all on function public.create_nurture_sequence_v6(uuid, text, text, public.lead_stage, integer, public.lead_stage[], boolean, uuid) from public;
revoke all on function public.set_nurture_sequence_steps_v6(uuid, jsonb) from public;

-- Configuring a client is a signed-in person's job, and can_access_client
-- decides which client. The service role configures nobody: no sweep needs
-- to invent a client's opening hours.
grant execute on function public.set_client_booking_settings_v6(uuid, text, integer, integer, integer, integer, integer) to authenticated;
grant execute on function public.replace_client_booking_windows_v6(uuid, jsonb) to authenticated;
grant execute on function public.booking_enabled_for_client_v6(uuid) to authenticated;
grant execute on function public.set_client_booking_enabled_v6(uuid, boolean) to authenticated;
grant execute on function public.create_nurture_sequence_v6(uuid, text, text, public.lead_stage, integer, public.lead_stage[], boolean, uuid) to authenticated;
grant execute on function public.set_nurture_sequence_steps_v6(uuid, jsonb) to authenticated;

select lock_down_definer_functions();

-- The one human commit.
--
-- M4. Everything before this point can happen without a person: the engine
-- plans a slot, picks an idea, approves it by policy, briefs it, builds it,
-- writes its copy and checks its own work. This is where that stops.
--
-- `human_approved_at` has been the gate since migration 105 and nothing in
-- the engine touches it — migration 152 has a test asserting the string does
-- not appear in the policy functions at all. What was missing is the other
-- half: a person approving an asset did not move the slot that produced it,
-- so the engine's work could be signed off and still never reach a calendar.
--
-- Two acts, and they are deliberately not one function with a flag. Approving
-- creates a scheduled post; rejecting sends the work back to be remade. They
-- share a slot and nothing else, and a single `review_slot(decision)` would
-- read as though they were variations of each other.

-- ---------------------------------------------------------------------------
-- Yes
-- ---------------------------------------------------------------------------

create or replace function public.approve_slot(p_slot_id uuid, p_note text default null)
returns content_slots
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_slot content_slots;
  v_post uuid;
begin
  select * into v_slot from content_slots where id = p_slot_id for update;
  if not found then
    raise exception 'No such slot: %.', p_slot_id using errcode = 'P0001';
  end if;
  if not can_access_client(v_slot.client_id) then
    raise exception 'Not permitted for this client';
  end if;
  if v_slot.stage <> 'awaiting_approval' then
    raise exception 'That slot is %, not waiting for approval.', v_slot.stage using errcode = 'P0001';
  end if;
  if v_slot.asset_id is null then
    raise exception 'That slot has no asset to approve.' using errcode = 'P0001';
  end if;

  -- The commit itself, through the same function every other screen uses, so
  -- the decision is recorded in client_asset_reviews and attributed to the
  -- person exactly as a hand-made asset's approval is.
  perform review_media_asset(v_slot.asset_id, 'approved'::review_status, p_note);

  -- The calendar entry. scheduled_at is what the planner chose, in the
  -- client's own time (migration 144), so an approved post goes out when it
  -- was planned to rather than whenever it was approved.
  -- client_id set here rather than left to sync_scheduled_post_from_asset:
  -- this function already knows it, and post_copy's own trigger resolves a
  -- post's client from this column the moment the copy below is inserted.
  insert into scheduled_posts (client_id, asset_id, scheduled_for, scheduled_at, channel, platform, created_by)
  values (
    v_slot.client_id,
    v_slot.asset_id,
    (v_slot.scheduled_at at time zone client_timezone(v_slot.client_id))::date,
    v_slot.scheduled_at,
    'organic'::post_channel,
    v_slot.platform,
    auth.uid()
  )
  returning id into v_post;

  -- Copy written against the asset becomes copy for this post, so the
  -- publisher reads one row rather than resolving the fallback itself.
  insert into post_copy (scheduled_post_id, platform, caption, hashtags, alt_text,
                         link_url, first_comment, cta, source)
  select v_post, pc.platform, pc.caption, pc.hashtags, pc.alt_text,
         pc.link_url, pc.first_comment, pc.cta, pc.source
    from post_copy pc
   where pc.asset_id = v_slot.asset_id
  on conflict (scheduled_post_id, platform) where scheduled_post_id is not null
  do nothing;

  perform advance_slot(
    p_slot_id, 'scheduled', 'human',
    coalesce(p_note, 'Approved.'), null, null, null, null, null, null, v_post);

  select * into v_slot from content_slots where id = p_slot_id;
  return v_slot;
end;
$$;

comment on function public.approve_slot(uuid, text) is
  'A person approves a slot: the asset gets its human sign-off, a scheduled post is created at the planned time, and the slot moves to scheduled. The one human commit.';

-- ---------------------------------------------------------------------------
-- No
-- ---------------------------------------------------------------------------

create or replace function public.reject_slot(p_slot_id uuid, p_reason text)
returns content_slots
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_slot content_slots;
begin
  if coalesce(btrim(p_reason), '') = '' then
    -- Rejecting without saying why leaves the engine to make the same thing
    -- again, which is the one outcome nobody wants.
    raise exception 'Say why it was rejected: the engine makes it again from this.' using errcode = 'P0001';
  end if;

  select * into v_slot from content_slots where id = p_slot_id for update;
  if not found then
    raise exception 'No such slot: %.', p_slot_id using errcode = 'P0001';
  end if;
  if not can_access_client(v_slot.client_id) then
    raise exception 'Not permitted for this client';
  end if;
  if v_slot.stage <> 'awaiting_approval' then
    raise exception 'That slot is %, not waiting for approval.', v_slot.stage using errcode = 'P0001';
  end if;

  if v_slot.asset_id is not null then
    perform review_media_asset(v_slot.asset_id, 'rejected'::review_status, p_reason);
  end if;

  perform advance_slot(p_slot_id, 'rejected', 'human', p_reason);

  select * into v_slot from content_slots where id = p_slot_id;
  return v_slot;
end;
$$;

comment on function public.reject_slot(uuid, text) is
  'A person rejects a slot. The reason is required, because it is what the engine makes the next attempt from.';

-- Reject means regenerate, and the person decides when rather than it
-- happening under them. Separate from reject_slot so "no, and stop" and
-- "no, try again" are different acts.
create or replace function public.regenerate_slot(p_slot_id uuid)
returns content_slots
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_slot content_slots;
begin
  select * into v_slot from content_slots where id = p_slot_id for update;
  if not found then
    raise exception 'No such slot: %.', p_slot_id using errcode = 'P0001';
  end if;
  if not can_access_client(v_slot.client_id) then
    raise exception 'Not permitted for this client';
  end if;
  if v_slot.stage <> 'rejected' then
    raise exception 'Only a rejected slot is made again. That one is %.', v_slot.stage using errcode = 'P0001';
  end if;
  if v_slot.idea_id is null then
    raise exception 'That slot has no idea to write a new brief from.' using errcode = 'P0001';
  end if;

  perform advance_slot(p_slot_id, 'briefing', 'human', 'Rejected, and being made again.');

  select * into v_slot from content_slots where id = p_slot_id;
  return v_slot;
end;
$$;

comment on function public.regenerate_slot(uuid) is
  'Send a rejected slot back to be written and built again from the same idea. The tick picks it up at briefing.';

revoke all on function public.approve_slot(uuid, text) from public;
revoke all on function public.reject_slot(uuid, text) from public;
revoke all on function public.regenerate_slot(uuid) from public;
grant execute on function public.approve_slot(uuid, text) to authenticated;
grant execute on function public.reject_slot(uuid, text) to authenticated;
grant execute on function public.regenerate_slot(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- A slot resting at briefing gets a brief
-- ---------------------------------------------------------------------------

-- Until now 'briefing' was only ever passed through: the tick moved a slot
-- there and queued the brief in the same act, so nothing needed to act on a
-- slot already in it. Regeneration puts a slot there with no job, and so does
-- a brief job that died. One row makes both recover on the next tick instead
-- of resting there forever.
insert into slot_pipeline (stage, format, agent_key, enter_stage, note, input_table, input_column)
values ('briefing', null, 'brief', null, 'Write the brief for the chosen idea.', 'client_ideas', 'idea_id')
on conflict (stage, format) do nothing;

-- ---------------------------------------------------------------------------
-- What is waiting, and how long it has waited
-- ---------------------------------------------------------------------------

create or replace view approval_inbox with (security_invoker = true) as
select
  q.*,
  now() - (select max(e.created_at) from slot_events e
            where e.slot_id = q.slot_id and e.to_stage = 'awaiting_approval') as waiting_for,
  q.scheduled_at - now() as goes_out_in,
  -- Past its own slot and still unapproved: approving it now would schedule
  -- something for a time that has gone.
  q.scheduled_at <= now() as overdue
from approval_queue_slots q;

comment on view approval_inbox is
  'Everything waiting on a person, oldest wait first, with how long until the post was meant to go out. Reading this is the whole of the approval screen.';

grant select on approval_inbox to authenticated;

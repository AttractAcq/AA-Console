-- An assignment had two states, and needed seven.
--
-- job_assignments carries one nullable timestamp, completed_at, so a piece
-- of work handed to a person is either outstanding or finished. Four things
-- follow from that, and all four are live:
--
--   1. Delivered and approved are the same thing. ProductionWorkspace marks
--      completed_at the moment a file is uploaded and tells the maker "it is
--      now waiting for approval" -- while the agency's own queue has already
--      closed the job. The asset sits at review_status 'pending' and nothing
--      is outstanding anywhere.
--
--   2. A rejection goes nowhere. If that asset is then rejected, the
--      assignment is already closed. There is no row that says somebody owes
--      another version, and the reason the reviewer typed reaches nobody.
--
--   3. Nobody can decline. An editor who cannot take a job has no way to say
--      so, and the agency finds out when the due date passes.
--
--   4. due_date exists and nothing compares it to anything. No query in this
--      system has ever asked which assignments are late.
--
-- The shape is the one content_slots already uses, deliberately: a stage
-- column written only by one function, a table of legal moves rather than a
-- CASE, and an append-only log. That pattern was hardened in 161 and there
-- is no reason for the human half of the pipeline to invent a second one.
--
-- completed_at stays, and changes meaning: it is set when the work is
-- approved rather than when a file arrives. Three screens read it and keep
-- working. The visible consequence is that delivered-but-unapproved work
-- reappears in the open queue, which is correct -- it is not finished -- and
-- was the first fault on the list.

create type assignment_stage as enum (
  'assigned',   -- handed over; the person has not said anything yet
  'accepted',   -- they have said they will do it
  'declined',   -- they cannot. Needs reassigning, and says why
  'delivered',  -- a file is in, waiting on a reviewer
  'rework',     -- the asset was rejected. Somebody owes another version
  'approved',   -- the asset was approved. The only true done
  'cancelled'   -- the agency withdrew it
);

comment on type assignment_stage is
  'Where a piece of assigned work has got to. delivered and approved are deliberately different: a file arriving is not a file anybody has accepted.';

alter table job_assignments
  add column if not exists stage assignment_stage not null default 'assigned',
  add column if not exists accepted_at timestamptz,
  add column if not exists delivered_at timestamptz,
  add column if not exists asset_id uuid references client_media_assets(id) on delete set null,
  -- Why it was declined, or what the rework is. In words, for the person who
  -- has to act on it.
  add column if not exists stage_reason text;

comment on column job_assignments.stage is
  'Written only by advance_assignment. A direct update is refused by trigger, for every role.';
comment on column job_assignments.completed_at is
  'When the work was approved -- not when a file arrived. Maintained by advance_assignment; delivered work has a delivered_at and no completed_at.';
comment on column job_assignments.stage_reason is
  'Why it was declined, or what needs redoing. The only part of a rejection the maker can act on.';

create index if not exists job_assignments_stage_idx on job_assignments (member_id, stage, due_date);
create index if not exists job_assignments_open_idx on job_assignments (due_date)
  where stage in ('assigned', 'accepted', 'rework');

-- ---------------------------------------------------------------------------
-- Backfilling the thirteen rows that exist
-- ---------------------------------------------------------------------------

-- Precise rather than convenient. completed_at was set by the upload path,
-- so those rows are at least delivered; whether they were ever approved is
-- a fact about the asset, so it is read from the asset rather than assumed.
-- A row with no completed_at becomes 'assigned' and not 'accepted': nothing
-- ever recorded an acceptance, and inventing one would be the same class of
-- claim this migration exists to stop.
update job_assignments a
   set stage = case
         when a.completed_at is null then 'assigned'::assignment_stage
         when exists (
           select 1 from client_media_assets m
            where m.brief_id = a.brief_id
              and m.member_id = a.member_id
              and m.human_approved_at is not null
         ) then 'approved'::assignment_stage
         else 'delivered'::assignment_stage
       end,
       delivered_at = a.completed_at,
       completed_at = case
         when a.completed_at is not null and exists (
           select 1 from client_media_assets m
            where m.brief_id = a.brief_id
              and m.member_id = a.member_id
              and m.human_approved_at is not null
         ) then a.completed_at
         else null
       end
 where a.stage = 'assigned';

-- ---------------------------------------------------------------------------
-- What may follow what
-- ---------------------------------------------------------------------------

create table if not exists assignment_transitions (
  from_stage assignment_stage not null,
  to_stage assignment_stage not null,
  note text,
  primary key (from_stage, to_stage)
);

comment on table assignment_transitions is
  'The legal moves. advance_assignment refuses anything not in here. Data, not code, so the rules can be read and rendered.';

insert into assignment_transitions (from_stage, to_stage, note) values
  ('assigned',  'accepted',  'The person said they will do it.'),
  ('assigned',  'declined',  'The person cannot take it.'),
  -- An editor who simply gets on with it and uploads. Making them press
  -- Accept first would be ceremony enforced by a database.
  ('assigned',  'delivered', 'A file arrived without a separate acceptance.'),
  ('assigned',  'cancelled', 'The agency withdrew it before anybody started.'),
  ('accepted',  'delivered', 'The work was delivered.'),
  ('accepted',  'declined',  'Accepted and then handed back.'),
  ('accepted',  'cancelled', 'The agency withdrew it.'),
  ('declined',  'assigned',  'Given to somebody else.'),
  ('delivered', 'approved',  'A reviewer approved the asset.'),
  ('delivered', 'rework',    'A reviewer rejected the asset.'),
  ('delivered', 'cancelled', 'The agency withdrew it rather than reviewing it.'),
  ('rework',    'delivered', 'Another version arrived.'),
  ('rework',    'declined',  'The person will not do the rework.'),
  ('rework',    'cancelled', 'The agency gave up on it.')
on conflict (from_stage, to_stage) do nothing;

-- ---------------------------------------------------------------------------
-- The log
-- ---------------------------------------------------------------------------

create table if not exists assignment_events (
  id uuid primary key default gen_random_uuid(),
  assignment_id uuid not null references job_assignments(id) on delete cascade,
  from_stage assignment_stage,
  to_stage assignment_stage not null,
  -- Who moved it. 'maker' is the person it is assigned to, 'agency' is
  -- somebody on the inside, 'review' is the asset decision driving it.
  actor text not null default 'agency',
  actor_id uuid references auth.users(id) on delete set null,
  note text,
  created_at timestamptz not null default now(),
  constraint ae_actor check (actor in ('maker', 'agency', 'review', 'system'))
);

create index if not exists assignment_events_idx on assignment_events (assignment_id, created_at);

comment on table assignment_events is
  'Every accepted move, in order. Append-only, by the same argument as slot_events: a timeline that can be edited is a story.';

create or replace function public.refuse_assignment_event_change()
returns trigger
language plpgsql
set search_path to 'public'
as $$
begin
  if tg_op = 'UPDATE' then
    raise exception 'assignment_events is append-only: an event cannot be edited.' using errcode = 'P0001';
  end if;
  -- The cascade from deleting the assignment itself is the cascade doing its
  -- job, not somebody editing the record. By then the parent is already gone.
  if exists (select 1 from job_assignments a where a.id = old.assignment_id) then
    raise exception 'assignment_events is append-only: delete the assignment, not its history.'
      using errcode = 'P0001';
  end if;
  return old;
end;
$$;

drop trigger if exists ae_append_only on assignment_events;
create trigger ae_append_only before update or delete on assignment_events
for each row execute function public.refuse_assignment_event_change();

-- ---------------------------------------------------------------------------
-- One writer
-- ---------------------------------------------------------------------------

create or replace function public.may_touch_assignment(p_member_id uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select coalesce(auth.role(), '') in ('service_role', '')
      or is_admin()
      or is_member(p_member_id)
$$;

comment on function public.may_touch_assignment(uuid) is
  'Whether the caller may move this assignment: the runtime, the database itself, an admin, or the person it belongs to.';

create or replace function public.guard_assignment_stage()
returns trigger
language plpgsql
set search_path to 'public'
as $$
begin
  if new.stage is distinct from old.stage
     and coalesce(current_setting('aa.advancing_assignment', true), '') <> new.id::text then
    raise exception
      'An assignment stage changes through advance_assignment, not by direct update. Tried % -> % on %.',
      old.stage, new.stage, new.id
      using errcode = 'P0001';
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists ja_guard_stage on job_assignments;
create trigger ja_guard_stage before update on job_assignments
for each row execute function public.guard_assignment_stage();

create or replace function public.advance_assignment(
  p_assignment_id uuid,
  p_to_stage assignment_stage,
  p_actor text default 'agency',
  p_reason text default null,
  p_asset_id uuid default null
)
returns job_assignments
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_row job_assignments;
  v_from assignment_stage;
begin
  select * into v_row from job_assignments where id = p_assignment_id for update;
  if not found then
    raise exception 'No such assignment: %.', p_assignment_id using errcode = 'P0001';
  end if;
  if not may_touch_assignment(v_row.member_id) then
    raise exception 'Not permitted for this assignment';
  end if;

  v_from := v_row.stage;
  if v_from = p_to_stage then
    raise exception 'That assignment is already %.', p_to_stage using errcode = 'P0001';
  end if;
  if not exists (
    select 1 from assignment_transitions t
     where t.from_stage = v_from and t.to_stage = p_to_stage
  ) then
    raise exception 'An assignment cannot go from % to %.', v_from, p_to_stage using errcode = 'P0001';
  end if;
  if p_actor not in ('maker', 'agency', 'review', 'system') then
    raise exception 'Unknown actor "%".', p_actor using errcode = 'P0001';
  end if;
  -- Declining and reworking are the two moves whose whole value is the
  -- reason. Without it the next person has nothing to act on.
  if p_to_stage in ('declined', 'rework') and coalesce(btrim(p_reason), '') = '' then
    raise exception 'Say why: a % with no reason leaves the next person nothing to act on.', p_to_stage
      using errcode = 'P0001';
  end if;

  perform set_config('aa.advancing_assignment', p_assignment_id::text, true);

  update job_assignments set
    stage = p_to_stage,
    asset_id = coalesce(p_asset_id, asset_id),
    accepted_at = case when p_to_stage = 'accepted' then now() else accepted_at end,
    delivered_at = case when p_to_stage = 'delivered' then now() else delivered_at end,
    -- The meaning of this column: approved, not delivered. Cleared on the
    -- way back out, so work sent for rework stops counting as finished.
    completed_at = case when p_to_stage = 'approved' then now() else null end,
    -- A reason belongs to the state that needed one.
    stage_reason = case when p_to_stage in ('declined', 'rework') then p_reason else null end
  where id = p_assignment_id;

  perform set_config('aa.advancing_assignment', '', true);

  insert into assignment_events (assignment_id, from_stage, to_stage, actor, actor_id, note)
  values (p_assignment_id, v_from, p_to_stage, p_actor, auth.uid(), p_reason);

  select * into v_row from job_assignments where id = p_assignment_id;
  return v_row;
end;
$$;

comment on function public.advance_assignment is
  'Move an assignment to its next stage. The only thing that may write job_assignments.stage. Refuses a move that is not in assignment_transitions, and a decline or rework with no reason.';

-- ---------------------------------------------------------------------------
-- The acts, named
-- ---------------------------------------------------------------------------

-- Separate functions rather than one with a stage argument, for the same
-- reason approve_slot and reject_slot are separate: accepting work and
-- handing it back are not variations of each other.

create or replace function public.accept_assignment(p_assignment_id uuid)
returns job_assignments language sql security definer set search_path to 'public'
as $$ select advance_assignment(p_assignment_id, 'accepted', 'maker') $$;

create or replace function public.decline_assignment(p_assignment_id uuid, p_reason text)
returns job_assignments language sql security definer set search_path to 'public'
as $$ select advance_assignment(p_assignment_id, 'declined', 'maker', p_reason) $$;

create or replace function public.deliver_assignment(p_assignment_id uuid, p_asset_id uuid)
returns job_assignments language sql security definer set search_path to 'public'
as $$ select advance_assignment(p_assignment_id, 'delivered', 'maker', null, p_asset_id) $$;

-- Declined work has to go somewhere, and "somewhere" is a person. Does both
-- halves in one act so an assignment is never left declined-and-forgotten.
create or replace function public.reassign_assignment(
  p_assignment_id uuid,
  p_member_id uuid,
  p_reason text default null
)
returns job_assignments
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_row job_assignments;
begin
  if not is_admin() then
    raise exception 'Reassigning work is an agency decision.' using errcode = 'P0001';
  end if;
  select * into v_row from job_assignments where id = p_assignment_id for update;
  if not found then
    raise exception 'No such assignment: %.', p_assignment_id using errcode = 'P0001';
  end if;
  if v_row.stage <> 'declined' then
    raise exception 'Only declined work is reassigned. That one is %.', v_row.stage using errcode = 'P0001';
  end if;
  if p_member_id = v_row.member_id then
    raise exception 'That is the person who declined it.' using errcode = 'P0001';
  end if;

  update job_assignments set member_id = p_member_id where id = p_assignment_id;
  return advance_assignment(
    p_assignment_id, 'assigned', 'agency',
    coalesce(p_reason, 'Reassigned.'));
end;
$$;

create or replace function public.cancel_assignment(p_assignment_id uuid, p_reason text default null)
returns job_assignments language plpgsql security definer set search_path to 'public'
as $$
begin
  if not is_admin() then
    raise exception 'Withdrawing work is an agency decision.' using errcode = 'P0001';
  end if;
  return advance_assignment(p_assignment_id, 'cancelled', 'agency', p_reason);
end;
$$;

revoke all on function public.advance_assignment(uuid, assignment_stage, text, text, uuid) from public, anon;
revoke all on function public.accept_assignment(uuid) from public, anon;
revoke all on function public.decline_assignment(uuid, text) from public, anon;
revoke all on function public.deliver_assignment(uuid, uuid) from public, anon;
revoke all on function public.reassign_assignment(uuid, uuid, text) from public, anon;
revoke all on function public.cancel_assignment(uuid, text) from public, anon;
revoke all on function public.may_touch_assignment(uuid) from public, anon;
grant execute on function public.advance_assignment(uuid, assignment_stage, text, text, uuid) to authenticated, service_role;
grant execute on function public.accept_assignment(uuid) to authenticated;
grant execute on function public.decline_assignment(uuid, text) to authenticated;
grant execute on function public.deliver_assignment(uuid, uuid) to authenticated, service_role;
grant execute on function public.reassign_assignment(uuid, uuid, text) to authenticated;
grant execute on function public.cancel_assignment(uuid, text) to authenticated;
grant execute on function public.may_touch_assignment(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- The reviewer's decision drives the assignment
-- ---------------------------------------------------------------------------

-- This is the link that did not exist. review_media_asset is called from
-- five screens and from approve_slot, so a trigger catches all of them
-- rather than each one remembering. Rejecting an asset now puts the work
-- back on somebody's list with the reviewer's own words attached.
--
-- ON THE REVIEW ROW, NOT ON THE ASSET
--
-- The obvious place is an AFTER UPDATE on client_media_assets guarded by
-- "did review_status change". It is wrong, and wrong in exactly the case
-- this feature is for: the rework loop. Reject, redeliver, reject again --
-- the second rejection leaves review_status at 'rejected', so the guard sees
-- no change and the assignment is never told. The maker is left at
-- 'delivered' with no reason while the reviewer believes they sent one.
--
-- client_asset_reviews gets a row per decision, so the decision itself is
-- the event. Firing on the insert catches the second rejection and the
-- tenth.
create or replace function public.assignment_follows_review()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_id uuid;
  v_asset client_media_assets;
begin
  if new.decision not in ('approved', 'rejected') then
    return new;
  end if;

  select * into v_asset from client_media_assets where id = new.asset_id;
  if not found then
    return new;
  end if;

  select a.id into v_id
    from job_assignments a
   where (a.asset_id = v_asset.id
          or (a.asset_id is null and a.brief_id = v_asset.brief_id
              and a.member_id = v_asset.member_id))
     and a.stage = 'delivered'
   order by a.created_at desc
   limit 1;
  if v_id is null then
    return new;
  end if;

  if new.decision = 'approved' then
    perform advance_assignment(v_id, 'approved', 'review', null, v_asset.id);
  else
    -- The reason the reviewer typed, which is the only part of a rejection
    -- the maker can act on. Taken from this row rather than looked up, so
    -- a second rejection carries its own words and not the first one's.
    perform advance_assignment(
      v_id, 'rework', 'review',
      coalesce(nullif(btrim(new.reason), ''), 'Rejected, with no reason recorded.'),
      v_asset.id);
  end if;

  return new;
end;
$$;

comment on function public.assignment_follows_review() is
  'Moves a delivered assignment when its asset is reviewed. On the review row rather than the asset, because a second rejection does not change the asset''s status and would otherwise never reach the maker.';

drop trigger if exists cma_assignment_follows_review on client_media_assets;
drop trigger if exists car_assignment_follows_review on client_asset_reviews;
create trigger car_assignment_follows_review after insert on client_asset_reviews
for each row execute function public.assignment_follows_review();

-- ---------------------------------------------------------------------------
-- What is outstanding, and what is late
-- ---------------------------------------------------------------------------

create or replace view assignment_board with (security_invoker = true) as
select
  a.id as assignment_id,
  a.member_id,
  m.name as member_name,
  a.client_id,
  c.name as client_name,
  a.title,
  a.brief_id,
  a.asset_id,
  a.stage::text as stage,
  a.stage_reason,
  a.due_date,
  a.compensation,
  a.accepted_at,
  a.delivered_at,
  a.completed_at,
  a.stage in ('approved', 'cancelled') as finished,
  -- due_date has existed since this table did and nothing has ever compared
  -- it to anything.
  (a.due_date is not null
    and a.due_date < current_date
    and a.stage in ('assigned', 'accepted', 'rework')) as overdue,
  case
    when a.due_date is null then null
    when a.stage in ('approved', 'cancelled') then null
    else greatest(current_date - a.due_date, 0)
  end as days_late
from job_assignments a
left join team_members m on m.id = a.member_id
left join clients c on c.id = a.client_id;

comment on view assignment_board is
  'Every assignment, where it has got to, and whether it is late. The first query in this system to compare due_date to anything.';

grant select on assignment_board to authenticated;

select public.lock_down_definer_functions();

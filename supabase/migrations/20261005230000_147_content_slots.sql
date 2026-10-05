-- A slot is one post the engine intends to make, and where it has got to.
--
-- M3.2. The planner (M3.3) creates slots; the tick (M3.4) pushes them along;
-- every agent that touches one reports back through advance_slot. So the
-- stage column is the single place the whole engine's progress is written,
-- and the one thing that must never be wrong.
--
-- "advance_slot is the only writer" is a claim that has to be enforced rather
-- than documented, because the moment one agent updates the column directly
-- to get itself unstuck, the transition rules stop meaning anything and the
-- event log silently develops holes. A BEFORE UPDATE trigger therefore
-- refuses any change to stage that did not come through advance_slot, which
-- announces itself with a transaction-local setting. That refusal applies to
-- an admin and to the service role too: being allowed to write the row is not
-- the same as being allowed to invent a transition.
--
-- Every accepted transition writes a slot_events row. The log is the timeline,
-- and it is append-only by the same argument.

create type slot_stage as enum (
  'planned',           -- the planner put it here; nothing has run
  'ideating',          -- ideation is running for this slot
  'idea_selected',     -- an idea has been picked, by policy or by a person
  'briefing',          -- the brief is being written
  'building',          -- stills, carousel or reel are being made
  'copywriting',       -- per-platform copy is being written (M0.2)
  'qa',                -- the QA agent is checking it
  'awaiting_approval', -- a person has to look at it. The one human gate.
  'scheduled',         -- approved and on the calendar
  'published',         -- it went out
  'failed',            -- something broke. blocked_reason says what
  'rejected'           -- a person said no
);

comment on type slot_stage is
  'Where a slot has got to. planned through published is the path; failed and rejected are side exits.';

create table if not exists content_slots (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,

  -- What the planner decided before anything ran.
  platform post_platform not null,
  -- The instant, as migration 144 taught the rest of the system to think.
  -- The planner puts this inside one of the client's posting windows.
  scheduled_at timestamptz not null,
  pillar_id uuid references client_content_pillars(id) on delete set null,
  format content_format not null default 'single',

  stage slot_stage not null default 'planned',

  -- Filled in as the slot moves. Each is the output of one stage.
  idea_id uuid references client_ideas(id) on delete set null,
  brief_id uuid references client_briefs(id) on delete set null,
  asset_id uuid references client_media_assets(id) on delete set null,
  scheduled_post_id uuid references scheduled_posts(id) on delete set null,

  -- How many times this slot has been round the loop. QA regenerating and a
  -- failure being retried both count, because both are the engine spending
  -- again on the same post.
  attempts integer not null default 0,
  cost_usd numeric(12, 4) not null default 0,

  -- Why it is stuck, in words for a person. Set on failed, cleared on the way
  -- out of it, so a slot that is moving never carries an old reason.
  blocked_reason text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint cs_attempts check (attempts >= 0),
  constraint cs_cost check (cost_usd >= 0)
);

comment on table content_slots is
  'One post the engine intends to make, and where it has got to. stage is written only by advance_slot.';
comment on column content_slots.stage is
  'Written only by advance_slot. A direct update is refused by trigger, for every role.';
comment on column content_slots.attempts is
  'Times round the loop. A QA regenerate and a retry after failure both count: both spend again on the same post.';
comment on column content_slots.blocked_reason is
  'Why a failed slot is stuck, in words for a person. Cleared whenever the slot leaves failed.';

-- The planner must be able to run twice without making the same post twice.
-- M3.3 leans on this rather than on its own bookkeeping.
create unique index if not exists content_slots_one_per_window
  on content_slots (client_id, platform, scheduled_at);

-- The tick asks "what is ready to move" every hour, per client.
create index if not exists content_slots_stage_idx on content_slots (client_id, stage, scheduled_at);
-- And "what is in flight", for the per-client cap in M3.4.
create index if not exists content_slots_in_flight_idx on content_slots (client_id)
  where stage in ('ideating', 'briefing', 'building', 'copywriting', 'qa');

-- ---------------------------------------------------------------------------
-- The log
-- ---------------------------------------------------------------------------

create table if not exists slot_events (
  id uuid primary key default gen_random_uuid(),
  slot_id uuid not null references content_slots(id) on delete cascade,
  -- Null on the first row: a slot is created at planned, it does not move there.
  from_stage slot_stage,
  to_stage slot_stage not null,
  -- Who moved it. 'engine' is the tick, 'agent' is a runtime job, 'human' is
  -- a person, 'policy' is an automatic approval standing in for one.
  actor text not null default 'engine',
  actor_id uuid references auth.users(id) on delete set null,
  agent_key text,
  job_id uuid,
  note text,
  cost_usd numeric(12, 4),
  created_at timestamptz not null default now(),
  constraint se_actor check (actor in ('engine', 'agent', 'human', 'policy'))
);

comment on table slot_events is
  'Every accepted transition, in order. The slot timeline. Append-only: no update or delete path exists.';

create index if not exists slot_events_slot_idx on slot_events (slot_id, created_at);

-- ---------------------------------------------------------------------------
-- What may follow what
-- ---------------------------------------------------------------------------

-- A table rather than a CASE, so the rules can be read, queried and shown in
-- the UI without being transcribed into a second place.
create table if not exists slot_transitions (
  from_stage slot_stage not null,
  to_stage slot_stage not null,
  note text,
  primary key (from_stage, to_stage)
);

comment on table slot_transitions is
  'The legal moves. advance_slot refuses anything not in here. Data, not code, so the state machine can be read and rendered.';

insert into slot_transitions (from_stage, to_stage, note) values
  -- The path.
  ('planned',           'ideating',          'The tick picked this slot up.'),
  ('ideating',          'idea_selected',     'An idea was chosen for it.'),
  ('idea_selected',     'briefing',          'The brief is being written.'),
  ('briefing',          'building',          'The brief is approved and the asset is being made.'),
  ('building',          'copywriting',       'The asset exists; now the words.'),
  ('copywriting',       'qa',                'Copy written, ready to be checked.'),
  ('qa',                'awaiting_approval', 'It passed QA and needs a person.'),
  ('awaiting_approval', 'scheduled',         'A person approved it.'),
  ('scheduled',         'published',         'It went out.'),
  -- QA sending work back. Not a failure: this is the regenerate loop in M3.9.
  ('qa',                'building',          'Below the QA threshold. Rebuilding the asset.'),
  ('qa',                'copywriting',       'The copy needs rewriting, the asset is fine.'),
  -- A person saying no.
  ('awaiting_approval', 'rejected',          'A person rejected it.'),
  ('rejected',          'briefing',          'Rejected, and being made again from the brief.'),
  -- Breaking, and being picked back up.
  ('planned',           'failed',            'It could not even be started.'),
  ('ideating',          'failed',            null),
  ('idea_selected',     'failed',            null),
  ('briefing',          'failed',            null),
  ('building',          'failed',            null),
  ('copywriting',       'failed',            null),
  ('qa',                'failed',            'QA could not be completed, or the rebuilds ran out.'),
  ('scheduled',         'failed',            'Publishing failed.'),
  ('failed',            'planned',           'Being retried from the top.')
on conflict (from_stage, to_stage) do nothing;

-- ---------------------------------------------------------------------------
-- Making advance_slot the only writer
-- ---------------------------------------------------------------------------

-- The guard. advance_slot sets a transaction-local key to the slot it is
-- moving; anything else changing stage has not done that and is refused.
-- is_local = true on set_config means it dies with the transaction, so the
-- permission cannot leak into the next statement on a pooled connection.
create or replace function public.guard_slot_stage()
returns trigger
language plpgsql
set search_path to 'public'
as $$
begin
  if new.stage is distinct from old.stage
     and coalesce(current_setting('aa.advancing_slot', true), '') <> new.id::text then
    raise exception
      'A slot stage changes through advance_slot, not by direct update. Tried % -> % on slot %.',
      old.stage, new.stage, new.id
      using errcode = 'P0001';
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists cs_guard_stage on content_slots;
create trigger cs_guard_stage before update on content_slots
for each row execute function public.guard_slot_stage();

-- The log is the timeline. A timeline that can be edited is a story.
--
-- Append-only, with one exception that is not an exception: when the slot
-- itself is being deleted, its history going with it is the cascade doing its
-- job, not somebody editing the record. Refusing that too would make a slot
-- -- and therefore a client -- undeletable forever, which is a worse problem
-- than the one this guard exists to prevent. By the time the cascade reaches
-- the children the parent row is already gone, so "does the slot still exist"
-- separates the two cases exactly.
create or replace function public.refuse_slot_event_change()
returns trigger
language plpgsql
set search_path to 'public'
as $$
begin
  if tg_op = 'UPDATE' then
    raise exception 'slot_events is append-only: an event cannot be edited.' using errcode = 'P0001';
  end if;
  if exists (select 1 from content_slots s where s.id = old.slot_id) then
    raise exception 'slot_events is append-only: delete the slot, not its history.' using errcode = 'P0001';
  end if;
  return old;
end;
$$;

drop trigger if exists se_append_only on slot_events;
create trigger se_append_only before update or delete on slot_events
for each row execute function public.refuse_slot_event_change();

-- ---------------------------------------------------------------------------
-- advance_slot
-- ---------------------------------------------------------------------------

create or replace function public.advance_slot(
  p_slot_id uuid,
  p_to_stage slot_stage,
  p_actor text default 'engine',
  p_note text default null,
  p_agent_key text default null,
  p_job_id uuid default null,
  p_cost_usd numeric default null,
  -- Set as part of the same move, so "the brief exists" and "the slot is past
  -- briefing" can never disagree.
  p_idea_id uuid default null,
  p_brief_id uuid default null,
  p_asset_id uuid default null,
  p_scheduled_post_id uuid default null,
  p_blocked_reason text default null
)
returns content_slots
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_slot content_slots;
  v_from slot_stage;
  v_row content_slots;
begin
  -- Lock first: two agents finishing at once must not both move the same slot.
  select * into v_slot from content_slots where id = p_slot_id for update;
  if not found then
    raise exception 'No such slot: %.', p_slot_id using errcode = 'P0001';
  end if;
  v_from := v_slot.stage;

  if v_from = p_to_stage then
    raise exception 'Slot % is already %.', p_slot_id, p_to_stage using errcode = 'P0001';
  end if;

  if not exists (
    select 1 from slot_transitions t where t.from_stage = v_from and t.to_stage = p_to_stage
  ) then
    raise exception 'A slot cannot go from % to %.', v_from, p_to_stage using errcode = 'P0001';
  end if;

  if p_actor not in ('engine', 'agent', 'human', 'policy') then
    raise exception 'Unknown actor "%".', p_actor using errcode = 'P0001';
  end if;

  -- Announce the move to the guard, for this transaction only.
  perform set_config('aa.advancing_slot', p_slot_id::text, true);

  update content_slots set
    stage = p_to_stage,
    idea_id = coalesce(p_idea_id, idea_id),
    brief_id = coalesce(p_brief_id, brief_id),
    asset_id = coalesce(p_asset_id, asset_id),
    scheduled_post_id = coalesce(p_scheduled_post_id, scheduled_post_id),
    cost_usd = cost_usd + coalesce(p_cost_usd, 0),
    -- Going round again is an attempt. Moving forward is not.
    attempts = attempts + case
      when p_to_stage in ('building', 'copywriting') and v_from = 'qa' then 1
      when p_to_stage = 'planned' and v_from = 'failed' then 1
      when p_to_stage = 'briefing' and v_from = 'rejected' then 1
      else 0
    end,
    -- A reason belongs to being stuck. Leaving failed clears it rather than
    -- carrying yesterday's explanation into a slot that is moving again.
    blocked_reason = case
      when p_to_stage = 'failed' then coalesce(p_blocked_reason, p_note)
      else null
    end
  where id = p_slot_id
  returning * into v_row;

  -- And take it away again immediately, so nothing later in this transaction
  -- inherits the right to move this slot.
  perform set_config('aa.advancing_slot', '', true);

  insert into slot_events (
    slot_id, from_stage, to_stage, actor, actor_id, agent_key, job_id, note, cost_usd
  ) values (
    p_slot_id, v_from, p_to_stage, p_actor, auth.uid(), p_agent_key, p_job_id, p_note, p_cost_usd
  );

  return v_row;
end;
$$;

comment on function public.advance_slot is
  'Move a slot to its next stage. The only thing that may write content_slots.stage. Refuses a move that is not in slot_transitions, and records every accepted one in slot_events.';

-- Creating a slot. Separate from advancing one: a slot is born at planned and
-- advance_slot has nothing to move it from.
create or replace function public.create_content_slot(
  p_client_id uuid,
  p_platform post_platform,
  p_scheduled_at timestamptz,
  p_pillar_id uuid default null,
  p_format content_format default 'single'
)
returns content_slots
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_row content_slots;
begin
  insert into content_slots (client_id, platform, scheduled_at, pillar_id, format)
  values (p_client_id, p_platform, p_scheduled_at, p_pillar_id, p_format)
  on conflict (client_id, platform, scheduled_at) do nothing
  returning * into v_row;

  -- Already planned for that window. The planner running twice is normal, so
  -- this is not an error; it returns what is there.
  if v_row.id is null then
    select * into v_row from content_slots
    where client_id = p_client_id and platform = p_platform and scheduled_at = p_scheduled_at;
    return v_row;
  end if;

  insert into slot_events (slot_id, from_stage, to_stage, actor, note)
  values (v_row.id, null, 'planned', 'engine', 'Planned.');
  return v_row;
end;
$$;

comment on function public.create_content_slot is
  'Plan one slot. Idempotent on (client, platform, instant), so a planner that runs twice does not make the post twice.';

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

alter table content_slots enable row level security;
alter table slot_events enable row level security;
alter table slot_transitions enable row level security;

-- Read for anyone who can see the client; writes go through the two functions
-- above. The admin policy is deliberately read-only as well: the stage guard
-- would refuse an admin's direct update anyway, and a policy that appears to
-- permit a write the trigger then rejects is a confusing way to say no.
drop policy if exists cs_scoped_read on content_slots;
create policy cs_scoped_read on content_slots
  for select to authenticated using (can_access_client(client_id));

drop policy if exists se_scoped_read on slot_events;
create policy se_scoped_read on slot_events
  for select to authenticated using (
    exists (select 1 from content_slots s where s.id = slot_id and can_access_client(s.client_id))
  );

-- The rules themselves are not client data.
drop policy if exists st_read on slot_transitions;
create policy st_read on slot_transitions for select to authenticated using (true);

grant select on content_slots, slot_events, slot_transitions to authenticated;

revoke all on function public.advance_slot(
  uuid, slot_stage, text, text, text, uuid, numeric, uuid, uuid, uuid, uuid, text) from public;
revoke all on function public.create_content_slot(uuid, post_platform, timestamptz, uuid, content_format) from public;
grant execute on function public.advance_slot(
  uuid, slot_stage, text, text, text, uuid, numeric, uuid, uuid, uuid, uuid, text) to authenticated;
grant execute on function public.create_content_slot(uuid, post_platform, timestamptz, uuid, content_format) to authenticated;

-- ---------------------------------------------------------------------------
-- The timeline
-- ---------------------------------------------------------------------------

-- security_invoker, like every other view in this schema bar two. Without it
-- a view runs as its owner and reads straight past the RLS on the tables
-- underneath, so slot_events would be readable for every client by anyone
-- signed in. The test below this caught exactly that.
create or replace view slot_timeline with (security_invoker = true) as
select
  e.slot_id,
  s.client_id,
  e.id as event_id,
  e.from_stage,
  e.to_stage,
  e.actor,
  e.agent_key,
  e.note,
  e.cost_usd,
  e.created_at,
  -- How long the slot sat in the stage it just left.
  e.created_at - lag(e.created_at) over (partition by e.slot_id order by e.created_at) as spent_in_previous
from slot_events e
join content_slots s on s.id = e.slot_id;

comment on view slot_timeline is
  'Every slot''s history, with how long each stage took. What the slot detail screen renders.';

grant select on slot_timeline to authenticated;

-- One line per slot for the board: where it is, how long it has been there,
-- and what it has cost so far.
create or replace view slot_board with (security_invoker = true) as
select
  s.id as slot_id,
  s.client_id,
  s.platform,
  s.scheduled_at,
  s.stage,
  s.format,
  p.name as pillar_name,
  s.attempts,
  s.cost_usd,
  s.blocked_reason,
  a.title as asset_title,
  (select max(e.created_at) from slot_events e where e.slot_id = s.id) as entered_stage_at,
  now() - (select max(e.created_at) from slot_events e where e.slot_id = s.id) as in_stage_for,
  s.stage in ('published', 'rejected') as settled
from content_slots s
left join client_content_pillars p on p.id = s.pillar_id
left join client_media_assets a on a.id = s.asset_id;

comment on view slot_board is
  'One line per slot: where it is, how long it has been there, what it has cost. settled marks the ones nothing further happens to.';

grant select on slot_board to authenticated;

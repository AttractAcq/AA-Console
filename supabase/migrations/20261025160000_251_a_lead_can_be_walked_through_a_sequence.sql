-- G11: moving one person along, rather than broadcasting at everybody.
--
-- The engine schedules content slots: it decides what the client posts and
-- when. Nothing decides what happens to a particular lead. So somebody who
-- identified themselves, did not buy, and went quiet is reachable only by a
-- new campaign aimed at everybody — which is how a warm lead becomes a cold
-- one while the account reports healthy numbers.
--
-- 249 made it possible to send one approved message to one consenting
-- person. This decides which message, to whom, and when.
--
-- WHAT IS APPROVED, AGAIN
--
-- Each step's words are a template version with its own standing approval
-- from 249. What a sequence adds is shape: the order and the waiting. Those
-- are approved too, as a whole, and the guard refuses to approve a sequence
-- whose steps are not themselves approved — otherwise approving the shape
-- would quietly authorise unapproved words.
--
-- Re-approval is required when the shape changes. Adding a step to an
-- approved sequence drops the approval, for the same reason changing a word
-- drops a template's.
--
-- EXITS ARE CHECKED BEFORE EVERY STEP, NOT ONLY AT ENROLMENT
--
-- The expensive failure here is specific and worth naming: a lead books a
-- call on Tuesday and receives "still thinking it over?" on Wednesday,
-- because the sequence was decided on Monday. So the exit condition is
-- evaluated immediately before each step is queued, and a lead who has moved
-- on is exited rather than skipped — skipping would leave them enrolled and
-- exposed to the step after.
--
-- Three exits are unconditional and not configurable: suppression, consent
-- being withdrawn, and the lead being deleted. The rest are the stages a
-- sequence declares it is no longer relevant for.
--
-- WHY THE STEP DELAY IS HOURS AND THE SWEEP IS SLOW
--
-- Hours rather than minutes because nothing here is urgent, and a minute-
-- resolution schedule invites someone to build a drip that feels automated.
-- The sweep runs every fifteen minutes, so a step lands within fifteen
-- minutes of its hour, which is closer than a person would manage anyway.

-- ---------------------------------------------------------------------------
-- The sequence
-- ---------------------------------------------------------------------------

create table if not exists public.nurture_sequences (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 200),
  purpose text not null check (purpose in
    ('magnet_follow_up', 'objection', 'reengagement', 'booking')),
  campaign_id uuid references public.client_campaigns(id) on delete set null,

  -- Who this is for. A lead at this stage, who has been there at least this
  -- long, is enrolled by the sweep.
  trigger_stage lead_stage not null,
  trigger_after_hours integer not null default 24 check (trigger_after_hours between 0 and 8760),

  -- The stages at which this sequence stops being relevant. Defaulted to the
  -- ones that mean the person has moved on; a reengagement sequence will want
  -- to override it, which is why it is a column and not a constant.
  exit_stages lead_stage[] not null default
    array['appointment','qualified_appointment','shown','sale','cash']::lead_stage[],

  -- Enrolment happens only while this is on; steps for leads already
  -- enrolled continue, because stopping mid-sequence would leave somebody
  -- halfway through a conversation.
  enrolled_automatically boolean not null default false,

  approved_at timestamptz,
  approved_by uuid references public.profiles(id),
  archived_at timestamptz,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, client_id)
);

comment on table public.nurture_sequences is
  'An ordered set of approved messages with waits between them, and the stages at which it stops being relevant. The shape is approved as a whole; each step''s words carry their own approval from 249.';

comment on column public.nurture_sequences.exit_stages is
  'Where this sequence becomes wrong. Checked before every step, not only at enrolment, because the lead who books on Tuesday must not be asked on Wednesday whether they are still thinking.';

create table if not exists public.nurture_sequence_steps (
  id uuid primary key default gen_random_uuid(),
  sequence_id uuid not null references public.nurture_sequences(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  position integer not null check (position >= 1),
  -- Hours after the previous step, or after enrolment for the first.
  delay_hours integer not null check (delay_hours between 0 and 8760),
  template_version_id uuid not null
    references public.message_template_versions(id) on delete restrict,
  created_at timestamptz not null default now(),
  unique (sequence_id, position)
);

comment on table public.nurture_sequence_steps is
  'One message in a sequence, and how long after the previous one it goes. The template version is the approved artifact; this row is only the timing and the order.';

-- Changing the shape of an approved sequence drops its approval, the same
-- way changing a word drops a template version's.
create or replace function public.guard_sequence_shape_change()
returns trigger language plpgsql
set search_path = pg_catalog, public as $$
declare v_sequence uuid;
begin
  v_sequence := coalesce(new.sequence_id, old.sequence_id);
  update public.nurture_sequences
     set approved_at = null, approved_by = null
   where id = v_sequence and approved_at is not null;
  return coalesce(new, old);
end $$;

drop trigger if exists guard_sequence_shape_change on public.nurture_sequence_steps;
create trigger guard_sequence_shape_change
  after insert or update or delete on public.nurture_sequence_steps
  for each row execute function public.guard_sequence_shape_change();

-- ---------------------------------------------------------------------------
-- Enrolment
-- ---------------------------------------------------------------------------

create table if not exists public.lead_sequence_enrollments (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  lead_id uuid not null references public.client_leads(id) on delete cascade,
  sequence_id uuid not null references public.nurture_sequences(id) on delete cascade,

  status text not null default 'active' check (status in ('active', 'completed', 'exited')),
  -- The step last sent. Null means nothing has gone yet.
  last_step integer,
  last_sent_at timestamptz,
  -- When the next step may go. Computed from the step's delay, so a sweep
  -- can find what is due with an index rather than a calculation.
  next_due_at timestamptz,

  exit_reason text,
  exited_at timestamptz,
  enrolled_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- One enrolment per lead per sequence, ever. Re-running a sequence at
  -- somebody is a decision, not an accident of a sweep.
  unique (lead_id, sequence_id)
);

comment on table public.lead_sequence_enrollments is
  'One lead walking one sequence. Unique per lead and sequence for all time: re-sending a whole sequence to the same person is a deliberate act, never something a sweep can do twice.';

create index if not exists lead_sequence_enrollments_due_idx
  on public.lead_sequence_enrollments (status, next_due_at)
  where status = 'active';
create index if not exists lead_sequence_enrollments_client_idx
  on public.lead_sequence_enrollments (client_id, created_at desc);

alter table public.nurture_sequences enable row level security;
alter table public.nurture_sequence_steps enable row level security;
alter table public.lead_sequence_enrollments enable row level security;
drop policy if exists nurture_sequences_read on public.nurture_sequences;
create policy nurture_sequences_read on public.nurture_sequences
  for select to authenticated using (public.can_access_client(client_id));
drop policy if exists nurture_sequence_steps_read on public.nurture_sequence_steps;
create policy nurture_sequence_steps_read on public.nurture_sequence_steps
  for select to authenticated using (public.can_access_client(client_id));
drop policy if exists lead_sequence_enrollments_read on public.lead_sequence_enrollments;
create policy lead_sequence_enrollments_read on public.lead_sequence_enrollments
  for select to authenticated using (public.can_access_client(client_id));
grant select on public.nurture_sequences, public.nurture_sequence_steps,
  public.lead_sequence_enrollments to authenticated;
grant all on public.nurture_sequences, public.nurture_sequence_steps,
  public.lead_sequence_enrollments to service_role;

drop trigger if exists nurture_sequences_updated_at on public.nurture_sequences;
create trigger nurture_sequences_updated_at before update on public.nurture_sequences
  for each row execute function public.set_updated_at();
drop trigger if exists lead_sequence_enrollments_updated_at on public.lead_sequence_enrollments;
create trigger lead_sequence_enrollments_updated_at before update
  on public.lead_sequence_enrollments
  for each row execute function public.set_updated_at();

select lock_down_definer_functions();

-- How many frames, and what each one does.
--
-- A carousel brief today says "carousel" and stops. Everything after that —
-- how many frames, what each is for, what order they make an argument in —
-- is decided by the model at concept time, from the body text. That is the
-- one part of a carousel a person actually has an opinion about, and there
-- was nowhere to write it down.
--
-- Two columns rather than one, because they answer different asks. "Give me
-- five" is the common one and nobody wants to write five lines to say it.
-- "Frame 3 is the objection, frame 4 is the proof" is the rarer one, and it
-- is the only way to get a sequence that argues in a particular order.
--
-- Both are nullable and null means the same thing in each: the agent
-- decides, exactly as it does now. Nothing on file changes behaviour.
--
-- Where both are given they must agree. A count of 5 beside a four-line
-- plan is two instructions, and whichever one the prompt happened to read
-- would win silently.

-- A plan entry that is blank is a frame with no brief, which is worse than
-- no plan at all: it tells the model there are N frames and says nothing
-- about one of them. Checked with a function because a check constraint
-- cannot run a subquery over the array.
create or replace function frame_plan_is_usable(p_plan text[])
returns boolean
language sql
immutable
set search_path = public
as $$
  select p_plan is null
      or (cardinality(p_plan) >= 2
          and cardinality(p_plan) <= 10
          and not exists (
            select 1 from unnest(p_plan) as line
             where btrim(coalesce(line, '')) = ''
          ));
$$;

comment on function frame_plan_is_usable(text[]) is
  'Whether a frame plan can be briefed from: between 2 and 10 entries, none of them blank. Null is usable and means the agent decides.';

alter table client_briefs
  add column frame_count integer,
  add column frame_plan  text[];

alter table client_briefs
  add constraint client_briefs_frame_count_range
  check (frame_count is null or (frame_count between 2 and 10));

alter table client_briefs
  add constraint client_briefs_frame_plan_usable
  check (frame_plan_is_usable(frame_plan));

-- A single has no frames to count or to plan. Setting either on one is the
-- same contradiction as a carousel with no frames, caught at the other end
-- by cma_frames_match_format.
alter table client_briefs
  add constraint client_briefs_frames_need_a_framed_format
  check (
    content_format <> 'single'
    or (frame_count is null and frame_plan is null)
  );

alter table client_briefs
  add constraint client_briefs_frame_count_matches_plan
  check (
    frame_count is null
    or frame_plan is null
    or cardinality(frame_plan) = frame_count
  );

comment on column client_briefs.frame_count is
  'How many frames this brief asks for. Null lets the agent choose. Where a frame_plan is also given the two must agree.';
comment on column client_briefs.frame_plan is
  'An ordered outline, one line per frame, saying what each frame is for. Null lets the agent choose. Its length is the frame count when both are set.';

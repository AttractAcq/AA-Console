-- QA: the last gate before a person sees it.
--
-- M3.9, and the last link in the chain. A slot reaching 'qa' has an asset
-- and copy; this decides whether it is fit to put in front of someone, and
-- sends it back to be remade if it is not.
--
-- The score and the findings live on the slot rather than in a side table
-- because the approval card reads them next to everything else about that
-- slot, and a join to show "why was this flagged" is a join somebody will
-- forget. History is in slot_events, which already records every transition
-- with its note.
--
-- Two attempts, then stop. The build plan says regenerate "up to 2 times,
-- then marks the slot failed with findings", and content_slots.attempts
-- already counts a trip round the loop (migration 147). A third rebuild of
-- something that has failed QA twice is a third bill for the same answer.

-- QA checks aspect ratio and duration, and nothing stored those. Without
-- these columns the check could only ever be written and never fire, which
-- is the "built but inert" shape this project has had enough of. The reel
-- paths know both numbers at render time and now record them; anything they
-- do not fill stays null, and a null is "not known" rather than "wrong".
alter table client_media_assets
  add column if not exists width integer,
  add column if not exists height integer,
  add column if not exists duration_sec numeric(8, 2);

comment on column client_media_assets.width is
  'Pixel width of the finished asset, where the thing that made it knew. Null means not recorded, which QA treats as nothing to check rather than as a fault.';
comment on column client_media_assets.duration_sec is
  'Length of a video asset in seconds. Null for a still.';

alter table client_media_assets drop constraint if exists cma_dimensions;
alter table client_media_assets add constraint cma_dimensions
  check ((width is null or width > 0) and (height is null or height > 0)
         and (duration_sec is null or duration_sec > 0));

alter table content_slots
  add column if not exists qa_score integer,
  add column if not exists qa_findings jsonb not null default '[]'::jsonb,
  add column if not exists qa_checked_at timestamptz;

comment on column content_slots.qa_score is
  'Out of 100, from the last QA pass. Null means QA has not looked at it.';
comment on column content_slots.qa_findings is
  'What QA flagged, as [{area, severity, detail}]. Shown on the approval card so a person sees what the engine saw.';

alter table content_slots drop constraint if exists cs_qa_score;
alter table content_slots add constraint cs_qa_score
  check (qa_score is null or qa_score between 0 and 100);

-- ---------------------------------------------------------------------------
-- Recording a pass
-- ---------------------------------------------------------------------------

-- One call, so the score, the findings and the move happen together. A slot
-- that advanced to awaiting_approval without its findings written would show
-- a person a clean card for something QA had objected to.
create or replace function public.record_qa_result(
  p_slot_id uuid,
  p_score integer,
  p_findings jsonb,
  p_to_stage slot_stage,
  p_note text default null,
  p_job_id uuid default null
)
returns content_slots
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_slot content_slots;
  v_settings client_engine_settings;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'QA results are written by the engine.' using errcode = 'P0001';
  end if;

  select * into v_slot from content_slots where id = p_slot_id for update;
  if not found then
    raise exception 'No such slot: %.', p_slot_id using errcode = 'P0001';
  end if;

  select * into v_settings from client_engine_settings where client_id = v_slot.client_id;

  -- The threshold is the client's, and it is not QA's to ignore. A slot
  -- cannot reach a person below it: that is the whole promise of this stage,
  -- and checking it here rather than only in the agent means a future caller
  -- cannot route around it.
  if p_to_stage = 'awaiting_approval'
     and p_score < coalesce(v_settings.min_qa_score, 70) then
    raise exception 'A slot scoring % cannot go for approval: this client requires %.',
      p_score, coalesce(v_settings.min_qa_score, 70) using errcode = 'P0001';
  end if;

  update content_slots
     set qa_score = p_score,
         qa_findings = coalesce(p_findings, '[]'::jsonb),
         qa_checked_at = now()
   where id = p_slot_id;

  perform advance_slot(p_slot_id, p_to_stage, 'agent', p_note, 'qa', p_job_id);

  select * into v_slot from content_slots where id = p_slot_id;
  return v_slot;
end;
$$;

comment on function public.record_qa_result is
  'Write a QA score and findings and move the slot in one act. Refuses to send a slot for approval below the client''s threshold.';

revoke all on function public.record_qa_result(uuid, integer, jsonb, slot_stage, text, uuid) from public;
grant execute on function public.record_qa_result(uuid, integer, jsonb, slot_stage, text, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- The agent
-- ---------------------------------------------------------------------------

insert into agents (agent_key, name, initials, domain, description, requires_upstream, requires_input)
values (
  'qa', 'Quality Check', 'QC', 'content',
  'Checks a slot''s asset and copy against the brand, its claims, the platform''s rules and plain risk, and sends it back to be remade if it is not fit to show a person.',
  array[]::text[], true)
on conflict (agent_key) do nothing;

insert into slot_pipeline (stage, format, agent_key, enter_stage, note, input_table, input_column)
values ('qa', null, 'qa', null, 'Check it before a person sees it.', null, null)
on conflict (stage, format) do nothing;

-- ---------------------------------------------------------------------------
-- What a person is asked to approve
-- ---------------------------------------------------------------------------

create or replace view approval_queue_slots with (security_invoker = true) as
select
  s.id as slot_id,
  s.client_id,
  c.name as client_name,
  s.platform,
  s.format,
  s.scheduled_at,
  s.qa_score,
  s.qa_findings,
  jsonb_array_length(s.qa_findings) as finding_count,
  (select count(*) from jsonb_array_elements(s.qa_findings) f
    where f->>'severity' = 'warning')::integer as warnings,
  s.attempts,
  s.cost_usd,
  a.id as asset_id,
  a.title as asset_title,
  a.human_approved_at,
  p.name as pillar_name,
  d.score as idea_score,
  d.reasons as idea_reasons
from content_slots s
left join clients c on c.id = s.client_id
left join client_media_assets a on a.id = s.asset_id
left join client_content_pillars p on p.id = s.pillar_id
left join lateral (
  select e.score, e.reasons from engine_decisions e
   where e.slot_id = s.id and e.kind = 'idea_selected'
   order by e.decided_at desc limit 1
) d on true
where s.stage = 'awaiting_approval';

comment on view approval_queue_slots is
  'Everything waiting on a person, with what QA found and why the engine chose this idea. The approval card reads this.';

grant select on approval_queue_slots to authenticated;

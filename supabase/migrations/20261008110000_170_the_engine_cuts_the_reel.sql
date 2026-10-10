-- The engine cuts the reel, and QA refuses one that was not cut.
--
-- 169 added the stage. This is what uses it.

-- ---------------------------------------------------------------------------
-- The moves
-- ---------------------------------------------------------------------------

-- Deliberately no `editing -> building`. A reel whose clips were never
-- submitted needs video_build again, and routing it straight back would make
-- a loop that advance_slot's attempt counter does not count -- it increments
-- only for qa -> building/copywriting, planned <- failed and briefing <-
-- rejected. The existing way round is `failed -> planned`, which does count,
-- so an unbuildable reel stops instead of spinning.
insert into slot_transitions (from_stage, to_stage, note) values
  ('building', 'editing',     'The clips are being made, or are made. The cut comes next.'),
  ('editing',  'copywriting', 'The reel is cut; now the words.'),
  ('editing',  'failed',      'The cut could not be made, or the clips never arrived.')
on conflict (from_stage, to_stage) do nothing;

-- ---------------------------------------------------------------------------
-- Who does the work
-- ---------------------------------------------------------------------------

-- video_edit takes the asset, not the brief: request_video_edit(p_asset_id)
-- has keyed on the reel's asset row since migration 141, and the EDL is
-- stored on that row.
insert into slot_pipeline (stage, format, agent_key, enter_stage, note, input_table, input_column)
values ('editing', 'reel', 'video_edit', null,
        'Cut the reel from its clips.', 'client_media_assets', 'asset_id')
on conflict (stage, format) do nothing;

-- ---------------------------------------------------------------------------
-- QA refuses an uncut reel
-- ---------------------------------------------------------------------------

-- A null dimension stays "not recorded" for every other format, which is what
-- 158 decided and is right: a still built by creative_build has no duration
-- and never will. For a reel it is different, because a reel with no
-- render_path has not been cut, and that is a fault rather than an absence.
--
-- Enforced here as well as in the agent, for the same reason the threshold is:
-- a future caller must not be able to route around it.
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
  v_render text;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'QA results are written by the engine.' using errcode = 'P0001';
  end if;

  select * into v_slot from content_slots where id = p_slot_id for update;
  if not found then
    raise exception 'No such slot: %.', p_slot_id using errcode = 'P0001';
  end if;

  select * into v_settings from client_engine_settings where client_id = v_slot.client_id;

  if p_to_stage = 'awaiting_approval'
     and p_score < coalesce(v_settings.min_qa_score, 70) then
    raise exception 'A slot scoring % cannot go for approval: this client requires %.',
      p_score, coalesce(v_settings.min_qa_score, 70) using errcode = 'P0001';
  end if;

  -- The new refusal. A reel reaching a person must have a cut.
  if p_to_stage = 'awaiting_approval' and v_slot.format = 'reel' then
    select a.render_path into v_render
      from client_media_assets a where a.id = v_slot.asset_id;
    if coalesce(btrim(v_render), '') = '' then
      raise exception
        'That reel has no cut. It has clips but nothing assembled, so there is no video to approve.'
        using errcode = 'P0001';
    end if;
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
  'Write a QA score and findings and move the slot in one act. Refuses to send a slot for approval below the client''s threshold, or a reel with no render_path -- clips are not a cut.';

revoke all on function public.record_qa_result(uuid, integer, jsonb, slot_stage, text, uuid) from public, anon;
grant execute on function public.record_qa_result(uuid, integer, jsonb, slot_stage, text, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- The slot board should name the new stage
-- ---------------------------------------------------------------------------

-- content_slots_in_flight_idx counts the stages where work is under way, for
-- the per-client cap in 150. A reel waiting in editing is work in flight.
drop index if exists content_slots_in_flight_idx;
create index content_slots_in_flight_idx on content_slots (client_id)
  where stage in ('ideating', 'briefing', 'building', 'editing', 'copywriting', 'qa');

select public.lock_down_definer_functions();

-- Rebuilding one frame instead of the whole set.
--
-- regenerate_asset rebuilds everything from the brief. For a single image
-- that is the only thing it could mean. For a five-frame carousel where
-- frame three is wrong, it is four images you already had, paid for again,
-- and four frames you were happy with coming back different.
--
-- WHY THIS MAKES A NEW ASSET RATHER THAN EDITING THE FRAME IN PLACE
--
-- The same reason regenerate_asset does. An approved carousel may already
-- be scheduled; replacing a frame underneath it changes what goes out
-- without anything being approved, and cma_decision_recorded exists
-- precisely so nothing is decided without a record. Editing in place would
-- route around it at the frame level.
--
-- So the new asset copies the frames that were fine and re-renders only the
-- named one. The cost is one image call; the approval is a fresh decision
-- on the whole set, which is what a person actually approves.
--
-- The source asset is left alone, exactly as regenerate_asset leaves it.

create or replace function regenerate_frame(
  p_asset_id uuid,
  p_position integer,
  p_feedback text
)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_asset     record;
  v_brief     record;
  v_prev      record;
  v_feedback  text;
  v_frames    integer;
  v_gen_id    uuid;
  v_render_id uuid;
  v_job_id    uuid;
begin
  if not is_admin() then
    raise exception 'Only an admin can regenerate a frame.';
  end if;

  select id, client_id, brief_id, media_type, content_format
    into v_asset
    from client_media_assets where id = p_asset_id;
  if v_asset.id is null then
    raise exception 'That asset does not exist.';
  end if;
  if v_asset.content_format = 'single' then
    raise exception 'That asset has no frames. Use Regenerate to build it again.';
  end if;
  if v_asset.brief_id is null then
    raise exception 'That asset has no brief, so there is nothing to build it from again.';
  end if;
  if v_asset.media_type = 'video' then
    raise exception 'Video is produced by people. Send the brief to an editor or avatar instead.';
  end if;

  select count(*)::integer into v_frames
    from client_media_frames where asset_id = p_asset_id;
  if not exists (
    select 1 from client_media_frames where asset_id = p_asset_id and position = p_position
  ) then
    raise exception 'This set has % frames; there is no frame %.', v_frames, p_position;
  end if;

  -- The same refusal regenerate_asset makes, for the same reason: the same
  -- brief and no account of what was wrong produces the same frame and
  -- charges for it. No fallback to a recorded rejection here — a rejection
  -- is recorded against the asset, and it does not say which frame it meant.
  v_feedback := nullif(btrim(coalesce(p_feedback, '')), '');
  if v_feedback is null then
    raise exception 'Say what is wrong with frame %. Building it again from the same brief with nothing changed produces the same frame.', p_position;
  end if;

  select id, media_type into v_brief from client_briefs where id = v_asset.brief_id;
  if v_brief.id is null then
    raise exception 'That brief no longer exists.';
  end if;

  select quality, size, reference_path, concept into v_prev
    from creative_generations
   where brief_id = v_asset.brief_id
   order by created_at desc
   limit 1;

  insert into creative_generations
    (client_id, brief_id, media_type, quality, size, reference_path, remake_feedback,
     concept, created_by)
  values (v_asset.client_id, v_brief.id, v_brief.media_type,
          coalesce(v_prev.quality, 'medium'), coalesce(v_prev.size, '1024x1536'),
          v_prev.reference_path, v_feedback,
          -- The set's existing concept rides along so the replacement frame
          -- is written against the frames it has to sit between, not from
          -- the brief alone.
          v_prev.concept, auth.uid())
  returning id into v_gen_id;

  insert into creative_renders (generation_id, client_id, quality, size, reference_path, created_by)
  values (v_gen_id, v_asset.client_id, coalesce(v_prev.quality, 'medium'),
          coalesce(v_prev.size, '1024x1536'), v_prev.reference_path, auth.uid())
  returning id into v_render_id;

  insert into agent_jobs (agent_key, client_id, params, created_by)
  values ('creative_build', v_asset.client_id,
          jsonb_build_object(
            'render_id', v_render_id,
            'source_asset_id', p_asset_id,
            'frame_position', p_position
          ), auth.uid())
  returning id into v_job_id;

  update creative_generations set job_id = v_job_id where id = v_gen_id;
  update creative_renders set job_id = v_job_id where id = v_render_id;
  -- Same as regenerate_asset: a brief with a build running is in production,
  -- not complete, whatever it said a moment ago.
  update client_briefs set status = 'in_production' where id = v_brief.id;

  insert into agent_job_events (job_id, description)
  values (v_job_id, format('Queued a rebuild of frame %s of %s', p_position, v_frames));

  return v_gen_id;
end;
$$;

revoke all on function regenerate_frame(uuid, integer, text) from public, anon;
grant execute on function regenerate_frame(uuid, integer, text) to authenticated;

comment on function regenerate_frame(uuid, integer, text) is
  'Admin-only. Rebuilds one frame of a carousel or story with an account of what was wrong, and files the result as a new asset carrying the other frames unchanged. The source asset is untouched: an approved set already scheduled is never edited underneath, which is the same rule regenerate_asset follows.';

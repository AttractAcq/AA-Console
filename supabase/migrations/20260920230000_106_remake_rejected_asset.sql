-- A rejection that goes somewhere.
--
-- review_media_asset records the reason and stops. Nothing consumes it: one
-- rejection exists in production, fourteen days old, and nothing was remade
-- from it. The maker is told what was wrong and the system forgets.
--
-- This turns the reason into the input for the next attempt. The build that
-- follows is handed what was wrong with the last one, so the concept agent
-- is arguing against a specific failure rather than writing blind into the
-- same brief and producing the same thing.
--
-- Human-triggered, never automatic. A remake spends money on a model call,
-- and a rejection that silently re-queues is a rejection that can loop.

alter table creative_generations
  add column remake_feedback text;

comment on column creative_generations.remake_feedback is
  'Why the previous attempt was rejected, carried into this build so the concept is written against a named failure. Null on a first build.';

-- Mirrors build_brief_with_ai, which is where the live definition was read
-- from rather than the migration that first created it: that one enqueued
-- generation_id, and the runtime has read params.render_id since migration
-- 93. Copying the file would have queued a job the worker cannot start.
create or replace function remake_rejected_asset(
  p_asset_id uuid,
  p_quality  text default null,
  p_size     text default null
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
  v_reason    text;
  v_quality   text;
  v_size      text;
  v_gen_id    uuid;
  v_render_id uuid;
  v_job_id    uuid;
begin
  if not is_admin() then
    raise exception 'Only an admin can remake an asset.';
  end if;

  select id, client_id, brief_id, media_type, review_status
    into v_asset
    from client_media_assets where id = p_asset_id;
  if v_asset.id is null then
    raise exception 'That asset does not exist.';
  end if;
  -- Remaking something nobody rejected would quietly duplicate it.
  if v_asset.review_status <> 'rejected' then
    raise exception 'Only a rejected asset can be remade. This one is %.', v_asset.review_status;
  end if;
  if v_asset.brief_id is null then
    raise exception 'That asset has no brief, so there is nothing to build it from again.';
  end if;
  if v_asset.media_type = 'video' then
    raise exception 'Video is produced by people. Send the brief to an editor or avatar instead.';
  end if;

  select id, client_id, media_type into v_brief
    from client_briefs where id = v_asset.brief_id;
  if v_brief.id is null then
    raise exception 'That brief no longer exists.';
  end if;

  -- The reason the last attempt was rejected. This is the whole point.
  select reason into v_reason
    from client_asset_reviews
   where asset_id = p_asset_id and decision = 'rejected'
   order by created_at desc
   limit 1;
  if v_reason is null or btrim(v_reason) = '' then
    raise exception 'That rejection has no reason recorded, so a remake has nothing to work from.';
  end if;

  -- Settings from the attempt being replaced, so a remake matches what was
  -- asked for rather than resetting to defaults nobody chose.
  select quality, size, reference_path into v_prev
    from creative_generations
   where brief_id = v_asset.brief_id
   order by created_at desc
   limit 1;

  v_quality := coalesce(p_quality, v_prev.quality, 'medium');
  v_size    := coalesce(p_size, v_prev.size, '1024x1536');
  if v_quality not in ('low','medium','high') then
    raise exception 'Quality must be low, medium or high.';
  end if;
  if v_size not in ('1024x1536','1024x1024','1536x1024') then
    raise exception 'Unsupported image size: %', v_size;
  end if;

  insert into creative_generations
    (client_id, brief_id, media_type, quality, size, reference_path, remake_feedback, created_by)
  values (v_brief.client_id, v_brief.id, v_brief.media_type, v_quality, v_size,
          v_prev.reference_path, btrim(v_reason), auth.uid())
  returning id into v_gen_id;

  insert into creative_renders (generation_id, client_id, quality, size, reference_path, created_by)
  values (v_gen_id, v_brief.client_id, v_quality, v_size, v_prev.reference_path, auth.uid())
  returning id into v_render_id;

  insert into agent_jobs (agent_key, client_id, params, created_by)
  values ('creative_build', v_brief.client_id,
          jsonb_build_object('render_id', v_render_id), auth.uid())
  returning id into v_job_id;

  update creative_generations set job_id = v_job_id where id = v_gen_id;
  update creative_renders set job_id = v_job_id where id = v_render_id;
  update client_briefs set status = 'in_production' where id = v_brief.id;

  insert into agent_job_events (job_id, description)
  values (v_job_id, 'Queued as a remake after rejection');

  return v_gen_id;
end;
$$;

revoke all on function remake_rejected_asset(uuid, text, text) from public, anon;
grant execute on function remake_rejected_asset(uuid, text, text) to authenticated;

comment on function remake_rejected_asset(uuid, text, text) is
  'Admin-only. Builds a brief again with the rejection reason carried into the concept. Refuses an asset nobody rejected, and one whose rejection has no reason to work from.';

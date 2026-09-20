-- Regenerate any asset, not only a rejected one.
--
-- remake_rejected_asset shipped yesterday for the narrower case: it read the
-- reason off the last rejection. But an asset you are unhappy with is not
-- necessarily one you rejected — most of the time you are looking at a
-- finished image, it is nearly right, and you want it built again with one
-- thing changed.
--
-- So the feedback becomes an argument rather than something looked up, and
-- the function works whatever state the asset is in. The rejection path
-- still works without passing anything: where an asset was rejected and no
-- feedback is given, the recorded reason is used.
--
-- What does NOT change is the refusal to run with nothing to work from. A
-- rebuild handed the same brief and no account of what was wrong produces
-- the same asset and charges for it. That was the point of the original
-- guard and it survives here.
--
-- remake_rejected_asset is dropped rather than kept as a wrapper. It landed
-- today, the console is its only caller, and that caller moves in the same
-- change — a wrapper would be inventing a compatibility obligation nobody
-- has.

drop function if exists remake_rejected_asset(uuid, text, text);

create or replace function regenerate_asset(
  p_asset_id uuid,
  p_feedback text default null,
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
  v_feedback  text;
  v_quality   text;
  v_size      text;
  v_gen_id    uuid;
  v_render_id uuid;
  v_job_id    uuid;
begin
  if not is_admin() then
    raise exception 'Only an admin can regenerate an asset.';
  end if;

  select id, client_id, brief_id, media_type, review_status
    into v_asset
    from client_media_assets where id = p_asset_id;
  if v_asset.id is null then
    raise exception 'That asset does not exist.';
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

  v_feedback := nullif(btrim(coalesce(p_feedback, '')), '');
  -- Nothing passed, but the asset was rejected: the reason on file is the
  -- feedback, and asking for it again would be asking twice.
  if v_feedback is null and v_asset.review_status = 'rejected' then
    select nullif(btrim(coalesce(reason, '')), '') into v_feedback
      from client_asset_reviews
     where asset_id = p_asset_id and decision = 'rejected'
     order by created_at desc
     limit 1;
  end if;
  if v_feedback is null then
    raise exception 'Say what is wrong with it. Building the same brief again with nothing changed produces the same asset and costs the same.';
  end if;

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
          v_prev.reference_path, v_feedback, auth.uid())
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
  values (v_job_id, 'Queued a regeneration with feedback');

  return v_gen_id;
end;
$$;

revoke all on function regenerate_asset(uuid, text, text, text) from public, anon;
grant execute on function regenerate_asset(uuid, text, text, text) to authenticated;

comment on function regenerate_asset(uuid, text, text, text) is
  'Admin-only. Builds a brief again with an account of what was wrong, carried into the concept. The original asset is left alone: a regeneration produces a new asset that goes through approval on its own, so an approved asset already scheduled is never replaced underneath.';

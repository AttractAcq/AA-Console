-- Keep the destination selected at ideation on the generated brief. Existing
-- work has no known destination, so null is intentional.
alter table client_ideas add column target_platform post_platform;
alter table client_briefs add column target_platform post_platform;

create or replace function enqueue_format_ideation(
  p_client_id uuid,
  p_target_platform post_platform,
  p_media_type media_type,
  p_content_format content_format
)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_formats text[];
begin
  if p_client_id is null or not can_access_client(p_client_id) then
    raise exception 'Not permitted for this client';
  end if;
  if p_target_platform is null or p_media_type is null or p_content_format is null then
    raise exception 'Choose a destination, media type and format';
  end if;
  v_formats := case p_target_platform
    when 'instagram' then array['single', 'carousel', 'story', 'reel']
    when 'facebook' then array['single', 'carousel', 'story', 'reel']
    when 'tiktok' then array['single', 'carousel', 'reel']
    when 'linkedin' then array['single', 'carousel']
    when 'youtube' then array['single', 'reel']
  end;
  if not p_content_format::text = any(v_formats)
     or not format_fits_media(p_content_format, p_media_type) then
    raise exception 'That media type and format are not supported for this destination';
  end if;
  return enqueue_agent_job_internal(
    'ideation', p_client_id, null, null, auth.uid(),
    jsonb_build_object('target_platform', p_target_platform, 'media_type', p_media_type,
      'content_format', p_content_format),
    'Queued: format-directed ideation'
  );
end;
$$;
revoke execute on function enqueue_format_ideation(uuid, post_platform, media_type, content_format) from public, anon;
grant execute on function enqueue_format_ideation(uuid, post_platform, media_type, content_format) to authenticated;

-- Lock the asset so a UI request and the automatic handoff cannot buy two cuts.
create or replace function request_video_edit(p_asset_id uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  a client_media_assets%rowtype;
  v_job uuid;
begin
  select * into a from client_media_assets where id = p_asset_id for update;
  if a.id is null then raise exception 'That asset no longer exists.'; end if;
  if not (auth.role() = 'service_role' or can_access_client(a.client_id)) then
    raise exception 'Not permitted for this client';
  end if;
  if a.media_type is distinct from 'video' or a.content_format is distinct from 'reel' then
    raise exception 'Only a reel is cut here.';
  end if;
  if a.render_path is not null then raise exception 'This reel already has a cut.'; end if;
  if not exists (select 1 from client_media_frames f where f.asset_id = a.id)
     or exists (select 1 from client_media_frames f where f.asset_id = a.id
                 and nullif(btrim(f.clip_path), '') is null) then
    raise exception 'Wait for every Higgsfield clip before requesting a cut.';
  end if;
  select j.id into v_job from agent_jobs j
   where j.agent_key = 'video_edit' and j.input_table = 'client_media_assets'
     and j.input_id = a.id and j.status in ('queued', 'claimed', 'running')
   order by j.created_at desc limit 1;
  if v_job is not null then return v_job; end if;
  return enqueue_agent_job_internal(
    'video_edit', a.client_id, 'client_media_assets', a.id, auth.uid(),
    '{}'::jsonb, 'Queued: cut the reel from its clips'
  );
end;
$$;
revoke execute on function request_video_edit(uuid) from public, anon;
grant execute on function request_video_edit(uuid) to authenticated, service_role;

-- The general review action must obey the same cut boundary as engine QA.
create or replace function review_media_asset(
  p_asset_id uuid, p_decision review_status, p_reason text default null
)
returns void language plpgsql security definer set search_path = public as $$
declare
  a client_media_assets%rowtype;
begin
  select * into a from client_media_assets where id = p_asset_id for update;
  if a.id is null then raise exception 'Asset not found'; end if;
  if not can_access_client(a.client_id) then raise exception 'Not permitted for this client'; end if;
  if p_decision = 'pending' then raise exception 'Decision must be approved or rejected'; end if;
  if p_decision = 'approved' and a.content_format = 'reel'
     and nullif(btrim(a.render_path), '') is null then
    raise exception 'Finish the reel cut before approving it';
  end if;
  update client_media_assets
     set review_status = p_decision,
         human_approved_at = case when p_decision = 'approved' then now() else null end
   where id = p_asset_id;
  insert into client_asset_reviews (asset_id, decision, reason, reviewed_by)
  values (p_asset_id, p_decision, p_reason, auth.uid());
end;
$$;
revoke execute on function review_media_asset(uuid, review_status, text) from public, anon;
grant execute on function review_media_asset(uuid, review_status, text) to authenticated;

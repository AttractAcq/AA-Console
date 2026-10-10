-- A new cut of the same footage supersedes an unfinalized AI cut. The old
-- version remains in storage for audit, but can no longer be approved.
alter table client_media_assets drop constraint if exists client_media_assets_edit_stage_check;
alter table client_media_assets add constraint client_media_assets_edit_stage_check
  check (edit_stage in ('needs_edit', 'editing', 'edited', 'review_ready', 'superseded'));

create or replace function request_source_video_edit(
  p_asset_id uuid, p_direction text, p_aspect text, p_remove_pauses boolean,
  p_captions boolean, p_animated_title boolean, p_brand_treatment text, p_feel text
) returns uuid language plpgsql security definer set search_path = public as $$
declare
  a client_media_assets%rowtype;
  v_previous video_source_edit_requests%rowtype;
  v_output client_media_assets%rowtype;
  v_request uuid;
  v_job uuid;
begin
  select * into a from client_media_assets where id = p_asset_id for update;
  if a.id is null or a.media_type <> 'video' or a.edit_stage not in ('needs_edit', 'edited')
      or a.brief_id is null or nullif(btrim(a.storage_path), '') is null then
    raise exception 'Choose source footage waiting for an edit or an unfinalized AI cut.';
  end if;
  if not is_admin() and auth.uid() is distinct from active_video_approval_manager(a.client_id) then
    raise exception 'Only an admin or the assigned SMM may request an AI edit.';
  end if;
  if length(btrim(coalesce(p_direction, ''))) < 10 or length(p_direction) > 4000 then
    raise exception 'Give the editor 10 to 4000 characters of direction.';
  end if;
  if p_aspect not in ('vertical', 'square', 'horizontal')
     or p_brand_treatment not in ('on_brand', 'off_brand')
     or p_feel not in ('calm', 'balanced', 'expressive')
     or p_remove_pauses is null or p_captions is null or p_animated_title is null then
    raise exception 'Choose valid edit controls.';
  end if;
  if exists (select 1 from video_source_edit_requests r where r.source_asset_id = a.id
      and r.status in ('queued', 'running')) then
    raise exception 'This footage already has an AI edit in progress.';
  end if;
  if a.edit_stage = 'edited' then
    select * into v_previous from video_source_edit_requests r
      where r.source_asset_id = a.id and r.status = 'completed'
      order by r.completed_at desc, r.created_at desc limit 1;
    select * into v_output from client_media_assets where id = v_previous.output_asset_id for update;
    if v_previous.id is null or v_output.id is null or v_output.edit_stage <> 'review_ready'
        or v_output.human_approved_at is not null or v_output.review_status = 'approved' then
      raise exception 'Only an unfinalized AI cut can be revised.';
    end if;
    update client_media_assets set edit_stage = 'superseded' where id = v_output.id;
  end if;
  insert into video_source_edit_requests(client_id, source_asset_id, direction, aspect,
    remove_pauses, captions, animated_title, brand_treatment, feel, created_by)
  values (a.client_id, a.id, btrim(p_direction), p_aspect, p_remove_pauses,
    p_captions, p_animated_title, p_brand_treatment, p_feel, auth.uid())
  returning id into v_request;
  v_job := enqueue_agent_job_internal('source_video_edit', a.client_id,
    'client_media_assets', a.id, auth.uid(), jsonb_build_object('request_id', v_request),
    'Queued: revise supplied video');
  update video_source_edit_requests set job_id = v_job where id = v_request;
  update client_media_assets set edit_stage = 'editing' where id = a.id;
  return v_request;
end;
$$;

create function fail_source_video_edit(p_request_id uuid, p_error text)
returns void language plpgsql security definer set search_path = public as $$
declare
  r video_source_edit_requests%rowtype;
  v_previous uuid;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Only the video edit worker can fail a source edit.';
  end if;
  select * into r from video_source_edit_requests where id = p_request_id for update;
  if r.id is null or r.status not in ('queued', 'running') then return; end if;
  select output_asset_id into v_previous from video_source_edit_requests
    where source_asset_id = r.source_asset_id and status = 'completed'
    order by completed_at desc, created_at desc limit 1;
  update video_source_edit_requests set status = 'failed', error = left(p_error, 1000)
    where id = r.id;
  if v_previous is not null then
    update client_media_assets set edit_stage = 'review_ready'
      where id = v_previous and edit_stage = 'superseded';
  end if;
  update client_media_assets set edit_stage = case when v_previous is null then 'needs_edit' else 'edited' end
    where id = r.source_asset_id and edit_stage = 'editing';
end;
$$;
revoke execute on function fail_source_video_edit(uuid, text) from public, anon, authenticated;
grant execute on function fail_source_video_edit(uuid, text) to service_role;

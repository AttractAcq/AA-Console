-- A human may deliver a finished cut. An admin or this client's assigned SMM
-- explicitly accepts it as the review candidate rather than forcing an edit.
create or replace function accept_video_as_finished(p_asset_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare a client_media_assets%rowtype;
begin
  select * into a from client_media_assets where id = p_asset_id for update;
  if a.id is null or a.media_type <> 'video' or a.edit_stage <> 'needs_edit'
     or a.source_asset_id is not null or a.member_id is null then
    raise exception 'Choose unassigned human video footage.';
  end if;
  if not is_admin() and auth.uid() is distinct from active_video_approval_manager(a.client_id) then
    raise exception 'Only an admin or the assigned SMM can accept the finished cut.';
  end if;
  update client_media_assets set edit_stage = 'review_ready',
    render_path = case when content_format = 'reel' then storage_path else render_path end
    where id = a.id;
end;
$$;
revoke execute on function accept_video_as_finished(uuid) from public, anon;
grant execute on function accept_video_as_finished(uuid) to authenticated;

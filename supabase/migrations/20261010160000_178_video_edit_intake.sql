-- Intake a supplied video into Edit / Repurpose. A standalone upload gets a
-- human brief so editor assignment, version lineage and review stay in the
-- same production chain as other work.
alter table client_media_assets
  add column intake_source text check (intake_source in ('client_supplied', 'agency_supplied')),
  add column usage_rights text check (usage_rights in ('client_owned', 'licensed', 'agency_owned')),
  add column intake_notes text;

create or replace function intake_video_for_edit(
  p_asset_id uuid,
  p_client_id uuid,
  p_title text,
  p_storage_path text,
  p_format content_format,
  p_source text,
  p_rights text,
  p_brief_id uuid default null,
  p_notes text default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_brief client_briefs%rowtype;
begin
  if not is_admin() and auth.uid() is distinct from active_video_approval_manager(p_client_id) then
    raise exception 'Only an admin or the assigned SMM can intake client video.';
  end if;
  if p_client_id is null or not exists (select 1 from clients where id = p_client_id) then
    raise exception 'Choose a client.';
  end if;
  if nullif(btrim(p_title), '') is null or length(p_title) > 200 then
    raise exception 'Give the video a title of up to 200 characters.';
  end if;
  if p_format not in ('single', 'story', 'reel') then
    raise exception 'Choose a supported video format.';
  end if;
  if p_source not in ('client_supplied', 'agency_supplied')
     or p_rights not in ('client_owned', 'licensed', 'agency_owned') then
    raise exception 'Record the source and cleared usage rights.';
  end if;
  if length(coalesce(p_notes, '')) > 4000 then
    raise exception 'Keep intake notes under 4000 characters.';
  end if;
  if p_storage_path not like p_client_id::text || '/' || p_asset_id::text || '.%'
     or not exists (select 1 from storage.objects where bucket_id = 'client-media'
       and name = p_storage_path) then
    raise exception 'Upload the source video into this client folder first.';
  end if;
  if p_brief_id is not null then
    select * into v_brief from client_briefs where id = p_brief_id;
    if v_brief.id is null or v_brief.client_id <> p_client_id or v_brief.media_type <> 'video'
       or v_brief.content_format <> p_format then
      raise exception 'Choose a video brief for this client and format.';
    end if;
  else
    insert into client_briefs(client_id, title, body, media_type, content_format,
      status, production_method, format_code, editor_brief)
    values (p_client_id, btrim(p_title), coalesce(nullif(btrim(p_notes), ''), 'Edit supplied video.'),
      'video', p_format, 'in_production', 'human',
      case when p_format = 'reel' then 'HUMAN' else null end,
      coalesce(nullif(btrim(p_notes), ''), 'Edit supplied video.'))
    returning * into v_brief;
  end if;
  insert into client_media_assets(id, client_id, brief_id, media_type, content_format,
    title, storage_path, uploaded_by, edit_stage, intake_source, usage_rights, intake_notes)
  values (p_asset_id, p_client_id, v_brief.id, 'video', p_format,
    btrim(p_title), p_storage_path, auth.uid(), 'needs_edit', p_source, p_rights,
    nullif(btrim(p_notes), ''));
  return jsonb_build_object('asset_id', p_asset_id, 'brief_id', v_brief.id);
end;
$$;
revoke execute on function intake_video_for_edit(uuid, uuid, text, text, content_format, text, text, uuid, text) from public, anon;
grant execute on function intake_video_for_edit(uuid, uuid, text, text, content_format, text, text, uuid, text) to authenticated;

create or replace function is_active_assigned_smm()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from client_assignments ca
    join team_members tm on tm.id = ca.member_id
    where ca.ended_at is null and tm.active and tm.category = 'smm'
      and tm.user_id = auth.uid());
$$;
revoke execute on function is_active_assigned_smm() from public, anon;
grant execute on function is_active_assigned_smm() to authenticated;

create policy team_members_editor_for_smm_read on team_members for select to authenticated
  using (category = 'editors' and active and is_active_assigned_smm());
create policy cma_smm_video_read on client_media_assets for select to authenticated
  using (media_type = 'video' and auth.uid() = active_video_approval_manager(client_id));
create policy job_assignments_smm_video_read on job_assignments for select to authenticated
  using (source_asset_id is not null and auth.uid() = active_video_approval_manager(client_id));
create policy brief_dispatches_smm_video_read on brief_dispatches for select to authenticated
  using (source_asset_id is not null and auth.uid() = active_video_approval_manager(client_id));
create policy media_obj_smm_video_read on storage.objects for select to authenticated
  using (bucket_id = 'client-media'
    and auth.uid() = active_video_approval_manager(try_uuid((storage.foldername(name))[1])));

-- If metadata registration fails, the assigned SMM may clean up only a file
-- they uploaded, in the client folder they still manage.
create policy media_obj_smm_own_delete on storage.objects for delete to authenticated
  using (bucket_id = 'client-media' and owner = auth.uid()
    and auth.uid() = active_video_approval_manager(try_uuid((storage.foldername(name))[1]))
    and name ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}[.](mp4|mov|m4v|webm)$'
    and not exists (select 1 from client_media_assets a where a.storage_path = name));

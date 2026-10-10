-- Avatar footage returns from Create to Edit / Repurpose. The original is
-- retained; an editor's delivery is a new, linked version for approval.
alter table client_media_assets
  add column edit_stage text not null default 'review_ready'
    check (edit_stage in ('needs_edit', 'editing', 'edited', 'review_ready')),
  add column source_asset_id uuid references client_media_assets(id) on delete set null;
alter table job_assignments
  add column source_asset_id uuid references client_media_assets(id) on delete set null;
alter table brief_dispatches
  add column source_asset_id uuid references client_media_assets(id) on delete set null;
alter table brief_dispatches drop constraint if exists brief_dispatches_brief_role_check;
alter table brief_dispatches add constraint brief_dispatches_brief_role_check
  check (brief_role in ('avatar', 'editor', 'full', 'edit'));

create index job_assignments_source_asset_idx on job_assignments(source_asset_id);
create index cma_edit_queue_idx on client_media_assets(client_id, edit_stage, created_at desc)
  where media_type = 'video';

create or replace function set_human_video_edit_stage()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_category team_category;
  v_source client_media_assets%rowtype;
begin
  if new.media_type <> 'video' or new.member_id is null then
    if new.source_asset_id is not null then
      raise exception 'Only a team member may deliver an edited video version.';
    end if;
    return new;
  end if;
  select category into v_category from team_members where id = new.member_id;
  if new.source_asset_id is null then
    if v_category = 'avatars' then new.edit_stage := 'needs_edit'; end if;
    return new;
  end if;
  select * into v_source from client_media_assets where id = new.source_asset_id;
  if v_source.id is null or v_source.client_id <> new.client_id or v_source.media_type <> 'video' then
    raise exception 'The source footage is missing or belongs to another client.';
  end if;
  if v_category <> 'editors' or v_source.edit_stage <> 'editing' or not exists (
    select 1 from job_assignments j where j.source_asset_id = v_source.id
      and j.member_id = new.member_id and j.stage in ('assigned', 'accepted', 'rework')
  ) then
    raise exception 'This editor has no active edit assignment for that footage.';
  end if;
  new.edit_stage := 'review_ready';
  if new.content_format = 'reel' then new.render_path := new.storage_path; end if;
  return new;
end;
$$;
create trigger cma_human_video_edit_stage before insert on client_media_assets
  for each row execute function set_human_video_edit_stage();

-- The editor receives a normal dashboard assignment and a best-effort Resend
-- notification through the existing brief_dispatch worker.
create or replace function request_human_video_edit(
  p_asset_id uuid, p_member_id uuid, p_due_date date default null
) returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_source client_media_assets%rowtype;
  v_member team_members%rowtype;
  v_assignment uuid;
  v_existing_member uuid;
  v_dispatch uuid;
  v_job uuid;
begin
  select * into v_source from client_media_assets where id = p_asset_id for update;
  if v_source.id is null or v_source.media_type <> 'video' or v_source.brief_id is null then
    raise exception 'Choose delivered video footage attached to a brief.';
  end if;
  if not is_admin() and auth.uid() is distinct from active_video_approval_manager(v_source.client_id) then
    raise exception 'Only an admin or the assigned SMM may assign a video edit.';
  end if;
  if v_source.edit_stage not in ('needs_edit', 'editing') then
    raise exception 'This video is not waiting for a human edit.';
  end if;
  select * into v_member from team_members where id = p_member_id and active;
  if v_member.id is null or v_member.category <> 'editors' then
    raise exception 'Choose an active editor.';
  end if;
  select id, member_id into v_assignment, v_existing_member from job_assignments
    where source_asset_id = v_source.id and stage in ('assigned', 'accepted', 'rework', 'delivered')
    order by created_at desc limit 1;
  if v_assignment is not null then
    if v_existing_member <> p_member_id then
      raise exception 'This footage is already assigned to another editor.';
    end if;
    return v_assignment;
  end if;
  insert into job_assignments (member_id, client_id, brief_id, source_asset_id, title, due_date)
  values (v_member.id, v_source.client_id, v_source.brief_id, v_source.id,
    'Edit: ' || coalesce(v_source.title, 'Video footage'), p_due_date)
  returning id into v_assignment;
  update client_media_assets set edit_stage = 'editing' where id = v_source.id;
  insert into brief_dispatches (client_id, brief_id, member_id, assignment_id,
      source_asset_id, sent_by, brief_role)
  values (v_source.client_id, v_source.brief_id, v_member.id, v_assignment,
      v_source.id, auth.uid(), 'edit')
  on conflict (brief_id, member_id, brief_role) do update
    set assignment_id = excluded.assignment_id, source_asset_id = excluded.source_asset_id,
        email_status = 'pending', email_error = null, emailed_at = null,
        sent_by = excluded.sent_by
  returning id into v_dispatch;
  insert into agent_jobs (agent_key, client_id, params, created_by)
  values ('brief_dispatch', v_source.client_id,
    jsonb_build_object('dispatch_id', v_dispatch), auth.uid())
  returning id into v_job;
  update brief_dispatches set job_id = v_job where id = v_dispatch;
  return v_assignment;
end;
$$;
revoke execute on function request_human_video_edit(uuid, uuid, date) from public, anon;
grant execute on function request_human_video_edit(uuid, uuid, date) to authenticated;

-- The editor needs read access to the source row and private storage object.
create policy cma_assigned_edit_source_read on client_media_assets for select to authenticated
  using (exists (select 1 from job_assignments j
    where j.source_asset_id = client_media_assets.id and is_member(j.member_id)));
create policy media_obj_assigned_edit_source_read on storage.objects for select to authenticated
  using (bucket_id = 'client-media' and exists (
    select 1 from client_media_assets a join job_assignments j on j.source_asset_id = a.id
    where a.storage_path = storage.objects.name and is_member(j.member_id)
  ));

create or replace function review_media_asset(
  p_asset_id uuid, p_decision review_status, p_reason text default null
) returns void language plpgsql security definer set search_path = public as $$
declare a client_media_assets%rowtype;
begin
  select * into a from client_media_assets where id = p_asset_id for update;
  if a.id is null then raise exception 'Asset not found'; end if;
  if not can_access_client(a.client_id) then raise exception 'Not permitted for this client'; end if;
  if p_decision = 'pending' then raise exception 'Decision must be approved or rejected'; end if;
  if p_decision = 'approved' and a.edit_stage <> 'review_ready' then
    raise exception 'Edit the source footage before approving a finished video.';
  end if;
  if p_decision = 'approved' and a.content_format = 'reel'
     and nullif(btrim(a.render_path), '') is null then
    raise exception 'Finish the reel cut before approving it';
  end if;
  update client_media_assets set review_status = p_decision,
    human_approved_at = case when p_decision = 'approved' then now() else null end
    where id = p_asset_id;
  insert into client_asset_reviews (asset_id, decision, reason, reviewed_by)
    values (p_asset_id, p_decision, p_reason, auth.uid());
end;
$$;
revoke execute on function review_media_asset(uuid, review_status, text) from public, anon;
grant execute on function review_media_asset(uuid, review_status, text) to authenticated;

-- An approved edited version completes both the editor's delivery and the
-- avatar's source-footage assignment. The source asset itself stays unapproved.
create or replace function assignment_follows_review()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_id uuid;
  v_origin uuid;
  v_asset client_media_assets%rowtype;
begin
  if new.decision not in ('approved', 'rejected') then return new; end if;
  select * into v_asset from client_media_assets where id = new.asset_id;
  if v_asset.id is null then return new; end if;
  select a.id into v_id from job_assignments a
    where (a.asset_id = v_asset.id or (a.asset_id is null
      and a.brief_id = v_asset.brief_id and a.member_id = v_asset.member_id))
      and a.stage = 'delivered'
    order by a.created_at desc limit 1;
  if v_id is not null then
    if new.decision = 'approved' then
      perform advance_assignment(v_id, 'approved', 'review', null, v_asset.id);
    else
      perform advance_assignment(v_id, 'rework', 'review',
        coalesce(nullif(btrim(new.reason), ''), 'Rejected, with no reason recorded.'), v_asset.id);
    end if;
  end if;
  if new.decision = 'approved' and v_asset.source_asset_id is not null then
    select a.id into v_origin from job_assignments a
      where a.asset_id = v_asset.source_asset_id and a.stage = 'delivered'
      order by a.created_at desc limit 1;
    if v_origin is not null then
      perform advance_assignment(v_origin, 'approved', 'review', null, v_asset.source_asset_id);
    end if;
    update client_media_assets set edit_stage = 'edited' where id = v_asset.source_asset_id;
  end if;
  return new;
end;
$$;

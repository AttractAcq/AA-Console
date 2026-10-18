-- Motion renders are independent projects until a person explicitly attaches
-- one to content. Attachment creates a review-ready video, never approval.
create table motion_design_attachments (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references motion_design_projects(id),
  asset_id uuid not null unique references client_media_assets(id),
  brief_id uuid references client_briefs(id),
  destination text not null check (destination in ('standalone', 'brief')),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  check ((destination = 'standalone' and brief_id is null)
      or (destination = 'brief' and brief_id is not null))
);
create unique index motion_design_attach_standalone_idx
  on motion_design_attachments(project_id) where destination = 'standalone';
create unique index motion_design_attach_brief_idx
  on motion_design_attachments(project_id, brief_id) where destination = 'brief';
alter table motion_design_attachments enable row level security;
create policy motion_design_attachments_read on motion_design_attachments for select to authenticated
  using (exists (select 1 from motion_design_projects p where p.id = project_id
    and (is_admin() or auth.uid() = active_video_approval_manager(p.client_id))));

create function attach_motion_design(p_project_id uuid, p_brief_id uuid default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  p motion_design_projects%rowtype;
  b client_briefs%rowtype;
  v_existing uuid;
  v_asset uuid;
begin
  select * into p from motion_design_projects where id = p_project_id for update;
  if p.id is null or p.status <> 'completed' or p.render_path is null then
    raise exception 'Choose a completed motion design.';
  end if;
  if not is_admin() and auth.uid() is distinct from active_video_approval_manager(p.client_id) then
    raise exception 'Only an admin or the assigned SMM may attach motion design.';
  end if;
  if p_brief_id is not null then
    select * into b from client_briefs where id = p_brief_id;
    if b.id is null or b.client_id <> p.client_id or b.media_type <> 'video'
        or b.content_format is null
        or b.status <> 'approved' then
      raise exception 'Choose an approved video brief for this client.';
    end if;
  end if;
  if not exists (select 1 from storage.objects where bucket_id = 'client-media'
      and name = p.render_path) then
    raise exception 'The motion video is not stored.';
  end if;
  select asset_id into v_existing from motion_design_attachments
    where project_id = p.id and brief_id is not distinct from p_brief_id;
  if v_existing is not null then return v_existing; end if;
  insert into client_media_assets(client_id, brief_id, media_type, content_format,
    title, storage_path, render_path, uploaded_by, edit_stage, duration_sec)
  values (p.client_id, p_brief_id, 'video',
    case when p_brief_id is null then 'single'::content_format else b.content_format end,
    left(initcap(p.preset) || ' motion design — ' || p.prompt, 300),
    p.render_path, p.render_path, auth.uid(), 'review_ready', p.duration_sec)
  returning id into v_asset;
  insert into motion_design_attachments(project_id, asset_id, brief_id,
    destination, created_by)
  values (p.id, v_asset, p_brief_id,
    case when p_brief_id is null then 'standalone' else 'brief' end, auth.uid());
  return v_asset;
end;
$$;
revoke execute on function attach_motion_design(uuid, uuid) from public, anon;
grant execute on function attach_motion_design(uuid, uuid) to authenticated;

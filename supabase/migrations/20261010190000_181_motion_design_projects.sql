-- Motion Design is an independent client tool, not a tab in the content journey.
create table motion_design_projects (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id),
  prompt text not null,
  preset text not null check (preset in ('explainer', 'tutorial', 'hero')),
  aspect text not null check (aspect in ('vertical', 'square', 'horizontal')),
  duration_sec integer not null check (duration_sec between 4 and 20),
  brand_mode text not null check (brand_mode in ('on_brand', 'neutral')),
  revision_of uuid references motion_design_projects(id),
  status text not null default 'queued' check (status in ('queued', 'running', 'completed', 'failed')),
  scene_plan jsonb,
  render_path text,
  poster_path text,
  job_id uuid references agent_jobs(id),
  error text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  completed_at timestamptz
);
create index motion_design_projects_client_idx on motion_design_projects(client_id, created_at desc);
alter table motion_design_projects enable row level security;
create policy motion_design_projects_read on motion_design_projects for select to authenticated
  using (is_admin() or auth.uid() = active_video_approval_manager(client_id));

insert into agents(agent_key, name, initials, domain, description, requires_upstream, requires_input)
values ('motion_design', 'Motion Design', 'MD', 'content',
  'Plans branded motion scenes with Claude and renders a bounded MP4 and poster.', '{}', true)
on conflict (agent_key) do nothing;

create function request_motion_design(
  p_client_id uuid, p_prompt text, p_preset text, p_aspect text,
  p_duration_sec integer, p_brand_mode text, p_revision_of uuid default null
) returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_project uuid;
  v_job uuid;
begin
  if not exists (select 1 from clients where id = p_client_id) then
    raise exception 'Client not found.';
  end if;
  if not is_admin() and auth.uid() is distinct from active_video_approval_manager(p_client_id) then
    raise exception 'Only an admin or the assigned SMM can create motion design.';
  end if;
  if length(btrim(coalesce(p_prompt, ''))) < 15 or length(p_prompt) > 4000 then
    raise exception 'Describe the motion design in 15 to 4000 characters.';
  end if;
  if p_preset not in ('explainer', 'tutorial', 'hero') or p_aspect not in
      ('vertical', 'square', 'horizontal') or p_duration_sec not between 4 and 20
      or p_brand_mode not in ('on_brand', 'neutral') then
    raise exception 'Choose a supported motion preset, aspect, length and brand setting.';
  end if;
  if p_preset = 'hero' and p_duration_sec > 12 then
    raise exception 'Hero loops are at most 12 seconds.';
  end if;
  if p_revision_of is not null and not exists (
    select 1 from motion_design_projects where id = p_revision_of
      and client_id = p_client_id and status = 'completed') then
    raise exception 'Revise a completed motion design for this client.';
  end if;
  insert into motion_design_projects(client_id, prompt, preset, aspect, duration_sec,
    brand_mode, revision_of, created_by)
  values (p_client_id, btrim(p_prompt), p_preset, p_aspect, p_duration_sec,
    p_brand_mode, p_revision_of, auth.uid()) returning id into v_project;
  v_job := enqueue_agent_job_internal('motion_design', p_client_id,
    'motion_design_projects', v_project, auth.uid(), '{}'::jsonb, 'Queued: motion design');
  update motion_design_projects set job_id = v_job where id = v_project;
  return v_project;
end;
$$;
revoke execute on function request_motion_design(uuid, text, text, text, integer, text, uuid)
  from public, anon;
grant execute on function request_motion_design(uuid, text, text, text, integer, text, uuid)
  to authenticated;

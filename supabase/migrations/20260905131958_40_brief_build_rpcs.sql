-- One call per route, so a build or a hand-off is all-or-nothing.
--
-- Doing this from the client would mean three or four writes with no
-- transaction around them: an assignment with no dispatch, a generation with
-- no job, a brief marked in production that nothing is producing. These do
-- the whole thing or none of it.

-- ---------------------------------------------------------------------------
-- AI route
-- ---------------------------------------------------------------------------

create or replace function build_brief_with_ai(
  p_brief_id uuid,
  p_quality  text default 'medium',
  p_size     text default '1024x1536'
)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_brief   record;
  v_gen_id  uuid;
  v_job_id  uuid;
begin
  if not is_admin() then
    raise exception 'Only an admin can build a brief.';
  end if;

  select id, client_id, media_type, status into v_brief
    from client_briefs where id = p_brief_id;
  if v_brief.id is null then
    raise exception 'That brief does not exist.';
  end if;
  if v_brief.media_type = 'video' then
    raise exception 'Video is produced by people. Send this brief to an editor or avatar instead.';
  end if;
  if p_quality not in ('low', 'medium', 'high') then
    raise exception 'Quality must be low, medium or high.';
  end if;
  if p_size not in ('1024x1536', '1024x1024', '1536x1024') then
    raise exception 'Unsupported image size: %', p_size;
  end if;

  insert into creative_generations (client_id, brief_id, media_type, quality, size, created_by)
  values (v_brief.client_id, p_brief_id, v_brief.media_type, p_quality, p_size, auth.uid())
  returning id into v_gen_id;

  insert into agent_jobs (agent_key, client_id, params, created_by)
  values ('creative_build', v_brief.client_id,
          jsonb_build_object('generation_id', v_gen_id), auth.uid())
  returning id into v_job_id;

  update creative_generations set job_id = v_job_id where id = v_gen_id;
  update client_briefs set status = 'in_production' where id = p_brief_id;

  insert into agent_job_events (job_id, description) values (v_job_id, 'Queued from Approve & Build');

  return v_gen_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Human route
-- ---------------------------------------------------------------------------

create or replace function dispatch_brief_to_members(
  p_brief_id     uuid,
  p_member_ids   uuid[],
  p_due_date     date default null,
  p_compensation numeric default null
)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_brief     record;
  v_member    record;
  v_assign_id uuid;
  v_disp_id   uuid;
  v_job_id    uuid;
  v_count     integer := 0;
begin
  if not is_admin() then
    raise exception 'Only an admin can send a brief.';
  end if;
  if p_member_ids is null or array_length(p_member_ids, 1) is null then
    raise exception 'Choose at least one person to send this to.';
  end if;

  select id, client_id, title into v_brief from client_briefs where id = p_brief_id;
  if v_brief.id is null then
    raise exception 'That brief does not exist.';
  end if;

  for v_member in
    select id, name, category from team_members
     where id = any(p_member_ids) and active = true
  loop
    -- Production work only. An SMM schedules and distributes; they do not
    -- get handed a creative brief to make.
    if v_member.category not in ('editors', 'avatars') then
      raise exception '% is not an editor or an avatar.', v_member.name;
    end if;

    insert into job_assignments (member_id, client_id, brief_id, title, due_date, compensation)
    values (v_member.id, v_brief.client_id, p_brief_id, v_brief.title, p_due_date, p_compensation)
    returning id into v_assign_id;

    insert into brief_dispatches (client_id, brief_id, member_id, assignment_id, sent_by)
    values (v_brief.client_id, p_brief_id, v_member.id, v_assign_id, auth.uid())
    on conflict (brief_id, member_id) do update
      set assignment_id = excluded.assignment_id,
          email_status = 'pending',
          email_error = null,
          emailed_at = null
    returning id into v_disp_id;

    insert into agent_jobs (agent_key, client_id, params, created_by)
    values ('brief_dispatch', v_brief.client_id,
            jsonb_build_object('dispatch_id', v_disp_id), auth.uid())
    returning id into v_job_id;

    update brief_dispatches set job_id = v_job_id where id = v_disp_id;
    v_count := v_count + 1;
  end loop;

  if v_count = 0 then
    raise exception 'None of those people are active team members.';
  end if;

  update client_briefs set status = 'in_production' where id = p_brief_id;
  return v_count;
end;
$$;

revoke all on function build_brief_with_ai(uuid, text, text) from public, anon;
revoke all on function dispatch_brief_to_members(uuid, uuid[], date, numeric) from public, anon;
grant execute on function build_brief_with_ai(uuid, text, text) to authenticated, service_role;
grant execute on function dispatch_brief_to_members(uuid, uuid[], date, numeric) to authenticated, service_role;

comment on function build_brief_with_ai(uuid, text, text) is
  'Creates a creative_generations row and queues creative_build for it, atomically. Refuses video.';
comment on function dispatch_brief_to_members(uuid, uuid[], date, numeric) is
  'Assigns a brief to editors/avatars and queues the notification email for each, atomically.';;

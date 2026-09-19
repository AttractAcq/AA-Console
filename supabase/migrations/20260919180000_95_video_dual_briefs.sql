-- Video dual briefs: role-scoped bodies + independent dispatch.
--
-- One idea still produces one client_briefs row (the operator master). Video
-- additionally stores avatar_brief and editor_brief so talent and editors can
-- be briefed and re-sent independently without splitting the production chain
-- that hangs off brief_id.
--
-- DO NOT apply to production without Alex CLEAR.

-- ---------------------------------------------------------------------------
-- Schema
-- ---------------------------------------------------------------------------

alter table client_briefs
  add column if not exists avatar_brief text,
  add column if not exists editor_brief text;

comment on column client_briefs.avatar_brief is
  'Video only. Talent/performance brief: script, wardrobe, framing, what not to say/show. Null on image/text.';
comment on column client_briefs.editor_brief is
  'Video only. Cut/caption/deliver brief: assembly, captions, crops, audio, export. Null on image/text.';

alter table brief_dispatches
  add column if not exists brief_role text not null default 'full';

alter table brief_dispatches
  drop constraint if exists brief_dispatches_brief_role_check;

alter table brief_dispatches
  add constraint brief_dispatches_brief_role_check
  check (brief_role in ('avatar', 'editor', 'full'));

comment on column brief_dispatches.brief_role is
  'Which body was sent: avatar, editor, or full (non-video / legacy).';

-- Replace unique (brief_id, member_id) so the same person can receive avatar
-- and editor roles independently, and so one role can be re-sent without the other.
alter table brief_dispatches
  drop constraint if exists brief_dispatches_brief_id_member_id_key;

alter table brief_dispatches
  drop constraint if exists brief_dispatches_brief_member_unique;

do $$
begin
  if exists (
    select 1 from pg_constraint
    where conname = 'brief_dispatches_brief_id_member_id_key'
  ) then
    alter table brief_dispatches drop constraint brief_dispatches_brief_id_member_id_key;
  end if;
end $$;

create unique index if not exists brief_dispatches_brief_member_role_uidx
  on brief_dispatches (brief_id, member_id, brief_role);

-- ---------------------------------------------------------------------------
-- Console RPC: dispatch_brief_to_members — add p_brief_role
-- ---------------------------------------------------------------------------

drop function if exists dispatch_brief_to_members(uuid, uuid[], date, numeric);

create or replace function dispatch_brief_to_members(
  p_brief_id     uuid,
  p_member_ids   uuid[],
  p_due_date     date default null,
  p_compensation numeric default null,
  p_brief_role   text default 'full'
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
  v_role      text := coalesce(nullif(trim(p_brief_role), ''), 'full');
  v_need_cat  text;
begin
  if not is_admin() then
    raise exception 'Only an admin can send a brief.';
  end if;
  if p_member_ids is null or array_length(p_member_ids, 1) is null then
    raise exception 'Choose at least one person to send this to.';
  end if;
  if v_role not in ('avatar', 'editor', 'full') then
    raise exception 'brief_role must be avatar, editor, or full.';
  end if;

  select id, client_id, title, media_type, avatar_brief, editor_brief, body
    into v_brief
    from client_briefs where id = p_brief_id;
  if v_brief.id is null then
    raise exception 'That brief does not exist.';
  end if;

  -- Role sends are video-only. Image/text keep the legacy full dispatch.
  if v_role in ('avatar', 'editor') and v_brief.media_type is distinct from 'video' then
    raise exception 'Avatar and editor briefs are only for video.';
  end if;
  if v_role = 'avatar' and (v_brief.avatar_brief is null or length(trim(v_brief.avatar_brief)) = 0) then
    raise exception 'This video brief has no avatar brief yet.';
  end if;
  if v_role = 'editor' and (v_brief.editor_brief is null or length(trim(v_brief.editor_brief)) = 0) then
    raise exception 'This video brief has no editor brief yet.';
  end if;

  v_need_cat := case v_role
    when 'avatar' then 'avatars'
    when 'editor' then 'editors'
    else null
  end;

  for v_member in
    select id, name, category from team_members
     where id = any(p_member_ids) and active = true
  loop
    if v_member.category not in ('editors', 'avatars') then
      raise exception '% is not an editor or an avatar.', v_member.name;
    end if;
    if v_need_cat is not null and v_member.category is distinct from v_need_cat then
      raise exception '% is not in the % category required for this send.', v_member.name, v_need_cat;
    end if;

    insert into job_assignments (member_id, client_id, brief_id, title, due_date, compensation)
    values (v_member.id, v_brief.client_id, p_brief_id, v_brief.title, p_due_date, p_compensation)
    returning id into v_assign_id;

    insert into brief_dispatches (client_id, brief_id, member_id, assignment_id, sent_by, brief_role)
    values (v_brief.client_id, p_brief_id, v_member.id, v_assign_id, auth.uid(), v_role)
    on conflict (brief_id, member_id, brief_role) do update
      set assignment_id = excluded.assignment_id,
          email_status = 'pending',
          email_error = null,
          emailed_at = null,
          sent_by = excluded.sent_by
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

revoke all on function dispatch_brief_to_members(uuid, uuid[], date, numeric, text) from public, anon;
grant execute on function dispatch_brief_to_members(uuid, uuid[], date, numeric, text)
  to authenticated, service_role;

comment on function dispatch_brief_to_members(uuid, uuid[], date, numeric, text) is
  'Assigns a brief to editors/avatars and queues notification email. p_brief_role selects avatar/editor/full body for video dual briefs.';

-- ---------------------------------------------------------------------------
-- MCP brief_json — expose role bodies
-- ---------------------------------------------------------------------------

create or replace function mcp_internal.brief_json(p client_briefs)
returns jsonb
language plpgsql
stable
set search_path = mcp_internal, public
as $$
declare
  r jsonb := to_jsonb(p);
begin
  return jsonb_build_object(
    'id', r->>'id',
    'client_id', r->>'client_id',
    'source_idea_id', r->>'source_idea_id',
    'title', r->>'title',
    'body', mcp_internal.clip_text(r->>'body'),
    'body_truncated', r->>'body' is not null and char_length(r->>'body') > 8000,
    'avatar_brief', mcp_internal.clip_text(r->>'avatar_brief'),
    'editor_brief', mcp_internal.clip_text(r->>'editor_brief'),
    'media_type', r->>'media_type',
    'status', r->>'status',
    'brief_ref', r->>'brief_ref',
    'job_id', r->>'job_id',
    'hook', mcp_internal.clip_text(r->>'hook'),
    'premise', mcp_internal.clip_text(r->>'premise'),
    'argument', mcp_internal.clip_text(r->>'argument'),
    'proof', mcp_internal.clip_text(r->>'proof'),
    'proof_asset_id', r->>'proof_asset_id',
    'script', mcp_internal.clip_text(r->>'script'),
    'visual_direction', mcp_internal.clip_text(r->>'visual_direction'),
    'shot_requirements', mcp_internal.clip_text(r->>'shot_requirements'),
    'b_roll', mcp_internal.clip_text(r->>'b_roll'),
    'call_to_action', mcp_internal.clip_text(r->>'call_to_action'),
    'channel_intent', mcp_internal.clip_text(r->>'channel_intent'),
    'production_method', r->>'production_method',
    'derived_from_asset_id', r->>'derived_from_asset_id',
    'repurpose_format', r->>'repurpose_format',
    'created_at', r->>'created_at',
    'updated_at', r->>'updated_at'
  );
end;
$$;

revoke all on function mcp_internal.brief_json(client_briefs)
  from public, anon, authenticated;
grant execute on function mcp_internal.brief_json(client_briefs) to service_role;

-- ---------------------------------------------------------------------------
-- MCP assign_production — accept brief_role for human route
-- ---------------------------------------------------------------------------

drop function if exists public.mcp_assign_production(text, text, text, uuid, uuid, text, uuid[], date, numeric, text, text);
drop function if exists mcp_internal.assign_production(text, text, text, uuid, uuid, text, uuid[], date, numeric, text, text);

create or replace function mcp_internal.assign_production(
  p_bot_id text, p_request_id text, p_execution_id text, p_client_id uuid,
  p_brief_id uuid, p_route text, p_member_ids uuid[] default null,
  p_due_date date default null, p_compensation numeric default null,
  p_quality text default 'medium', p_size text default '1024x1536',
  p_brief_role text default null
)
returns jsonb
language plpgsql
security definer
set search_path = mcp_internal, public
as $$
declare
  v_brief client_briefs;
  v_payload jsonb;
  v_existing jsonb;
  v_gen uuid;
  v_render_id uuid;
  v_job uuid;
  v_member record;
  v_assign_id uuid;
  v_disp_id uuid;
  v_count integer := 0;
  v_result jsonb;
  v_assignments jsonb := '[]'::jsonb;
  v_role text;
  v_need_cat text;
begin
  perform mcp_internal.require_active_bot(p_bot_id);
  perform mcp_internal.require_bot_client_grant(p_bot_id, p_client_id);
  if p_bot_id <> 'bot_production' then
    raise exception using message = 'bot_forbidden', errcode = 'P0001';
  end if;
  perform mcp_internal.require_mcp_ids(p_request_id, p_execution_id);
  if p_brief_id is null or p_route is null or p_route not in ('ai', 'human') then
    raise exception using message = 'invalid_args', errcode = 'P0001';
  end if;

  select * into v_brief from client_briefs
   where id = p_brief_id and client_id = p_client_id;
  if v_brief.id is null then
    raise exception using message = 'brief_not_found', errcode = 'P0001';
  end if;

  v_payload := jsonb_build_object(
    'brief_id', p_brief_id, 'route', p_route, 'member_ids', to_jsonb(p_member_ids),
    'due_date', p_due_date, 'compensation', p_compensation,
    'quality', p_quality, 'size', p_size, 'brief_role', p_brief_role
  );
  v_existing := mcp_internal.take_content_request(
    p_bot_id, p_execution_id, 'content.assign_production', p_client_id, v_payload);
  if v_existing is not null then
    return v_existing;
  end if;

  if p_route = 'ai' then
    if v_brief.media_type = 'video' then
      raise exception using message = 'video_not_ai', errcode = 'P0001';
    end if;
    insert into creative_generations (client_id, brief_id, media_type, quality, size)
    values (
      p_client_id, p_brief_id, v_brief.media_type,
      coalesce(p_quality, 'medium'), coalesce(p_size, '1024x1536')
    ) returning id into v_gen;
    insert into creative_renders (
      client_id, generation_id, brief_id, media_type, quality, size, reference_path
    ) values (
      p_client_id, v_gen, p_brief_id, v_brief.media_type,
      coalesce(p_quality, 'medium'), coalesce(p_size, '1024x1536'),
      null
    ) returning id into v_render_id;
    begin
      v_job := public.enqueue_agent_job_internal(
        'creative_build', p_client_id, 'creative_renders', v_render_id,
        null, jsonb_build_object('render_id', v_render_id),
        'Queued by MCP content.assign_production');
    exception
      when raise_exception then
        raise exception using message = 'queue_failure', errcode = 'P0001';
      when others then
        raise exception using message = 'queue_failure', errcode = 'P0001';
    end;
    update creative_generations set job_id = v_job where id = v_gen;
    update creative_renders set job_id = v_job where id = v_render_id;
    update client_briefs set status = 'in_production' where id = p_brief_id;
    v_result := jsonb_build_object(
      'client_id', p_client_id, 'brief_id', p_brief_id, 'route', 'ai',
      'generation_id', v_gen, 'render_id', v_render_id, 'job_id', v_job,
      'replayed', false
    );
  else
    if p_member_ids is null or array_length(p_member_ids, 1) is null then
      raise exception using message = 'member_not_found', errcode = 'P0001';
    end if;

    -- Infer role from brief_role arg, else from member category when unanimous.
    v_role := nullif(trim(coalesce(p_brief_role, '')), '');
    if v_role is null and v_brief.media_type = 'video' then
      if exists (
        select 1 from team_members
         where id = any (p_member_ids) and active and category = 'avatars'
      ) and not exists (
        select 1 from team_members
         where id = any (p_member_ids) and active and category = 'editors'
      ) then
        v_role := 'avatar';
      elsif exists (
        select 1 from team_members
         where id = any (p_member_ids) and active and category = 'editors'
      ) and not exists (
        select 1 from team_members
         where id = any (p_member_ids) and active and category = 'avatars'
      ) then
        v_role := 'editor';
      else
        v_role := 'full';
      end if;
    elsif v_role is null then
      v_role := 'full';
    end if;
    if v_role not in ('avatar', 'editor', 'full') then
      raise exception using message = 'invalid_args', errcode = 'P0001';
    end if;
    if v_role in ('avatar', 'editor') and v_brief.media_type is distinct from 'video' then
      raise exception using message = 'invalid_args', errcode = 'P0001';
    end if;

    v_need_cat := case v_role
      when 'avatar' then 'avatars'
      when 'editor' then 'editors'
      else null
    end;

    for v_member in
      select id, name, category from team_members
       where id = any (p_member_ids) and active = true
    loop
      if v_member.category not in ('editors', 'avatars') then
        raise exception using message = 'member_not_found', errcode = 'P0001';
      end if;
      if v_need_cat is not null and v_member.category is distinct from v_need_cat then
        raise exception using message = 'member_not_found', errcode = 'P0001';
      end if;
      insert into job_assignments (member_id, client_id, brief_id, title, due_date, compensation)
      values (v_member.id, p_client_id, p_brief_id, v_brief.title, p_due_date, p_compensation)
      returning id into v_assign_id;
      insert into brief_dispatches (client_id, brief_id, member_id, assignment_id, sent_by, brief_role)
      values (p_client_id, p_brief_id, v_member.id, v_assign_id, null, v_role)
      on conflict (brief_id, member_id, brief_role) do update
        set assignment_id = excluded.assignment_id,
            email_status = 'pending',
            email_error = null,
            emailed_at = null
      returning id into v_disp_id;
      begin
        v_job := public.enqueue_agent_job_internal(
          'brief_dispatch', p_client_id, 'brief_dispatches', v_disp_id,
          null, jsonb_build_object('dispatch_id', v_disp_id), 'Queued by MCP content.assign_production');
      exception
        when raise_exception then
          raise exception using message = 'queue_failure', errcode = 'P0001';
        when others then
          raise exception using message = 'queue_failure', errcode = 'P0001';
      end;
      update brief_dispatches set job_id = v_job where id = v_disp_id;
      v_assignments := v_assignments || jsonb_build_array(jsonb_build_object(
        'assignment_id', v_assign_id, 'member_id', v_member.id,
        'dispatch_id', v_disp_id, 'job_id', v_job, 'brief_role', v_role
      ));
      v_count := v_count + 1;
    end loop;
    if v_count = 0 then
      raise exception using message = 'member_not_found', errcode = 'P0001';
    end if;
    update client_briefs set status = 'in_production' where id = p_brief_id;
    v_result := jsonb_build_object(
      'client_id', p_client_id, 'brief_id', p_brief_id, 'route', 'human',
      'brief_role', v_role, 'assigned', v_count, 'assignments', v_assignments, 'replayed', false
    );
  end if;

  insert into mcp_internal.mcp_content_requests (
    bot_id, execution_id, request_id, tool, client_id, brief_id, payload, result
  ) values (
    p_bot_id, p_execution_id, p_request_id, 'content.assign_production',
    p_client_id, p_brief_id, v_payload, v_result
  );
  return v_result;
end;
$$;

revoke all on function mcp_internal.assign_production(text, text, text, uuid, uuid, text, uuid[], date, numeric, text, text, text)
  from public, anon, authenticated;
grant execute on function mcp_internal.assign_production(text, text, text, uuid, uuid, text, uuid[], date, numeric, text, text, text)
  to service_role;

create or replace function public.mcp_assign_production(
  p_bot_id text, p_request_id text, p_execution_id text, p_client_id uuid,
  p_brief_id uuid, p_route text, p_member_ids uuid[] default null,
  p_due_date date default null, p_compensation numeric default null,
  p_quality text default 'medium', p_size text default '1024x1536',
  p_brief_role text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, mcp_internal
as $$
begin
  return mcp_internal.assign_production(
    p_bot_id, p_request_id, p_execution_id, p_client_id,
    p_brief_id, p_route, p_member_ids, p_due_date, p_compensation,
    p_quality, p_size, p_brief_role
  );
end;
$$;

revoke all on function public.mcp_assign_production(text, text, text, uuid, uuid, text, uuid[], date, numeric, text, text, text)
  from public, anon, authenticated;
grant execute on function public.mcp_assign_production(text, text, text, uuid, uuid, text, uuid[], date, numeric, text, text, text)
  to service_role;

comment on function mcp_internal.assign_production(text, text, text, uuid, uuid, text, uuid[], date, numeric, text, text, text) is
  'Approve & Build sibling. Human route accepts p_brief_role (avatar|editor|full) for video dual briefs; one call assigns one role.';

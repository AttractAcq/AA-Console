-- Lock the production hotfix for content.assign_production route=ai.
--
-- Migration 95 (20260919180000_95_video_dual_briefs.sql) replaced
-- mcp_internal.assign_production / public.mcp_assign_production and, on the
-- AI route, inserted into creative_renders with brief_id and media_type.
-- Those columns do not exist on creative_renders (they belong on
-- creative_generations and client_briefs). That insert 500'd
-- assign_production route=ai on production.
--
-- The correct AI insert is the one from migration 93
-- (20260916180000_93_assign_production_ai_render.sql):
--   insert into creative_renders (generation_id, client_id, quality, size, reference_path)
--
-- Production was hotfixed remotely as fix_assign_production_ai_render_columns
-- (not previously in git). The live function keeps the migration 95 signature
-- (p_brief_role) and the human dual-brief path, and uses the migration 93
-- column list for the AI creative_renders insert. This forward migration
-- records that shape so staging, fresh environments, and a re-apply of the
-- git history cannot put the bad columns back.
--
-- Historical migration 95 is left unchanged. Do not apply to production
-- without Alex CLEAR. The remote hotfix is already live; applying this
-- CREATE OR REPLACE is idempotent with that hotfix.

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
    -- creative_renders has no brief_id or media_type. Those stay on
    -- creative_generations (inserted above). Column list matches migration 93
    -- and public.build_brief_with_ai.
    insert into creative_renders (generation_id, client_id, quality, size, reference_path)
    values (
      v_gen, p_client_id,
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
  'Approve & Build sibling. Human route accepts p_brief_role (avatar|editor|full) for video dual briefs; one call assigns one role. AI route inserts creative_renders (generation_id, client_id, quality, size, reference_path).';

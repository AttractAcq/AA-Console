-- Fix Bot content.assign_production AI route so creative_build can actually run.
--
-- Bug (live, mig 90): mcp_internal.assign_production route=ai inserted
-- creative_generations and enqueued creative_build with
-- params {generation_id: v_gen} and ZERO creative_renders rows.
-- agent-runtime creative_build reads params.render_id and fails immediately
-- with "No render to produce." before writing a concept.
--
-- Console public.build_brief_with_ai (mig 43) is the correct shape: insert
-- generation, insert render linked to it, enqueue with
-- jsonb_build_object('render_id', v_render_id), then stamp job_id on both
-- rows. This REPLACE mirrors that AI path. Human dispatch is unchanged.
--
-- Additive CREATE OR REPLACE only. Do not apply to production without Alex
-- via Chief of Staff. No surgical repair of stuck generations.

begin;

create or replace function mcp_internal.assign_production(
  p_bot_id text, p_request_id text, p_execution_id text, p_client_id uuid,
  p_brief_id uuid, p_route text, p_member_ids uuid[] default null,
  p_due_date date default null, p_compensation numeric default null,
  p_quality text default 'medium', p_size text default '1024x1536'
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
begin
  perform mcp_internal.require_active_bot(p_bot_id);
  perform mcp_internal.require_bot_client_grant(p_bot_id, p_client_id);
  if p_bot_id <> 'bot_production' then
    raise exception using message = 'bot_forbidden', errcode = 'P0001';
  end if;
  perform mcp_internal.require_mcp_ids(p_request_id, p_execution_id);
  if p_brief_id is null or p_route is null or p_route not in ('ai', 'human') then
    raise exception using message = 'invalid_production_route', errcode = 'P0001';
  end if;
  if p_route = 'human' and (p_member_ids is null or array_length(p_member_ids, 1) is null) then
    raise exception using message = 'invalid_request', errcode = 'P0001';
  end if;
  if p_quality is not null and p_quality not in ('low', 'medium', 'high') then
    raise exception using message = 'invalid_request', errcode = 'P0001';
  end if;
  if p_size is not null and p_size not in ('1024x1536', '1024x1024', '1536x1024') then
    raise exception using message = 'invalid_request', errcode = 'P0001';
  end if;

  v_payload := jsonb_strip_nulls(jsonb_build_object(
    'brief_id', p_brief_id, 'route', p_route,
    'member_ids', to_jsonb(p_member_ids),
    'due_date', p_due_date, 'compensation', p_compensation,
    'quality', coalesce(p_quality, 'medium'), 'size', coalesce(p_size, '1024x1536')
  ));
  v_existing := mcp_internal.take_content_request(
    p_bot_id, p_execution_id, 'content.assign_production', p_client_id, v_payload);
  if v_existing is not null then
    return v_existing;
  end if;

  select * into v_brief from client_briefs where id = p_brief_id for update;
  if not found then
    raise exception using message = 'brief_not_found', errcode = 'P0001';
  end if;
  if v_brief.client_id <> p_client_id then
    raise exception using message = 'client_mismatch', errcode = 'P0001';
  end if;
  if v_brief.status not in ('draft', 'approved') then
    raise exception using message = 'invalid_brief_status', errcode = 'P0001';
  end if;

  if p_route = 'ai' then
    if v_brief.media_type = 'video' then
      raise exception using message = 'invalid_production_route', errcode = 'P0001';
    end if;
    insert into creative_generations (client_id, brief_id, media_type, quality, size)
    values (
      p_client_id, p_brief_id, v_brief.media_type,
      coalesce(p_quality, 'medium'), coalesce(p_size, '1024x1536')
    ) returning id into v_gen;
    -- Mirror public.build_brief_with_ai: the runner is handed a render, not a
    -- generation. Without this row, creative_build exits "No render to produce."
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
    for v_member in
      select id, name, category from team_members
       where id = any (p_member_ids) and active = true
    loop
      if v_member.category not in ('editors', 'avatars') then
        raise exception using message = 'member_not_found', errcode = 'P0001';
      end if;
      insert into job_assignments (member_id, client_id, brief_id, title, due_date, compensation)
      values (v_member.id, p_client_id, p_brief_id, v_brief.title, p_due_date, p_compensation)
      returning id into v_assign_id;
      insert into brief_dispatches (client_id, brief_id, member_id, assignment_id, sent_by)
      values (p_client_id, p_brief_id, v_member.id, v_assign_id, null)
      on conflict (brief_id, member_id) do update
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
        'assignment_id', v_assign_id, 'member_id', v_member.id, 'dispatch_id', v_disp_id, 'job_id', v_job
      ));
      v_count := v_count + 1;
    end loop;
    if v_count = 0 then
      raise exception using message = 'member_not_found', errcode = 'P0001';
    end if;
    update client_briefs set status = 'in_production' where id = p_brief_id;
    v_result := jsonb_build_object(
      'client_id', p_client_id, 'brief_id', p_brief_id, 'route', 'human',
      'assigned', v_count, 'assignments', v_assignments, 'replayed', false
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

comment on function mcp_internal.assign_production(text, text, text, uuid, uuid, text, uuid[], date, numeric, text, text) is
  'Bot production assign. AI route mirrors build_brief_with_ai: generation + render, enqueue creative_build with params.render_id. Human route dispatch is unchanged.';

revoke all on function mcp_internal.assign_production(text, text, text, uuid, uuid, text, uuid[], date, numeric, text, text)
  from public, anon, authenticated;
grant execute on function mcp_internal.assign_production(text, text, text, uuid, uuid, text, uuid[], date, numeric, text, text)
  to service_role;

-- Public wrapper is unchanged (same signature, still service_role-only).
-- Recreate so grants stay explicit after REPLACE of the internal function.
create or replace function public.mcp_assign_production(
  p_bot_id text, p_request_id text, p_execution_id text, p_client_id uuid,
  p_brief_id uuid, p_route text, p_member_ids uuid[] default null,
  p_due_date date default null, p_compensation numeric default null,
  p_quality text default 'medium', p_size text default '1024x1536'
)
returns jsonb language plpgsql security definer set search_path = mcp_internal, public as $$
begin
  perform mcp_internal.require_service_role();
  return mcp_internal.assign_production(
    p_bot_id, p_request_id, p_execution_id, p_client_id, p_brief_id, p_route,
    p_member_ids, p_due_date, p_compensation, p_quality, p_size);
end;
$$;
revoke all on function public.mcp_assign_production(text, text, text, uuid, uuid, text, uuid[], date, numeric, text, text)
  from public, anon, authenticated;
grant execute on function public.mcp_assign_production(text, text, text, uuid, uuid, text, uuid[], date, numeric, text, text)
  to service_role;

commit;

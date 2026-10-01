-- Approve & Build queues video_build for a Phase 1 reel.
--
-- build_brief_with_ai (117) refuses every video and always inserts
-- creative_build. A reel is a video, so the button that should start
-- motion could not. creative_generations still rejects media_type video,
-- and creative_build still refuses a video brief, so this does not invent
-- a stills row for the reel. Opening frames stay on creative_build when a
-- still brief is built. The reel job is a separate queue entry.
--
-- What counts as Phase 1. F6 or F7, or a reel whose format code is still
-- unset. A reel already tagged F1–F5 or F8–F10 is a later phase and stays
-- on the human route. A video story is still made by people.
--
-- The job is inserted here, the same way a stills build inserts
-- creative_build, rather than through enqueue_agent_job_internal.
-- video_build.requires_upstream is the brief agent. This call is the
-- build of a brief that already exists, and the upstream check would
-- refuse it whenever that agent job is not on file. input_table and
-- input_id are what the runner reads. The paused flag is still honored:
-- a paused video_build is the kill switch and must not be skipped.
--
-- The shot plan already on the brief is left alone. A typed carousel
-- plan must not overwrite the JSON shots the brief agent stored.
--
-- Nothing in this function calls Higgsfield. The runner pauses motion
-- itself when credentials are missing or the adapter is not enabled.

create or replace function build_brief_with_ai(
  p_brief_id       uuid,
  p_quality        text default 'medium',
  p_size           text default '1024x1536',
  p_reference_path text default null,
  p_frame_count    integer default null,
  p_frame_plan     text[] default null
)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_brief     record;
  v_gen_id    uuid;
  v_render_id uuid;
  v_job_id    uuid;
  v_plan      text[];
  v_count     integer;
  v_note      text;
  v_paused    boolean;
  v_phase1    boolean;
begin
  if not is_admin() then
    raise exception 'Only an admin can build a brief.';
  end if;

  select id, client_id, media_type, content_format, format_code into v_brief
    from client_briefs where id = p_brief_id;
  if v_brief.id is null then raise exception 'That brief does not exist.'; end if;

  -- F6/F7, or a reel that has not been given a later format code.
  v_phase1 := v_brief.media_type = 'video'
    and (
      v_brief.format_code in ('F6', 'F7')
      or (
        v_brief.content_format = 'reel'
        and (v_brief.format_code is null or v_brief.format_code in ('F6', 'F7'))
      )
    );

  if v_phase1 then
    if p_reference_path is not null then
      raise exception 'A reference image does not apply to a reel build.';
    end if;

    select paused into v_paused from agents where agent_key = 'video_build';
    if not found then
      raise exception 'Unknown agent: video_build';
    end if;
    if v_paused then
      raise exception 'Agent video_build is paused';
    end if;

    -- p_frame_count and p_frame_plan are ignored on purpose. The shot
    -- plan is already on the brief. Writing a textarea over it would
    -- replace JSON shots with plain lines, and video_build would refuse
    -- the job it was just given.
    insert into agent_jobs (agent_key, client_id, input_table, input_id, params, created_by)
    values (
      'video_build',
      v_brief.client_id,
      'client_briefs',
      p_brief_id,
      '{}'::jsonb,
      auth.uid()
    )
    returning id into v_job_id;

    update client_briefs set status = 'in_production' where id = p_brief_id;

    insert into agent_job_events (job_id, description)
    values (
      v_job_id,
      'Queued from Approve & Build for a reel. Opening stills stay on creative_build. Motion stays paused until Higgsfield is enabled. No Higgsfield request was sent.'
    );
    return v_job_id;
  end if;

  if v_brief.media_type = 'video' then
    if v_brief.content_format = 'reel' then
      raise exception 'Phase 1 video build is F6 or F7. This reel is %. Send it to an editor.',
        coalesce(v_brief.format_code, 'unspecified');
    end if;
    raise exception 'Video is produced by people. Send this brief to an editor or avatar instead.';
  end if;
  if p_quality not in ('low','medium','high') then raise exception 'Quality must be low, medium or high.'; end if;
  if p_size not in ('1024x1536','1024x1024','1536x1024') then raise exception 'Unsupported image size: %', p_size; end if;
  if p_reference_path is not null and v_brief.media_type <> 'image' then
    raise exception 'A reference image only applies to an image build.';
  end if;
  if p_reference_path is not null and p_reference_path not like (v_brief.client_id::text || '/%') then
    raise exception 'That reference image does not belong to this client.';
  end if;

  -- Blank lines are dropped before counting: a textarea with a trailing
  -- newline is the normal way to type four lines, not a request for a fifth
  -- frame with no brief.
  select array_agg(btrim(line) order by ord)
    into v_plan
    from unnest(coalesce(p_frame_plan, '{}')) with ordinality as t(line, ord)
   where btrim(coalesce(line, '')) <> '';

  v_count := coalesce(cardinality(v_plan), p_frame_count);
  -- Nothing typed: the bounds and the queued note are about the plan already
  -- on the brief, not about an absence.
  if v_count is null then
    select frame_count into v_count from client_briefs where id = p_brief_id;
  end if;

  if v_brief.content_format = 'single' and v_count is not null then
    raise exception 'This brief is a single, so there are no frames to plan. Change its format first.';
  end if;
  if v_count is not null and (v_count < 2 or v_count > 10) then
    raise exception 'A frame set runs from 2 to 10 frames; this asks for %.', v_count;
  end if;
  -- Both given and disagreeing. The check constraint would refuse it too,
  -- but by name rather than in a sentence somebody can act on.
  if v_plan is not null and p_frame_count is not null and p_frame_count <> cardinality(v_plan) then
    raise exception 'The brief asks for % frames but the plan has % lines. They have to agree.',
      p_frame_count, cardinality(v_plan);
  end if;

  -- Three cases, and the third is the one that matters now.
  --
  -- When 114 was written, Approve & Build was the only thing that could fill
  -- these columns, so writing both unconditionally was harmless. Since the
  -- brief agent started writing the frame plan itself, blank boxes are the
  -- normal case rather than the empty one — and an unconditional write turned
  -- "I did not ask for anything in particular" into "erase the plan the agent
  -- wrote", silently, on the click that builds it.
  if v_plan is not null then
    -- A plan was typed. It wins outright, and carries its own count.
    update client_briefs
       set frame_plan = v_plan, frame_count = cardinality(v_plan)
     where id = p_brief_id;
  elsif p_frame_count is not null then
    -- A count alone was typed. It replaces whatever was there, and any
    -- existing plan has to go with it: a plan of eight lines beside a count
    -- of five is the disagreement the check constraint refuses.
    update client_briefs
       set frame_count = p_frame_count, frame_plan = null
     where id = p_brief_id;
  end if;
  -- Neither typed: leave the brief exactly as the agent wrote it.

  insert into creative_generations
    (client_id, brief_id, media_type, quality, size, reference_path, created_by)
  values (v_brief.client_id, p_brief_id, v_brief.media_type, p_quality, p_size, p_reference_path, auth.uid())
  returning id into v_gen_id;

  insert into creative_renders (generation_id, client_id, quality, size, reference_path, created_by)
  values (v_gen_id, v_brief.client_id, p_quality, p_size, p_reference_path, auth.uid())
  returning id into v_render_id;

  insert into agent_jobs (agent_key, client_id, params, created_by)
  values ('creative_build', v_brief.client_id,
          jsonb_build_object('render_id', v_render_id), auth.uid())
  returning id into v_job_id;

  update creative_generations set job_id = v_job_id where id = v_gen_id;
  update creative_renders set job_id = v_job_id where id = v_render_id;
  update client_briefs set status = 'in_production' where id = p_brief_id;

  v_note := case when p_reference_path is null
                 then 'Queued from Approve & Build'
                 else 'Queued from Approve & Build, working from a reference image' end;
  if v_count is not null then
    v_note := v_note || format(', asking for %s frames', v_count);
    if v_plan is not null then v_note := v_note || ' to a set plan'; end if;
  end if;

  insert into agent_job_events (job_id, description) values (v_job_id, v_note);
  return v_gen_id;
end;
$$;

revoke all on function build_brief_with_ai(uuid, text, text, text, integer, text[]) from public, anon;
grant execute on function build_brief_with_ai(uuid, text, text, text, integer, text[]) to authenticated;

comment on function build_brief_with_ai(uuid, text, text, text, integer, text[]) is
  'Admin-only. A Phase 1 reel (F6, F7, or a reel with no later format code) queues video_build against the brief and leaves the shot plan untouched. Every other still or text brief still queues creative_build. Other video stays with an editor or avatar. Does not call Higgsfield.';

-- Bot sibling. Same Phase 1 split. Human dispatch is unchanged.
-- Direct insert, for the same reason as the admin RPC: the brief is
-- already the input, and requires_upstream would refuse a client whose
-- brief agent job is not completed. Paused is still a hard stop.

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
  v_paused boolean;
  v_phase1 boolean;
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

  v_phase1 := v_brief.media_type = 'video'
    and (
      v_brief.format_code in ('F6', 'F7')
      or (
        v_brief.content_format = 'reel'
        and (v_brief.format_code is null or v_brief.format_code in ('F6', 'F7'))
      )
    );

  if p_route = 'ai' then
    if v_brief.media_type = 'video' and not v_phase1 then
      raise exception using message = 'video_not_ai', errcode = 'P0001';
    end if;

    if v_phase1 then
      begin
        select paused into v_paused from agents where agent_key = 'video_build';
        if not found or v_paused then
          raise exception using message = 'queue_failure', errcode = 'P0001';
        end if;
        insert into agent_jobs (agent_key, client_id, input_table, input_id, params, created_by)
        values ('video_build', p_client_id, 'client_briefs', p_brief_id, '{}'::jsonb, null)
        returning id into v_job;
        insert into agent_job_events (job_id, description)
        values (
          v_job,
          'Queued by MCP content.assign_production for a reel. Motion stays paused. No Higgsfield request was sent.'
        );
      exception
        when raise_exception then
          raise exception using message = 'queue_failure', errcode = 'P0001';
        when others then
          raise exception using message = 'queue_failure', errcode = 'P0001';
      end;
      update client_briefs set status = 'in_production' where id = p_brief_id;
      v_result := jsonb_build_object(
        'client_id', p_client_id, 'brief_id', p_brief_id, 'route', 'ai',
        'agent_key', 'video_build', 'job_id', v_job, 'replayed', false
      );
    else
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
    end if;
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

comment on function mcp_internal.assign_production(text, text, text, uuid, uuid, text, uuid[], date, numeric, text, text, text) is
  'Approve & Build sibling. AI route queues video_build for a Phase 1 reel (F6, F7, or a reel with no later format code) and creative_build for stills. Other video is video_not_ai. Human route accepts p_brief_role. Does not call Higgsfield.';

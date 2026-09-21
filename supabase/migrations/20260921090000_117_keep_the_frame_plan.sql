-- Keep the frame plan the brief agent wrote.
--
-- 114 wrote frame_count and frame_plan unconditionally, which was correct
-- when Approve & Build was the only thing that could set them: blank boxes
-- meant "nobody has asked for anything", and writing null over null was a
-- no-op.
--
-- Since the brief agent started writing the plan itself, blank boxes are the
-- NORMAL case. The unconditional write turned "I have no particular opinion"
-- into "erase the eight-frame plan the agent just wrote" — silently, on the
-- click that spends money building it, with the frame breakdown then
-- reinvented from scratch by the renderer. Exactly the failure the plan
-- exists to prevent.
--
-- Three cases now: a typed plan wins outright; a typed count alone replaces
-- the count and clears the plan, because a plan of eight beside a count of
-- five is the disagreement the check constraint refuses; and nothing typed
-- leaves the brief alone.
--
-- Everything else in this function is byte-for-byte what 114 shipped.

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
begin
  if not is_admin() then
    raise exception 'Only an admin can build a brief.';
  end if;

  select id, client_id, media_type, content_format into v_brief
    from client_briefs where id = p_brief_id;
  if v_brief.id is null then raise exception 'That brief does not exist.'; end if;
  if v_brief.media_type = 'video' then
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
  'Admin-only. Queues an AI build for a brief. For a carousel or story it also records how many frames were asked for and, optionally, what each one is to do — written here rather than by a separate update so the ask and the job it governs land together.';

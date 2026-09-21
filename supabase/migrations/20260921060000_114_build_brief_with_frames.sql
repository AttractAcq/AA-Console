-- Saying how many frames at the moment you pay for them.
--
-- 113 gave client_briefs frame_count and frame_plan; nothing could set them.
-- Approve & Build is the right place to ask, because it is the click that
-- turns a carousel brief into five image calls — the one moment somebody is
-- actually deciding how long the thing should be.
--
-- Written through this function rather than by a separate update from the
-- console, so the ask and the job it governs land in one transaction. A
-- separate update could succeed while the build failed, leaving a brief
-- asking for five frames that nothing was ever queued to build.
--
-- The old four-argument signature is dropped rather than left beside this
-- one. Two overloads differing only by defaulted arguments is how PostgREST
-- starts guessing, and the console is the only caller of either.
--
-- The body below is the existing function with two additions: the frame
-- arguments are validated and written, and the queued event says how many
-- frames were asked for. Everything else — the admin check, the video
-- refusal, quality and size bounds, the reference-path ownership test, the
-- three inserts, the job_id back-writes, the status move — is unchanged.

drop function if exists build_brief_with_ai(uuid, text, text, text);

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

  update client_briefs
     set frame_count = v_count,
         frame_plan  = v_plan
   where id = p_brief_id;

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

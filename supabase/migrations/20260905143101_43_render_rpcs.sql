-- One job shape for both cases. The runner is handed a render, follows it to
-- its generation, and writes the concept only if that generation has none
-- yet. So a first build and a re-render are the same code path, and "already
-- has a concept" is the only difference between them.

create or replace function build_brief_with_ai(
  p_brief_id       uuid,
  p_quality        text default 'medium',
  p_size           text default '1024x1536',
  p_reference_path text default null
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
begin
  if not is_admin() then
    raise exception 'Only an admin can build a brief.';
  end if;

  select id, client_id, media_type into v_brief from client_briefs where id = p_brief_id;
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

  insert into agent_job_events (job_id, description)
  values (v_job_id, case when p_reference_path is null
                         then 'Queued from Approve & Build'
                         else 'Queued from Approve & Build, working from a reference image' end);
  return v_gen_id;
end;
$$;

-- ---------------------------------------------------------------------------

create or replace function rerender_generation(
  p_generation_id uuid,
  p_quality       text default 'medium',
  p_size          text default null
)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_gen       record;
  v_render_id uuid;
  v_job_id    uuid;
begin
  if not is_admin() then raise exception 'Only an admin can render.'; end if;
  if p_quality not in ('low','medium','high') then raise exception 'Quality must be low, medium or high.'; end if;

  select id, client_id, brief_id, media_type, size, reference_path, concept
    into v_gen from creative_generations where id = p_generation_id;
  if v_gen.id is null then raise exception 'That build does not exist.'; end if;
  if v_gen.media_type <> 'image' then
    raise exception 'Only an image build can be rendered again.';
  end if;
  -- The whole point is to skip the expensive stage, so there has to be
  -- something to skip.
  if v_gen.concept is null then
    raise exception 'This build has no concept yet — there is nothing to render from.';
  end if;
  if coalesce(p_size, v_gen.size) not in ('1024x1536','1024x1024','1536x1024') then
    raise exception 'Unsupported image size.';
  end if;

  insert into creative_renders (generation_id, client_id, quality, size, reference_path, created_by)
  values (v_gen.id, v_gen.client_id, p_quality, coalesce(p_size, v_gen.size), v_gen.reference_path, auth.uid())
  returning id into v_render_id;

  insert into agent_jobs (agent_key, client_id, params, created_by)
  values ('creative_build', v_gen.client_id,
          jsonb_build_object('render_id', v_render_id), auth.uid())
  returning id into v_job_id;

  update creative_renders set job_id = v_job_id where id = v_render_id;
  insert into agent_job_events (job_id, description)
  values (v_job_id, 'Re-rendering an existing concept at ' || p_quality || ' quality');

  return v_render_id;
end;
$$;

-- ---------------------------------------------------------------------------

create or replace function update_generation_concept(
  p_generation_id uuid,
  p_concept       jsonb
)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if not is_admin() then raise exception 'Only an admin can edit a concept.'; end if;
  if p_concept is null or jsonb_typeof(p_concept) <> 'object' then
    raise exception 'A concept must be an object.';
  end if;

  update creative_generations
     set concept = p_concept,
         concept_edited_at = now(),
         updated_at = now()
   where id = p_generation_id;

  if not found then raise exception 'That build does not exist.'; end if;
end;
$$;

-- ---------------------------------------------------------------------------

create or replace function select_render(p_render_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare v_gen uuid;
begin
  if not is_admin() then raise exception 'Only an admin can select a render.'; end if;

  select generation_id into v_gen from creative_renders where id = p_render_id;
  if v_gen is null then raise exception 'That render does not exist.'; end if;

  -- One pick per concept: selecting a new one clears the old.
  update creative_renders set selected = false, updated_at = now()
   where generation_id = v_gen and selected;
  update creative_renders set selected = true, updated_at = now()
   where id = p_render_id;
end;
$$;

revoke all on function rerender_generation(uuid, text, text) from public, anon;
revoke all on function update_generation_concept(uuid, jsonb) from public, anon;
revoke all on function select_render(uuid) from public, anon;
grant execute on function rerender_generation(uuid, text, text) to authenticated, service_role;
grant execute on function update_generation_concept(uuid, jsonb) to authenticated, service_role;
grant execute on function select_render(uuid) to authenticated, service_role;;

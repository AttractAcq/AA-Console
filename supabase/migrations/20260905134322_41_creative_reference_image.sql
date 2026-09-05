-- Build from a reference image.
--
-- A brief often has a starting point that is not describable — the client's
-- own product shot, a rough layout, a photograph from a shoot. Describing it
-- in words and hoping the renderer reconstructs it is strictly worse than
-- handing it over, so a build can now carry one.
--
-- The path is stored rather than the bytes: the file already lives in
-- client-media, whose RLS is written against the client-id prefix, and
-- copying it into a row would put the same image in two places with two
-- different access rules.

alter table creative_generations
  add column reference_path text;

comment on column creative_generations.reference_path is
  'Optional storage path in client-media for an image the render works from, rather than generating from the prompt alone.';

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
  if p_reference_path is not null and v_brief.media_type <> 'image' then
    raise exception 'A reference image only applies to an image build.';
  end if;
  -- Storage access is enforced by path prefix, so a reference from another
  -- client's folder must be refused here rather than trusted from the UI.
  if p_reference_path is not null
     and p_reference_path not like (v_brief.client_id::text || '/%') then
    raise exception 'That reference image does not belong to this client.';
  end if;

  insert into creative_generations
    (client_id, brief_id, media_type, quality, size, reference_path, created_by)
  values
    (v_brief.client_id, p_brief_id, v_brief.media_type, p_quality, p_size, p_reference_path, auth.uid())
  returning id into v_gen_id;

  insert into agent_jobs (agent_key, client_id, params, created_by)
  values ('creative_build', v_brief.client_id,
          jsonb_build_object('generation_id', v_gen_id), auth.uid())
  returning id into v_job_id;

  update creative_generations set job_id = v_job_id where id = v_gen_id;
  update client_briefs set status = 'in_production' where id = p_brief_id;

  insert into agent_job_events (job_id, description)
  values (v_job_id, case when p_reference_path is null
                         then 'Queued from Approve & Build'
                         else 'Queued from Approve & Build, working from a reference image' end);

  return v_gen_id;
end;
$$;

-- The old 3-argument signature would otherwise linger and shadow this one.
drop function if exists build_brief_with_ai(uuid, text, text);

revoke all on function build_brief_with_ai(uuid, text, text, text) from public, anon;
grant execute on function build_brief_with_ai(uuid, text, text, text) to authenticated, service_role;;

-- Queue one paused render job only after every scene and optional music
-- outcome is terminal. The worker's claim still gates every Lambda start.
create unique index video_render_job_project_version_v1
  on public.agent_jobs(input_id,(params->>'ir_version'))
  where agent_key='video_render' and input_table='video_projects';

create function public.queue_video_render_v1(
  p_project_id uuid,p_ir_version integer
) returns uuid language plpgsql volatile security definer
set search_path=pg_catalog,public as $$
declare p public.video_projects%rowtype;
  j public.agent_jobs%rowtype;
  v_job uuid;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Service video render queue only.' using errcode='42501'; end if;
  select * into p from public.video_projects where id=p_project_id for update;
  if p.id is null or p.stage is distinct from 'timed'
    or p.ir_version is distinct from p_ir_version
    or not public.video_project_source_current_v1(p.id)
    or not public.complete_video_audio_project_v1(p.id,p_ir_version) then
    raise exception 'Render queue requires exact complete audio and source.'
      using errcode='23514'; end if;
  select * into j from public.agent_jobs where agent_key='video_render'
    and input_table='video_projects' and input_id=p.id
    and client_id=p.client_id
    and params->>'ir_version'=p_ir_version::text;
  if j.id is not null then return j.id; end if;
  insert into public.agent_jobs(agent_key,client_id,input_table,input_id,
    created_by,params)
  values('video_render',p.client_id,'video_projects',p.id,p.started_by,
    jsonb_build_object('ir_version',p_ir_version,
      'aspects',to_jsonb(p.aspects))) returning id into v_job;
  insert into public.agent_job_events(job_id,description,payload)
  values(v_job,'Queued: exact code-rendered video',
    jsonb_build_object('project_id',p.id,'ir_version',p_ir_version,
      'aspects',to_jsonb(p.aspects)));
  return v_job;
end $$;
revoke all on function public.queue_video_render_v1(uuid,integer)
  from public,anon,authenticated,service_role;
grant execute on function public.queue_video_render_v1(uuid,integer)
  to service_role;

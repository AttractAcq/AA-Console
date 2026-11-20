-- Reviewed storyboards advance to per-scene narration jobs. The new agent is
-- paused; queued jobs cannot be claimed until its worker and provider gates
-- are separately released. Failed independent reviews stay in human review.
insert into public.agents(agent_key,name,initials,domain,description,
  requires_upstream,paused)
values ('video_audio','Video audio','VA','content_production',
  'Synthesizes and verifies one exact code-rendered video scene.',
  '{}'::text[],true);
create unique index video_audio_job_scene_version_v1
  on public.agent_jobs(input_id,(params->>'ir_version'))
  where agent_key='video_audio' and input_table='video_scenes';

create table public.video_scene_audio_attempts_v1 (
  scene_id uuid primary key references public.video_scenes(id) on delete cascade,
  project_id uuid not null,
  client_id uuid not null,
  job_id uuid not null references public.agent_jobs(id),
  ir_version integer not null check (ir_version>0),
  state text not null default 'started' check (state in ('started','filed')),
  started_at timestamptz not null default clock_timestamp(),
  filed_at timestamptz,
  foreign key (project_id,client_id) references public.video_projects(id,client_id),
  check ((state='started' and filed_at is null)
    or (state='filed' and filed_at is not null))
);
alter table public.video_scene_audio_attempts_v1 enable row level security;
create policy video_scene_audio_attempts_read_v1
  on public.video_scene_audio_attempts_v1 for select to authenticated
  using (public.can_access_client(client_id));
revoke all on public.video_scene_audio_attempts_v1
  from public,anon,authenticated,service_role;
grant select on public.video_scene_audio_attempts_v1 to authenticated,service_role;

create function public.queue_video_audio_v1(
  p_project_id uuid,p_script_job_id uuid,p_ir_version integer
) returns integer language plpgsql volatile security definer
set search_path=pg_catalog,public as $$
declare p public.video_projects%rowtype;
  s public.video_scenes%rowtype;
  entry jsonb;
  v_count integer:=0;
  v_job uuid;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Service video audio queue only.' using errcode='42501'; end if;
  select * into p from public.video_projects where id=p_project_id for update;
  if p.id is null or p.job_id is distinct from p_script_job_id
    or p.ir_version is distinct from p_ir_version
    or p.script->'independent_review'->>'accepted' is distinct from 'true'
    or p.ir is null or p.source_digest is null
    or p.stage not in ('needs_human','timing') then
    raise exception 'Audio queue requires the exact accepted storyboard.'
      using errcode='23514'; end if;
  if p.stage='timing' then
    select count(*) into v_count from public.agent_jobs j
      join public.video_scenes scene_join on scene_join.id=j.input_id
      where scene_join.project_id=p.id and j.agent_key='video_audio'
        and j.input_table='video_scenes'
        and j.client_id=p.client_id
        and j.params->>'ir_version'=p.ir_version::text;
    if v_count<>(select count(*) from public.video_scenes where project_id=p.id)
      or v_count<3 or exists(
        select 1 from public.video_scenes scene where scene.project_id=p.id
          and not exists(select 1 from public.agent_jobs j
            where j.agent_key='video_audio' and j.input_table='video_scenes'
              and j.input_id=scene.id and j.client_id=p.client_id
              and j.params->>'ir_version'=p.ir_version::text)) then
      raise exception 'Audio queue is incomplete; inspect before retry.'
        using errcode='23514'; end if;
    return v_count;
  end if;
  if (select count(*) from public.video_scenes where project_id=p.id)
    is distinct from jsonb_array_length(p.ir->'scenes') then
    raise exception 'Storyboard scenes are incomplete.' using errcode='23514'; end if;
  -- Lock mutable sources before rechecking their approved current version.
  if p.brief_id is not null then
    perform 1 from public.client_briefs where id=p.brief_id
      and client_id=p.client_id for share;
    if not found then raise exception 'Video brief disappeared.' using errcode='23514'; end if;
  end if;
  if p.route_package_id is not null then
    perform 1 from public.client_campaigns where id=p.campaign_id
      and client_id=p.client_id for share;
    if not found then raise exception 'Video campaign disappeared.' using errcode='23514'; end if;
    perform 1 from public.campaign_route_packages_v6
      where id=p.route_package_id and client_id=p.client_id for share;
    if not found then raise exception 'Video route disappeared.' using errcode='23514'; end if;
  end if;
  for entry in select value from jsonb_array_elements(p.source_snapshot) loop
    if entry->>'kind'='operator' then continue; end if;
    perform 1 from public.client_agent_records
      where id=(entry->>'id')::uuid and client_id=p.client_id for share;
    if not found then raise exception 'Video source disappeared.' using errcode='23514'; end if;
  end loop;
  -- The source checker covers timing but intentionally excludes a human hold.
  -- A failed check rolls this transition and every queued job back together.
  update public.video_projects set stage='timing',stage_error=null where id=p.id;
  if not public.video_project_source_current_v1(p.id) then
    raise exception 'Video source or campaign route is no longer current.'
      using errcode='23514'; end if;
  for s in select * from public.video_scenes where project_id=p.id
    order by position for update loop
    if s.audio_path is not null or s.alignment is not null
      or s.duration_sec is not null then
      raise exception 'Scene audio already exists before queue.'
        using errcode='23514'; end if;
    insert into public.agent_jobs(agent_key,client_id,input_table,input_id,
      created_by,params)
    values('video_audio',p.client_id,'video_scenes',s.id,p.started_by,
      jsonb_build_object('project_id',p.id,'ir_version',p.ir_version,
        'scene_key',s.scene_key,'narration_sha256',
        encode(sha256(convert_to(s.narration,'UTF8')),'hex')))
    returning id into v_job;
    insert into public.agent_job_events(job_id,description,payload)
    values(v_job,'Queued: synthesize exact video scene audio',
      jsonb_build_object('project_id',p.id,'ir_version',p.ir_version,
        'scene_key',s.scene_key));
    v_count:=v_count+1;
  end loop;
  return v_count;
end $$;
revoke all on function public.queue_video_audio_v1(uuid,uuid,integer)
  from public,anon,authenticated,service_role;
grant execute on function public.queue_video_audio_v1(uuid,uuid,integer)
  to service_role;

create function public.video_scene_audio_storage_exists_v1(
  p_project_id uuid,p_scene_id uuid
) returns boolean language plpgsql volatile security definer
set search_path=pg_catalog,public,storage as $$
declare target jsonb;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Service video audio inspection only.' using errcode='42501'; end if;
  target:=public.video_scene_audio_upload_target_v1(p_project_id,p_scene_id);
  return exists(select 1 from storage.objects
    where bucket_id='client-media' and name=target->>'storage_path');
end $$;
revoke all on function public.video_scene_audio_storage_exists_v1(uuid,uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.video_scene_audio_storage_exists_v1(uuid,uuid)
  to service_role;

create function public.begin_video_scene_audio_attempt_v1(
  p_project_id uuid,p_scene_id uuid,p_job_id uuid,p_ir_version integer
) returns boolean language plpgsql volatile security definer
set search_path=pg_catalog,public,storage as $$
declare target jsonb;
  j public.agent_jobs%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Service video audio attempt only.' using errcode='42501'; end if;
  target:=public.video_scene_audio_upload_target_v1(p_project_id,p_scene_id);
  select * into j from public.agent_jobs where id=p_job_id;
  if (target->>'ir_version')::integer is distinct from p_ir_version
    or j.id is null or j.agent_key is distinct from 'video_audio'
    or j.client_id::text is distinct from target->>'client_id'
    or j.input_table is distinct from 'video_scenes'
    or j.input_id is distinct from p_scene_id
    or j.params->>'project_id' is distinct from p_project_id::text
    or j.params->>'ir_version' is distinct from p_ir_version::text
    or j.params->>'scene_key' is distinct from target->>'scene_key'
    or j.params->>'narration_sha256' is distinct from target->>'narration_sha256'
    or exists(select 1 from public.video_scene_audio_receipts_v1
      where scene_id=p_scene_id)
    or exists(select 1 from storage.objects
      where bucket_id='client-media' and name=target->>'storage_path') then
    raise exception 'Audio attempt no longer matches an empty exact scene.'
      using errcode='23514'; end if;
  insert into public.video_scene_audio_attempts_v1
    (scene_id,project_id,client_id,job_id,ir_version)
  values(p_scene_id,p_project_id,(target->>'client_id')::uuid,p_job_id,p_ir_version)
  on conflict(scene_id) do nothing;
  if not found then
    raise exception 'Audio attempt already started; reconcile before retry.'
      using errcode='23514'; end if;
  return true;
end $$;
revoke all on function public.begin_video_scene_audio_attempt_v1(uuid,uuid,uuid,integer)
  from public,anon,authenticated,service_role;
grant execute on function public.begin_video_scene_audio_attempt_v1(uuid,uuid,uuid,integer)
  to service_role;

create function public.complete_video_audio_project_v1(
  p_project_id uuid,p_ir_version integer
) returns boolean language plpgsql volatile security definer
set search_path=pg_catalog,public,storage as $$
declare p public.video_projects%rowtype;
  s public.video_scenes%rowtype;
  receipt public.video_scene_audio_receipts_v1%rowtype;
  attempt public.video_scene_audio_attempts_v1%rowtype;
  o storage.objects%rowtype;
  v_count integer:=0;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Service video audio completion only.' using errcode='42501'; end if;
  select * into p from public.video_projects where id=p_project_id for update;
  if p.id is null or p.ir_version is distinct from p_ir_version
    or p.stage not in ('timing','timed')
    or not public.video_project_source_current_v1(p.id) then
    raise exception 'Video audio project is no longer current.' using errcode='23514'; end if;
  for s in select * from public.video_scenes where project_id=p.id
    order by position for share loop
    select * into receipt from public.video_scene_audio_receipts_v1
      where scene_id=s.id;
    if receipt.scene_id is null then return false; end if;
    select * into attempt from public.video_scene_audio_attempts_v1
      where scene_id=s.id;
    select * into o from storage.objects
      where bucket_id='client-media' and name=receipt.storage_path;
    if receipt.project_id is distinct from p.id
      or receipt.client_id is distinct from p.client_id
      or receipt.ir_version is distinct from p.ir_version
      or receipt.narration_sha256 is distinct from
        encode(sha256(convert_to(s.narration,'UTF8')),'hex')
      or receipt.storage_path is distinct from s.audio_path
      or receipt.alignment is distinct from s.alignment
      or receipt.duration_sec is distinct from s.duration_sec
      or attempt.scene_id is null or attempt.project_id is distinct from p.id
      or attempt.client_id is distinct from p.client_id
      or attempt.ir_version is distinct from p.ir_version
      or o.id is null or o.id is distinct from receipt.object_id
      or o.version is distinct from receipt.object_version
      or o.updated_at is distinct from receipt.object_updated_at then
      raise exception 'Scene audio evidence changed before completion.'
        using errcode='23514'; end if;
    update public.video_scene_audio_attempts_v1 set state='filed',
      filed_at=coalesce(filed_at,clock_timestamp())
      where scene_id=s.id and project_id=p.id
        and ir_version=p.ir_version and state='started';
    v_count:=v_count+1;
  end loop;
  if v_count<3 or v_count<>(select jsonb_array_length(p.ir->'scenes')) then
    raise exception 'Video audio scene count differs from the IR.'
      using errcode='23514'; end if;
  if p.stage='timing' then
    update public.video_projects set stage='timed',
      stage_error='Audio verified; render and final human review pending.'
      where id=p.id;
  end if;
  return true;
end $$;
revoke all on function public.complete_video_audio_project_v1(uuid,integer)
  from public,anon,authenticated,service_role;
grant execute on function public.complete_video_audio_project_v1(uuid,integer)
  to service_role;

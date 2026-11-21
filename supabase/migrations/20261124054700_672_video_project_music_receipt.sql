-- Music is optional, but its outcome is a durable, exact-IR decision before
-- the project becomes timed. The scene agent remains paused by default.
create table public.video_project_music_attempts_v1 (
  project_id uuid primary key references public.video_projects(id) on delete cascade,
  client_id uuid not null,
  job_id uuid not null references public.agent_jobs(id),
  ir_version integer not null check (ir_version>0),
  state text not null check (state in ('started','filed','failed','skipped')),
  requested boolean not null,
  enabled boolean not null,
  prompt text,
  requested_ms integer check (requested_ms is null or requested_ms between 3000 and 300000),
  failure_code text,
  created_at timestamptz not null default clock_timestamp(),
  finished_at timestamptz,
  foreign key (project_id,client_id) references public.video_projects(id,client_id)
    on delete cascade,
  check ((state='started' and requested and enabled and prompt is not null
      and requested_ms is not null and failure_code is null and finished_at is null)
    or (state='filed' and requested and enabled and prompt is not null
      and requested_ms is not null and failure_code is null and finished_at is not null)
    or (state='failed' and requested and enabled and prompt is not null
      and requested_ms is not null and failure_code is not null and finished_at is not null)
    or (state='skipped' and (not requested or not enabled)
      and failure_code is not null and finished_at is not null))
);
alter table public.video_project_music_attempts_v1 enable row level security;
create policy video_project_music_attempts_read_v1
  on public.video_project_music_attempts_v1 for select to authenticated
  using (public.can_access_client(client_id));
revoke all on public.video_project_music_attempts_v1
  from public,anon,authenticated,service_role;
grant select on public.video_project_music_attempts_v1 to authenticated,service_role;

create table public.video_project_music_receipts_v1 (
  project_id uuid primary key references public.video_projects(id) on delete cascade,
  client_id uuid not null,
  ir_version integer not null check (ir_version>0),
  storage_path text not null unique,
  audio_sha256 text not null check (audio_sha256 ~ '^[0-9a-f]{64}$'),
  file_bytes bigint not null check (file_bytes>100),
  object_id uuid not null,
  object_version text,
  object_updated_at timestamptz not null,
  duration_sec numeric(7,2) not null check (duration_sec between 3 and 301),
  measured_lufs numeric(5,2) not null check (measured_lufs between -25 and -23),
  prompt text not null,
  song_id text,
  requested_ms integer not null check (requested_ms between 3000 and 300000),
  created_at timestamptz not null default clock_timestamp(),
  foreign key (project_id,client_id) references public.video_projects(id,client_id)
    on delete cascade
);
alter table public.video_project_music_receipts_v1 enable row level security;
create policy video_project_music_receipts_read_v1
  on public.video_project_music_receipts_v1 for select to authenticated
  using (public.can_access_client(client_id));
revoke all on public.video_project_music_receipts_v1
  from public,anon,authenticated,service_role;
grant select on public.video_project_music_receipts_v1 to authenticated,service_role;

-- Preserve all scene/Storage checks from 670. Scene completion now waits for
-- a terminal music outcome before changing the project stage.
create or replace function public.complete_video_audio_project_v1(
  p_project_id uuid,p_ir_version integer
) returns boolean language plpgsql volatile security definer
set search_path=pg_catalog,public,storage as $$
declare p public.video_projects%rowtype;
  s public.video_scenes%rowtype;
  receipt public.video_scene_audio_receipts_v1%rowtype;
  attempt public.video_scene_audio_attempts_v1%rowtype;
  music public.video_project_music_attempts_v1%rowtype;
  music_receipt public.video_project_music_receipts_v1%rowtype;
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
  select * into music from public.video_project_music_attempts_v1
    where project_id=p.id;
  if music.project_id is null or music.state='started' then return true; end if;
  if music.client_id is distinct from p.client_id
    or music.ir_version is distinct from p.ir_version
    or music.requested is distinct from
      ((p.ir->'music'->>'enabled')::boolean) then
    raise exception 'Music outcome differs from the current IR.' using errcode='23514'; end if;
  if music.state='filed' then
    select * into music_receipt from public.video_project_music_receipts_v1
      where project_id=p.id;
    select * into o from storage.objects
      where bucket_id='client-media' and name=music_receipt.storage_path;
    if music_receipt.project_id is null
      or music_receipt.client_id is distinct from p.client_id
      or music_receipt.ir_version is distinct from p.ir_version
      or music_receipt.storage_path is distinct from p.music_path
      or music_receipt.prompt is distinct from p.music_prompt
      or music_receipt.requested_ms is distinct from music.requested_ms
      or o.id is null or o.id is distinct from music_receipt.object_id
      or o.version is distinct from music_receipt.object_version
      or o.updated_at is distinct from music_receipt.object_updated_at then
      raise exception 'Music Storage evidence changed before completion.'
        using errcode='23514'; end if;
  elsif p.music_path is not null or p.music_prompt is not null
    or exists(select 1 from public.video_project_music_receipts_v1
      where project_id=p.id) then
    raise exception 'Narration-only music outcome has an attached file.'
      using errcode='23514';
  end if;
  if p.stage='timing' then
    update public.video_projects set stage='timed',
      stage_error=case when music.state='filed' then
        'Audio and optional music verified; render and final review pending.'
        when music.state='failed' then
        'Narration ready; optional music failed: '||music.failure_code
        else 'Narration ready; optional music skipped.' end
      where id=p.id;
  end if;
  return true;
end $$;

create function public.begin_video_project_music_v1(
  p_project_id uuid,p_job_id uuid,p_ir_version integer,
  p_enabled boolean,p_prompt text,p_requested_ms integer
) returns jsonb language plpgsql volatile security definer
set search_path=pg_catalog,public as $$
declare p public.video_projects%rowtype;
  j public.agent_jobs%rowtype;
  s public.video_scenes%rowtype;
  prior public.video_project_music_attempts_v1%rowtype;
  v_requested boolean;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Service video music attempt only.' using errcode='42501'; end if;
  select * into p from public.video_projects where id=p_project_id for update;
  select * into j from public.agent_jobs where id=p_job_id;
  select * into s from public.video_scenes where id=j.input_id;
  if p.id is null or p.stage is distinct from 'timing'
    or p.ir_version is distinct from p_ir_version
    or j.agent_key is distinct from 'video_audio'
    or j.input_table is distinct from 'video_scenes'
    or j.client_id is distinct from p.client_id
    or j.params->>'project_id' is distinct from p.id::text
    or j.params->>'ir_version' is distinct from p_ir_version::text
    or s.project_id is distinct from p.id or s.client_id is distinct from p.client_id
    or not public.video_project_source_current_v1(p.id)
    or not public.complete_video_audio_project_v1(p.id,p_ir_version) then
    raise exception 'Music attempt requires complete current scene audio.'
      using errcode='23514'; end if;
  select * into prior from public.video_project_music_attempts_v1
    where project_id=p.id;
  if prior.project_id is not null then
    return jsonb_build_object('state','already_'||prior.state);
  end if;
  v_requested:=(p.ir->'music'->>'enabled')::boolean;
  if v_requested is null or p_enabled is null then
    raise exception 'Music flags are invalid.' using errcode='22023'; end if;
  if not v_requested or not p_enabled then
    insert into public.video_project_music_attempts_v1
      (project_id,client_id,job_id,ir_version,state,requested,enabled,
       failure_code,finished_at)
    values(p.id,p.client_id,j.id,p.ir_version,'skipped',v_requested,p_enabled,
      case when v_requested then 'disabled' else 'not_requested' end,
      clock_timestamp());
    return jsonb_build_object('state','skipped');
  end if;
  if p_prompt is null or length(btrim(p_prompt)) not between 10 and 4100
    or p_requested_ms is null or p_requested_ms not between 3000 and 300000 then
    raise exception 'Music prompt or duration is invalid.' using errcode='22023'; end if;
  insert into public.video_project_music_attempts_v1
    (project_id,client_id,job_id,ir_version,state,requested,enabled,
     prompt,requested_ms)
  values(p.id,p.client_id,j.id,p.ir_version,'started',true,true,
    btrim(p_prompt),p_requested_ms);
  update public.video_projects set
    stage_error='Optional music is in progress; reconcile a stalled attempt before retry.'
    where id=p.id;
  return jsonb_build_object('state','started');
end $$;
revoke all on function public.begin_video_project_music_v1(
  uuid,uuid,integer,boolean,text,integer)
  from public,anon,authenticated,service_role;
grant execute on function public.begin_video_project_music_v1(
  uuid,uuid,integer,boolean,text,integer) to service_role;

create function public.record_video_project_music_cost_v1(
  p_project_id uuid,p_job_id uuid,p_ir_version integer,
  p_requested_ms integer,p_usd numeric
) returns uuid language plpgsql volatile security definer
set search_path=pg_catalog,public as $$
declare p public.video_projects%rowtype;
  a public.video_project_music_attempts_v1%rowtype;
  saved public.video_project_costs%rowtype;
  v_key text;
  v_id uuid;
  v_units numeric(14,4);
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Service music cost only.' using errcode='42501'; end if;
  select * into p from public.video_projects where id=p_project_id for update;
  select * into a from public.video_project_music_attempts_v1
    where project_id=p_project_id;
  if p.id is null or a.project_id is null or p.stage is distinct from 'timing'
    or p.ir_version is distinct from p_ir_version
    or a.client_id is distinct from p.client_id
    or a.ir_version is distinct from p_ir_version
    or a.job_id is distinct from p_job_id or a.state is distinct from 'started'
    or a.requested_ms is distinct from p_requested_ms
    or not public.video_project_source_current_v1(p.id) then
    raise exception 'Music cost is not bound to a current attempt.'
      using errcode='23514'; end if;
  v_units:=p_requested_ms::numeric/1000;
  if p_usd is distinct from round(v_units*0.15/60,6) then
    raise exception 'Music cost estimate does not match the reviewed rate.'
      using errcode='22023'; end if;
  v_key:='video-music:'||p.id::text||':v'||p_ir_version::text;
  insert into public.video_project_costs(project_id,client_id,job_id,stage,
    provider,units,unit,usd,attempt_key)
  values(p.id,p.client_id,p_job_id,'music','eleven_music_estimate',
    v_units,'seconds',p_usd,v_key)
  on conflict(attempt_key) do nothing returning id into v_id;
  if v_id is null then
    select * into saved from public.video_project_costs where attempt_key=v_key;
    if saved.id is null or saved.project_id is distinct from p.id
      or saved.client_id is distinct from p.client_id
      or saved.job_id is distinct from p_job_id
      or saved.provider is distinct from 'eleven_music_estimate'
      or saved.units is distinct from v_units or saved.unit is distinct from 'seconds'
      or saved.usd is distinct from p_usd then
      raise exception 'Music cost key was reused with different evidence.'
        using errcode='23514'; end if;
    return saved.id;
  end if;
  update public.video_projects set cost_usd=cost_usd+p_usd where id=p.id;
  return v_id;
end $$;
revoke all on function public.record_video_project_music_cost_v1(
  uuid,uuid,integer,integer,numeric)
  from public,anon,authenticated,service_role;
grant execute on function public.record_video_project_music_cost_v1(
  uuid,uuid,integer,integer,numeric) to service_role;

create function public.video_project_music_storage_identity_v1(
  p_project_id uuid,p_ir_version integer
) returns jsonb language plpgsql volatile security definer
set search_path=pg_catalog,public,storage as $$
declare p public.video_projects%rowtype;
  a public.video_project_music_attempts_v1%rowtype;
  o storage.objects%rowtype;
  v_path text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Service music Storage identity only.' using errcode='42501'; end if;
  select * into p from public.video_projects where id=p_project_id;
  select * into a from public.video_project_music_attempts_v1
    where project_id=p_project_id;
  if p.id is null or p.stage is distinct from 'timing'
    or p.ir_version is distinct from p_ir_version
    or a.state is distinct from 'started'
    or a.ir_version is distinct from p_ir_version
    or not public.video_project_source_current_v1(p.id) then
    raise exception 'Music Storage target is no longer current.'
      using errcode='23514'; end if;
  v_path:=p.client_id::text||'/video/projects/'||p.id::text||
    '/ir-v'||p_ir_version::text||'/music.mp3';
  select * into o from storage.objects where bucket_id='client-media'
    and name=v_path;
  if o.id is null then
    raise exception 'Music Storage file is absent.' using errcode='23514'; end if;
  return jsonb_build_object('client_id',p.client_id,'project_id',p.id,
    'ir_version',p.ir_version,'storage_path',v_path,
    'object_id',o.id,'object_version',o.version,
    'object_updated_at',o.updated_at);
end $$;
revoke all on function public.video_project_music_storage_identity_v1(uuid,integer)
  from public,anon,authenticated,service_role;
grant execute on function public.video_project_music_storage_identity_v1(uuid,integer)
  to service_role;

create function public.video_project_music_storage_exists_v1(
  p_project_id uuid,p_ir_version integer
) returns boolean language plpgsql volatile security definer
set search_path=pg_catalog,public,storage as $$
declare p public.video_projects%rowtype;
  a public.video_project_music_attempts_v1%rowtype;
  v_path text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Service music Storage preflight only.' using errcode='42501'; end if;
  select * into p from public.video_projects where id=p_project_id;
  select * into a from public.video_project_music_attempts_v1
    where project_id=p_project_id;
  if p.id is null or p.stage is distinct from 'timing'
    or p.ir_version is distinct from p_ir_version
    or a.state is distinct from 'started'
    or a.ir_version is distinct from p_ir_version
    or not public.video_project_source_current_v1(p.id) then
    raise exception 'Music Storage preflight is no longer current.'
      using errcode='23514'; end if;
  v_path:=p.client_id::text||'/video/projects/'||p.id::text||
    '/ir-v'||p_ir_version::text||'/music.mp3';
  return exists(select 1 from storage.objects
    where bucket_id='client-media' and name=v_path);
end $$;
revoke all on function public.video_project_music_storage_exists_v1(uuid,integer)
  from public,anon,authenticated,service_role;
grant execute on function public.video_project_music_storage_exists_v1(uuid,integer)
  to service_role;

create function public.commit_video_project_music_v1(
  p_project_id uuid,p_job_id uuid,p_ir_version integer,
  p_storage_path text,p_audio_sha256 text,p_file_bytes bigint,
  p_object_id uuid,p_object_version text,p_object_updated_at timestamptz,
  p_duration_sec numeric,p_measured_lufs numeric,p_prompt text,
  p_song_id text,p_requested_ms integer
) returns uuid language plpgsql volatile security definer
set search_path=pg_catalog,public,storage as $$
declare p public.video_projects%rowtype;
  a public.video_project_music_attempts_v1%rowtype;
  o storage.objects%rowtype;
  v_path text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Service music commit only.' using errcode='42501'; end if;
  select * into p from public.video_projects where id=p_project_id for update;
  select * into a from public.video_project_music_attempts_v1
    where project_id=p_project_id for update;
  v_path:=p.client_id::text||'/video/projects/'||p.id::text||
    '/ir-v'||p_ir_version::text||'/music.mp3';
  if p.id is null or p.stage is distinct from 'timing'
    or p.ir_version is distinct from p_ir_version
    or a.state is distinct from 'started'
    or a.client_id is distinct from p.client_id
    or a.ir_version is distinct from p_ir_version
    or a.job_id is distinct from p_job_id
    or p_storage_path is distinct from v_path
    or p_audio_sha256 !~ '^[0-9a-f]{64}$'
    or p_file_bytes is null or p_file_bytes<=100
    or p_duration_sec is null or p_duration_sec not between 3 and 301
    or p_measured_lufs is null or p_measured_lufs not between -25 and -23
    or p_prompt is distinct from a.prompt
    or p_requested_ms is distinct from a.requested_ms
    or (p_song_id is not null and length(p_song_id)>200)
    or p.music_path is not null or p.music_prompt is not null
    or not exists(select 1 from public.video_project_costs cost
      where cost.attempt_key='video-music:'||p.id::text||':v'||p_ir_version::text)
    or not public.video_project_source_current_v1(p.id) then
    raise exception 'Music identity, cost or source is invalid.'
      using errcode='23514'; end if;
  select * into o from storage.objects where bucket_id='client-media'
    and name=v_path;
  if o.id is null or o.id is distinct from p_object_id
    or o.version is distinct from p_object_version
    or o.updated_at is distinct from p_object_updated_at then
    raise exception 'Music Storage object changed before commit.'
      using errcode='23514'; end if;
  insert into public.video_project_music_receipts_v1
    (project_id,client_id,ir_version,storage_path,audio_sha256,
     file_bytes,object_id,object_version,object_updated_at,
     duration_sec,measured_lufs,prompt,song_id,requested_ms)
  values(p.id,p.client_id,p_ir_version,v_path,p_audio_sha256,
    p_file_bytes,o.id,o.version,o.updated_at,p_duration_sec,
    p_measured_lufs,p_prompt,p_song_id,p_requested_ms);
  update public.video_projects set music_path=v_path,music_prompt=p_prompt
    where id=p.id;
  update public.video_project_music_attempts_v1 set state='filed',
    finished_at=clock_timestamp() where project_id=p.id;
  return p.id;
end $$;
revoke all on function public.commit_video_project_music_v1(
  uuid,uuid,integer,text,text,bigint,uuid,text,timestamptz,
  numeric,numeric,text,text,integer)
  from public,anon,authenticated,service_role;
grant execute on function public.commit_video_project_music_v1(
  uuid,uuid,integer,text,text,bigint,uuid,text,timestamptz,
  numeric,numeric,text,text,integer) to service_role;

create function public.fail_video_project_music_v1(
  p_project_id uuid,p_job_id uuid,p_ir_version integer,p_code text
) returns boolean language plpgsql volatile security definer
set search_path=pg_catalog,public as $$
declare p public.video_projects%rowtype;
  a public.video_project_music_attempts_v1%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Service music failure only.' using errcode='42501'; end if;
  if p_code not in ('credentials','provider','invalid_media','storage','cost','unknown') then
    raise exception 'Music failure code is invalid.' using errcode='22023'; end if;
  select * into p from public.video_projects where id=p_project_id for update;
  select * into a from public.video_project_music_attempts_v1
    where project_id=p_project_id for update;
  if p.id is null or p.stage is distinct from 'timing'
    or p.ir_version is distinct from p_ir_version
    or a.state is distinct from 'started'
    or a.job_id is distinct from p_job_id
    or not public.video_project_source_current_v1(p.id) then
    raise exception 'Music failure does not match a current attempt.'
      using errcode='23514'; end if;
  update public.video_project_music_attempts_v1 set state='failed',
    failure_code=p_code,finished_at=clock_timestamp()
    where project_id=p.id;
  return true;
end $$;
revoke all on function public.fail_video_project_music_v1(uuid,uuid,integer,text)
  from public,anon,authenticated,service_role;
grant execute on function public.fail_video_project_music_v1(uuid,uuid,integer,text)
  to service_role;

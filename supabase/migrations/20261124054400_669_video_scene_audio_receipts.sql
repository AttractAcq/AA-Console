-- Bind a verified, immutable audio file to one exact IR scene. The audio
-- worker remains disabled; this is the durable contract for its later filing.
-- The source check previously covered only the writer's queued/scripting
-- states. Retain all its source/route checks through the timing stage.
create or replace function public.video_project_source_current_v1(p_project_id uuid)
returns boolean language plpgsql volatile security definer
set search_path=pg_catalog,public as $$
declare p public.video_projects%rowtype;
  c public.client_campaigns%rowtype;
  route public.campaign_route_packages_v6%rowtype;
  entry jsonb; state record;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Service video source check only.' using errcode='42501'; end if;
  select * into p from public.video_projects where id=p_project_id;
  if not found or p.stage not in ('queued','scripting','timing','timed')
    or p.job_id is null
    or p.source_digest is distinct from
      encode(sha256(convert_to(p.source_snapshot::text,'UTF8')),'hex') then
    return false; end if;
  if p.brief_id is not null and not exists (
    select 1 from public.client_briefs b where b.id=p.brief_id
      and b.client_id=p.client_id and b.media_type='video'
      and b.status in ('approved','in_production','complete')) then
    return false; end if;
  if p.route_package_id is not null then
    select * into c from public.client_campaigns where id=p.campaign_id
      and client_id=p.client_id;
    select * into route from public.campaign_route_packages_v6
      where id=p.route_package_id and campaign_id=p.campaign_id
        and client_id=p.client_id;
    if c.id is null or c.status in ('cancelled','complete') or route.id is null
      or route.plan_fingerprint is distinct from public.campaign_plan_fingerprint(c)
      or route.version <> (select max(version)
        from public.campaign_route_packages_v6 rp
        where rp.campaign_id=route.campaign_id and rp.route=route.route) then
      return false; end if;
  end if;
  for entry in select value from jsonb_array_elements(p.source_snapshot) loop
    if entry->>'kind'='operator' then continue; end if;
    select * into state from public.model_section_review_state_v7
      where record_id=(entry->>'id')::uuid and client_id=p.client_id;
    if not found or state.review_state is distinct from 'supported'
      or state.review_id::text is distinct from entry->>'review_id'
      or state.record_hash is distinct from entry->>'record_hash' then
      return false; end if;
  end loop;
  return true;
end $$;

create table public.video_scene_audio_receipts_v1 (
  scene_id uuid primary key references public.video_scenes(id) on delete cascade,
  project_id uuid not null,
  client_id uuid not null,
  ir_version integer not null check (ir_version > 0),
  narration_sha256 text not null check (narration_sha256 ~ '^[0-9a-f]{64}$'),
  audio_sha256 text not null check (audio_sha256 ~ '^[0-9a-f]{64}$'),
  storage_path text not null unique,
  file_bytes bigint not null check (file_bytes > 100),
  object_id uuid not null,
  object_version text,
  object_updated_at timestamptz not null,
  alignment jsonb not null check (jsonb_typeof(alignment) = 'array'),
  alignment_loss numeric(8,4) not null check (alignment_loss >= 0),
  duration_sec numeric(5,2) not null check (duration_sec between 2 and 25),
  measured_lufs numeric(5,2) not null check (measured_lufs between -40 and 0),
  voice_id text not null check (length(btrim(voice_id)) between 1 and 100),
  model_id text not null check (model_id = 'eleven_v3'),
  attempts integer not null check (attempts between 1 and 2),
  created_at timestamptz not null default clock_timestamp(),
  foreign key (project_id, client_id) references public.video_projects(id, client_id)
);
create index video_scene_audio_receipts_project_v1
  on public.video_scene_audio_receipts_v1(project_id, ir_version);
alter table public.video_scene_audio_receipts_v1 enable row level security;
create policy video_scene_audio_receipts_read_v1
  on public.video_scene_audio_receipts_v1 for select to authenticated
  using (public.can_access_client(client_id));
revoke all on public.video_scene_audio_receipts_v1
  from public, anon, authenticated, service_role;
grant select on public.video_scene_audio_receipts_v1 to authenticated, service_role;

create function public.video_scene_audio_upload_target_v1(
  p_project_id uuid, p_scene_id uuid
) returns jsonb language plpgsql volatile security definer
set search_path=pg_catalog,public as $$
declare p public.video_projects%rowtype;
  s public.video_scenes%rowtype;
  path text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Service video audio target only.' using errcode='42501'; end if;
  select * into p from public.video_projects where id=p_project_id;
  select * into s from public.video_scenes where id=p_scene_id;
  if p.id is null or s.id is null or s.project_id is distinct from p.id
    or s.client_id is distinct from p.client_id or p.ir_version<1
    or p.stage not in ('timing','timed')
    or not public.video_project_source_current_v1(p.id) then
    raise exception 'Video scene is not current.' using errcode='23514'; end if;
  path:=p.client_id::text||'/video/projects/'||p.id::text||
    '/ir-v'||p.ir_version::text||'/scenes/'||s.scene_key||'/audio.mp3';
  return jsonb_build_object('client_id',p.client_id,'project_id',p.id,
    'scene_id',s.id,'ir_version',p.ir_version,'scene_key',s.scene_key,
    'narration_sha256',encode(sha256(convert_to(s.narration,'UTF8')),'hex'),
    'storage_path',path);
end $$;
revoke all on function public.video_scene_audio_upload_target_v1(uuid,uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.video_scene_audio_upload_target_v1(uuid,uuid)
  to service_role;

create function public.video_scene_audio_storage_identity_v1(
  p_project_id uuid, p_scene_id uuid
) returns jsonb language plpgsql volatile security definer
set search_path=pg_catalog,public,storage as $$
declare p public.video_projects%rowtype;
  s public.video_scenes%rowtype;
  o storage.objects%rowtype;
  path text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Service video audio inspection only.' using errcode='42501'; end if;
  select * into p from public.video_projects where id=p_project_id;
  select * into s from public.video_scenes where id=p_scene_id;
  if p.id is null or s.id is null or s.project_id is distinct from p.id
    or s.client_id is distinct from p.client_id or p.ir_version<1
    or p.stage not in ('timing','timed')
    or not public.video_project_source_current_v1(p.id) then
    raise exception 'Video scene is not current.' using errcode='23514'; end if;
  path:=p.client_id::text||'/video/projects/'||p.id::text||
    '/ir-v'||p.ir_version::text||'/scenes/'||s.scene_key||'/audio.mp3';
  select * into o from storage.objects
    where bucket_id='client-media' and name=path;
  if o.id is null then
    raise exception 'Scene audio file is absent.' using errcode='23514'; end if;
  return jsonb_build_object('client_id',p.client_id,'project_id',p.id,
    'scene_id',s.id,'ir_version',p.ir_version,'scene_key',s.scene_key,
    'narration_sha256',encode(sha256(convert_to(s.narration,'UTF8')),'hex'),
    'storage_path',path,'object_id',o.id,'object_version',o.version,
    'object_updated_at',o.updated_at);
end $$;
revoke all on function public.video_scene_audio_storage_identity_v1(uuid,uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.video_scene_audio_storage_identity_v1(uuid,uuid)
  to service_role;

create function public.commit_video_scene_audio_v1(
  p_project_id uuid, p_scene_id uuid, p_ir_version integer,
  p_narration_sha256 text, p_audio_sha256 text, p_storage_path text,
  p_file_bytes bigint, p_object_id uuid, p_object_version text,
  p_object_updated_at timestamptz, p_alignment jsonb,
  p_alignment_loss numeric,
  p_duration_sec numeric, p_measured_lufs numeric,
  p_voice_id text, p_attempts integer
) returns uuid language plpgsql volatile security definer
set search_path=pg_catalog,public,storage as $$
declare p public.video_projects%rowtype;
  s public.video_scenes%rowtype;
  o storage.objects%rowtype;
  prior public.video_scene_audio_receipts_v1%rowtype;
  expected_path text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Service video audio commit only.' using errcode='42501'; end if;
  select * into p from public.video_projects where id=p_project_id for update;
  select * into s from public.video_scenes where id=p_scene_id for update;
  if p.id is null or s.id is null or s.project_id is distinct from p.id
    or s.client_id is distinct from p.client_id
    or p.ir_version is distinct from p_ir_version
    or p.stage not in ('timing','timed')
    or not public.video_project_source_current_v1(p.id) then
    raise exception 'Video scene is not the current timing attempt.' using errcode='23514'; end if;
  expected_path:=p.client_id::text||'/video/projects/'||p.id::text||
    '/ir-v'||p_ir_version::text||'/scenes/'||s.scene_key||'/audio.mp3';
  if p_storage_path is distinct from expected_path
    or p_narration_sha256 is distinct from
      encode(sha256(convert_to(s.narration,'UTF8')),'hex')
    or p_audio_sha256 !~ '^[0-9a-f]{64}$'
    or p_file_bytes is null or p_file_bytes<=100
    or jsonb_typeof(p_alignment) is distinct from 'array'
    or jsonb_array_length(p_alignment)<1
    or p_alignment_loss is null or p_alignment_loss<0
    or p_duration_sec is null or p_duration_sec not between 2 and 25
    or p_measured_lufs is null or p_measured_lufs not between -40 and 0
    or nullif(btrim(p_voice_id),'') is null or length(p_voice_id)>100
    or p_attempts not between 1 and 2 then
    raise exception 'Audio identity, timing or provenance is invalid.' using errcode='22023'; end if;
  select * into o from storage.objects
    where bucket_id='client-media' and name=p_storage_path;
  if o.id is null or o.id is distinct from p_object_id
    or o.version is distinct from p_object_version
    or o.updated_at is distinct from p_object_updated_at then
    raise exception 'Audio Storage object changed before commit.' using errcode='23514'; end if;
  select * into prior from public.video_scene_audio_receipts_v1
    where scene_id=s.id;
  if prior.scene_id is not null then
    if prior.project_id is distinct from p.id
      or prior.ir_version is distinct from p_ir_version
      or prior.narration_sha256 is distinct from p_narration_sha256
      or prior.audio_sha256 is distinct from p_audio_sha256
      or prior.storage_path is distinct from p_storage_path
      or prior.file_bytes is distinct from p_file_bytes
      or prior.object_id is distinct from p_object_id
      or prior.object_version is distinct from p_object_version
      or prior.object_updated_at is distinct from p_object_updated_at
      or prior.alignment is distinct from p_alignment
      or prior.alignment_loss is distinct from p_alignment_loss
      or prior.duration_sec is distinct from p_duration_sec
      or prior.measured_lufs is distinct from p_measured_lufs
      or prior.voice_id is distinct from p_voice_id
      or prior.attempts is distinct from p_attempts then
      raise exception 'Scene audio has a different immutable receipt.' using errcode='23514';
    end if;
    return s.id;
  end if;
  if s.audio_path is not null or s.alignment is not null
    or s.duration_sec is not null then
    raise exception 'Scene audio is already bound.' using errcode='23514'; end if;
  insert into public.video_scene_audio_receipts_v1
    (scene_id,project_id,client_id,ir_version,narration_sha256,
     audio_sha256,storage_path,file_bytes,object_id,object_version,
     object_updated_at,alignment,alignment_loss,duration_sec,measured_lufs,
     voice_id,model_id,attempts)
  values(s.id,p.id,p.client_id,p_ir_version,p_narration_sha256,
    p_audio_sha256,p_storage_path,p_file_bytes,o.id,o.version,
    o.updated_at,p_alignment,p_alignment_loss,p_duration_sec,p_measured_lufs,
    p_voice_id,'eleven_v3',p_attempts);
  update public.video_scenes set audio_path=p_storage_path,
    alignment=p_alignment,duration_sec=p_duration_sec where id=s.id;
  return s.id;
end $$;
revoke all on function public.commit_video_scene_audio_v1(
  uuid,uuid,integer,text,text,text,bigint,uuid,text,timestamptz,
  jsonb,numeric,numeric,numeric,text,integer)
  from public,anon,authenticated,service_role;
grant execute on function public.commit_video_scene_audio_v1(
  uuid,uuid,integer,text,text,text,bigint,uuid,text,timestamptz,
  jsonb,numeric,numeric,numeric,text,integer) to service_role;

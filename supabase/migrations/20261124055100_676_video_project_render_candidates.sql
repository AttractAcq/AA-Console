-- A downloaded Lambda MP4 is only a candidate after its exact bytes,
-- Storage object and media probe have been bound to one render attempt.
create table public.video_project_render_candidates_v1 (
  id uuid primary key default gen_random_uuid(),
  attempt_id uuid not null unique
    references public.video_project_render_attempts_v1(id) on delete cascade,
  project_id uuid not null,
  client_id uuid not null,
  ir_version integer not null check (ir_version>0),
  aspect text not null check (aspect in ('16:9','9:16','1:1')),
  storage_path text not null unique,
  file_sha256 text not null check (file_sha256 ~ '^[0-9a-f]{64}$'),
  file_bytes bigint not null check (file_bytes>100),
  object_id uuid not null,
  object_version text,
  object_updated_at timestamptz not null,
  media_probe jsonb not null check (jsonb_typeof(media_probe)='object'),
  probe_result text not null check (probe_result in ('pass','fail')),
  verdict text not null default 'pending'
    check (verdict in ('pending','accepted','rejected')),
  creative_review jsonb,
  rejection_reason text,
  created_at timestamptz not null default clock_timestamp(),
  reviewed_at timestamptz,
  foreign key (project_id,client_id) references public.video_projects(id,client_id)
    on delete cascade,
  unique (project_id,ir_version,aspect),
  check ((verdict='pending' and reviewed_at is null)
    or (verdict in ('accepted','rejected') and reviewed_at is not null))
);
create index video_project_render_candidates_client_v1
  on public.video_project_render_candidates_v1(client_id,project_id,created_at desc);
alter table public.video_project_render_candidates_v1 enable row level security;
create policy video_project_render_candidates_read_v1
  on public.video_project_render_candidates_v1 for select to authenticated
  using (public.can_access_client(client_id));
revoke all on public.video_project_render_candidates_v1
  from public,anon,authenticated,service_role;
grant select on public.video_project_render_candidates_v1
  to authenticated,service_role;

create function public.video_project_render_candidate_identity_v1(
  p_attempt_id uuid,p_file_sha256 text
) returns jsonb language plpgsql volatile security definer
set search_path=pg_catalog,public,storage as $$
declare a public.video_project_render_attempts_v1%rowtype;
  p public.video_projects%rowtype;
  o storage.objects%rowtype;
  v_path text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Service render Storage inspection only.' using errcode='42501'; end if;
  select * into a from public.video_project_render_attempts_v1
    where id=p_attempt_id;
  select * into p from public.video_projects where id=a.project_id;
  if a.id is null or a.state is distinct from 'started'
    or p.id is null or p.stage is distinct from 'timed'
    or p.ir_version is distinct from a.ir_version
    or coalesce(p_file_sha256,'') !~ '^[0-9a-f]{64}$'
    or not public.video_project_source_current_v1(p.id) then
    raise exception 'Render candidate target is no longer current.'
      using errcode='23514'; end if;
  v_path:=a.client_id::text||'/video/projects/'||p.id::text||
    '/ir-v'||a.ir_version::text||'/candidates/'||a.id::text||'-'||
    replace(a.aspect,':','x')||'-'||p_file_sha256||'.mp4';
  select * into o from storage.objects
    where bucket_id='client-media' and name=v_path;
  if o.id is null then
    raise exception 'Render candidate Storage file is absent.'
      using errcode='23514'; end if;
  return jsonb_build_object('client_id',a.client_id,'project_id',p.id,
    'attempt_id',a.id,'ir_version',a.ir_version,'aspect',a.aspect,
    'storage_path',v_path,'object_id',o.id,
    'object_version',o.version,'object_updated_at',o.updated_at);
end $$;
revoke all on function public.video_project_render_candidate_identity_v1(uuid,text)
  from public,anon,authenticated,service_role;
grant execute on function public.video_project_render_candidate_identity_v1(uuid,text)
  to service_role;

create function public.record_video_project_render_candidate_v1(
  p_attempt_id uuid,p_job_id uuid,p_storage_path text,
  p_file_sha256 text,p_file_bytes bigint,p_object_id uuid,
  p_object_version text,p_object_updated_at timestamptz,p_media_probe jsonb
) returns uuid language plpgsql volatile security definer
set search_path=pg_catalog,public,storage as $$
declare a public.video_project_render_attempts_v1%rowtype;
  p public.video_projects%rowtype;
  prior public.video_project_render_candidates_v1%rowtype;
  o storage.objects%rowtype;
  v_path text;
  v_result text;
  v_width integer;
  v_height integer;
  v_duration numeric;
  v_id uuid;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Service render candidate write only.' using errcode='42501'; end if;
  select * into a from public.video_project_render_attempts_v1
    where id=p_attempt_id for update;
  select * into p from public.video_projects where id=a.project_id for update;
  select * into prior from public.video_project_render_candidates_v1
    where attempt_id=a.id;
  if prior.id is not null then
    if prior.project_id is distinct from p.id
      or prior.ir_version is distinct from a.ir_version
      or prior.aspect is distinct from a.aspect
      or prior.storage_path is distinct from p_storage_path
      or prior.file_sha256 is distinct from p_file_sha256
      or prior.file_bytes is distinct from p_file_bytes
      or prior.object_id is distinct from p_object_id
      or prior.object_version is distinct from p_object_version
      or prior.object_updated_at is distinct from p_object_updated_at
      or prior.media_probe is distinct from p_media_probe then
      raise exception 'Render candidate replay differs from its receipt.'
        using errcode='23514'; end if;
    return prior.id;
  end if;
  if a.id is null or a.job_id is distinct from p_job_id
    or a.state is distinct from 'started'
    or p.id is null or p.stage is distinct from 'timed'
    or p.ir_version is distinct from a.ir_version
    or not public.video_project_source_current_v1(p.id)
    or not public.complete_video_audio_project_v1(p.id,a.ir_version)
    or coalesce(p_file_sha256,'') !~ '^[0-9a-f]{64}$'
    or p_file_bytes is null or p_file_bytes<=100
    or p_media_probe is null or jsonb_typeof(p_media_probe)<>'object' then
    raise exception 'Render candidate differs from its live attempt.'
      using errcode='23514'; end if;
  v_path:=a.client_id::text||'/video/projects/'||p.id::text||
    '/ir-v'||a.ir_version::text||'/candidates/'||a.id::text||'-'||
    replace(a.aspect,':','x')||'-'||p_file_sha256||'.mp4';
  v_result:=p_media_probe->>'result';
  v_width:=case when (p_media_probe->>'width') ~ '^[0-9]{1,5}$'
    then (p_media_probe->>'width')::integer else 0 end;
  v_height:=case when (p_media_probe->>'height') ~ '^[0-9]{1,5}$'
    then (p_media_probe->>'height')::integer else 0 end;
  v_duration:=case when (p_media_probe->>'duration_sec') ~
    '^[0-9]{1,4}(\.[0-9]{1,3})?$'
    then (p_media_probe->>'duration_sec')::numeric else 0 end;
  if p_storage_path is distinct from v_path
    or v_result is null or v_result not in ('pass','fail')
    or jsonb_typeof(p_media_probe->'checks') is distinct from 'array'
    or (v_result='pass' and (
      v_width is distinct from case a.aspect when '16:9' then 1920
        when '9:16' then 1080 else 1080 end
      or v_height is distinct from case a.aspect when '16:9' then 1080
        when '9:16' then 1920 else 1080 end
      or p_media_probe->>'has_audio' is distinct from 'true'
      or v_duration not between 20 and 960
      or case when jsonb_typeof(p_media_probe->'checks')='array'
        then jsonb_array_length(p_media_probe->'checks')<>0
        else true end)) then
    raise exception 'Render candidate path or media probe is invalid.'
      using errcode='23514'; end if;
  select * into o from storage.objects
    where bucket_id='client-media' and name=p_storage_path;
  if o.id is null or o.id is distinct from p_object_id
    or o.version is distinct from p_object_version
    or o.updated_at is distinct from p_object_updated_at then
    raise exception 'Render candidate Storage object changed before commit.'
      using errcode='23514'; end if;
  insert into public.video_project_render_candidates_v1
    (attempt_id,project_id,client_id,ir_version,aspect,storage_path,
      file_sha256,file_bytes,object_id,object_version,object_updated_at,
      media_probe,probe_result)
  values(a.id,p.id,p.client_id,a.ir_version,a.aspect,p_storage_path,
    p_file_sha256,p_file_bytes,o.id,o.version,o.updated_at,
    p_media_probe,v_result) returning id into v_id;
  update public.video_project_render_attempts_v1
    set state=case when v_result='pass' then 'succeeded' else 'failed' end,
      error_code=case when v_result='fail' then 'probe_failed' else null end,
      finished_at=clock_timestamp() where id=a.id;
  update public.video_projects set stage_error=case when v_result='pass' then
    'Render candidate filed; creative and human review pending.' else
    'Render candidate failed media probe; inspect and revise.' end
    where id=p.id;
  return v_id;
end $$;
revoke all on function public.record_video_project_render_candidate_v1(
  uuid,uuid,text,text,bigint,uuid,text,timestamptz,jsonb)
  from public,anon,authenticated,service_role;
grant execute on function public.record_video_project_render_candidate_v1(
  uuid,uuid,text,text,bigint,uuid,text,timestamptz,jsonb)
  to service_role;

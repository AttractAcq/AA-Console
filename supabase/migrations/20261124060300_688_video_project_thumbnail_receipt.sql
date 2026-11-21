-- A thumbnail is another billable Lambda action. Claim its exact project
-- version once and file the provider cost before accepting Storage bytes.
create table public.video_project_thumbnail_attempts_v1 (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null,
  client_id uuid not null,
  ir_version integer not null check (ir_version>0),
  job_id uuid not null references public.agent_jobs(id),
  first_candidate_id uuid not null
    references public.video_project_render_candidates_v1(id),
  state text not null default 'claimed'
    check (state in ('claimed','rendered','uncertain','filed')),
  provider_render_id text,
  provider_usd numeric(12,6),
  storage_path text,
  file_sha256 text check (file_sha256 is null
    or file_sha256 ~ '^[0-9a-f]{64}$'),
  file_bytes bigint check (file_bytes is null
    or file_bytes between 101 and 8388608),
  object_id uuid,
  object_version text,
  object_updated_at timestamptz,
  error_code text,
  claimed_at timestamptz not null default clock_timestamp(),
  rendered_at timestamptz,
  filed_at timestamptz,
  foreign key (project_id,client_id)
    references public.video_projects(id,client_id) on delete cascade,
  unique (project_id,ir_version),
  check ((state='claimed' and provider_render_id is null
      and provider_usd is null and storage_path is null
      and error_code is null and rendered_at is null and filed_at is null)
    or (state='rendered' and provider_render_id is not null
      and provider_usd is not null and storage_path is null
      and error_code is null and rendered_at is not null and filed_at is null)
    or (state='uncertain' and error_code is not null and filed_at is null)
    or (state='filed' and provider_render_id is not null
      and provider_usd is not null and storage_path is not null
      and file_sha256 is not null and file_bytes is not null
      and object_id is not null and object_updated_at is not null
      and error_code is null and rendered_at is not null
      and filed_at is not null))
);
create index video_project_thumbnail_attempts_client_v1
  on public.video_project_thumbnail_attempts_v1
  (client_id,project_id,claimed_at desc);
alter table public.video_project_thumbnail_attempts_v1 enable row level security;
create policy video_project_thumbnail_attempts_read_v1
  on public.video_project_thumbnail_attempts_v1 for select to authenticated
  using (public.can_access_client(client_id));
revoke all on public.video_project_thumbnail_attempts_v1
  from public,anon,authenticated,service_role;
grant select on public.video_project_thumbnail_attempts_v1
  to authenticated,service_role;

create function public.claim_video_project_thumbnail_v1(
  p_project_id uuid,p_job_id uuid,p_ir_version integer,
  p_first_candidate_id uuid
) returns jsonb language plpgsql volatile security definer
set search_path=pg_catalog,public as $$
declare p public.video_projects%rowtype;
  j public.agent_jobs%rowtype;
  c public.video_project_render_candidates_v1%rowtype;
  a public.video_project_thumbnail_attempts_v1%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Service thumbnail claim only.' using errcode='42501'; end if;
  select * into p from public.video_projects where id=p_project_id for update;
  select * into j from public.agent_jobs where id=p_job_id;
  select * into c from public.video_project_render_candidates_v1
    where id=p_first_candidate_id;
  if p.id is null or p.stage is distinct from 'timed'
    or p.ir_version is distinct from p_ir_version
    or p.brand_snapshot is null or p.brand_snapshot_sha256 is null
    or j.id is null or j.agent_key is distinct from 'video_render'
    or j.input_table is distinct from 'video_projects'
    or j.input_id is distinct from p.id
    or j.client_id is distinct from p.client_id
    or j.params->>'ir_version' is distinct from p_ir_version::text
    or c.id is null or c.project_id is distinct from p.id
    or c.client_id is distinct from p.client_id
    or c.ir_version is distinct from p_ir_version
    or c.aspect is distinct from p.aspects[1]
    or c.verdict is distinct from 'accepted'
    or c.probe_result is distinct from 'pass'
    or not public.video_project_source_current_v1(p.id)
    or exists(select 1 from public.video_project_render_candidates_v1 x
      where x.project_id=p.id and x.ir_version=p_ir_version
        and (x.aspect<>all(p.aspects)
          or x.verdict is distinct from 'accepted'
          or x.probe_result is distinct from 'pass'
          or not exists(select 1 from storage.objects o
            where o.bucket_id='client-media'
              and o.name=x.storage_path
              and o.id=x.object_id
              and o.version is not distinct from x.object_version
              and o.updated_at=x.object_updated_at)))
    or (select count(*) from public.video_project_render_candidates_v1 x
      where x.project_id=p.id and x.ir_version=p_ir_version)
      is distinct from cardinality(p.aspects) then
    raise exception 'Thumbnail requires exact accepted project candidates.'
      using errcode='23514'; end if;
  select * into a from public.video_project_thumbnail_attempts_v1
    where project_id=p.id and ir_version=p_ir_version;
  if a.id is not null then
    if a.job_id is distinct from p_job_id
      or a.first_candidate_id is distinct from p_first_candidate_id then
      raise exception 'Thumbnail claim differs from its first attempt.'
        using errcode='23514'; end if;
    return jsonb_build_object('state','already_'||a.state,
      'attempt_id',a.id);
  end if;
  insert into public.video_project_thumbnail_attempts_v1
    (project_id,client_id,ir_version,job_id,first_candidate_id)
  values(p.id,p.client_id,p_ir_version,j.id,c.id) returning * into a;
  return jsonb_build_object('state','claimed','attempt_id',a.id);
end $$;
revoke all on function public.claim_video_project_thumbnail_v1(
  uuid,uuid,integer,uuid) from public,anon,authenticated,service_role;
grant execute on function public.claim_video_project_thumbnail_v1(
  uuid,uuid,integer,uuid) to service_role;

create function public.record_video_project_thumbnail_provider_v1(
  p_attempt_id uuid,p_job_id uuid,p_render_id text,p_usd numeric
) returns uuid language plpgsql volatile security definer
set search_path=pg_catalog,public as $$
declare a public.video_project_thumbnail_attempts_v1%rowtype;
  p public.video_projects%rowtype;
  saved public.video_project_costs%rowtype;
  v_usd numeric(12,6);
  v_cost uuid;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Service thumbnail cost write only.' using errcode='42501'; end if;
  if coalesce(p_render_id,'') !~ '^[A-Za-z0-9-]{1,128}$'
    or p_usd is null or p_usd not between 0 and 10000 then
    raise exception 'Thumbnail provider evidence is invalid.'
      using errcode='22023'; end if;
  v_usd:=round(p_usd,6);
  select * into a from public.video_project_thumbnail_attempts_v1
    where id=p_attempt_id for update;
  select * into p from public.video_projects where id=a.project_id for update;
  if a.id is null or a.job_id is distinct from p_job_id
    or p.id is null or p.stage is distinct from 'timed'
    or p.ir_version is distinct from a.ir_version
    or not public.video_project_source_current_v1(p.id) then
    raise exception 'Thumbnail provider result is no longer current.'
      using errcode='23514'; end if;
  select * into saved from public.video_project_costs
    where attempt_key='video-thumbnail:'||a.id::text;
  v_cost:=saved.id;
  if a.state in ('rendered','filed') then
    if a.provider_render_id is distinct from p_render_id
      or a.provider_usd is distinct from v_usd
      or saved.id is null or saved.project_id is distinct from p.id
      or saved.client_id is distinct from p.client_id
      or saved.job_id is distinct from p_job_id
      or saved.stage is distinct from 'thumbnail'
      or saved.provider is distinct from 'remotion_lambda_estimate'
      or saved.units is distinct from 1
      or saved.unit is distinct from 'image'
      or saved.usd is distinct from v_usd then
      raise exception 'Thumbnail provider replay differs from its receipt.'
        using errcode='23514'; end if;
    return v_cost;
  end if;
  if a.state is distinct from 'claimed' or v_cost is not null then
    raise exception 'Thumbnail provider result needs reconciliation.'
      using errcode='23514'; end if;
  insert into public.video_project_costs(project_id,client_id,job_id,
    stage,provider,units,unit,usd,attempt_key)
  values(p.id,p.client_id,p_job_id,'thumbnail',
    'remotion_lambda_estimate',1,'image',v_usd,
    'video-thumbnail:'||a.id::text) returning id into v_cost;
  update public.video_project_thumbnail_attempts_v1
    set state='rendered',provider_render_id=p_render_id,
      provider_usd=v_usd,rendered_at=clock_timestamp()
    where id=a.id;
  update public.video_projects set cost_usd=cost_usd+v_usd where id=p.id;
  return v_cost;
end $$;
revoke all on function public.record_video_project_thumbnail_provider_v1(
  uuid,uuid,text,numeric) from public,anon,authenticated,service_role;
grant execute on function public.record_video_project_thumbnail_provider_v1(
  uuid,uuid,text,numeric) to service_role;

create function public.video_project_thumbnail_storage_identity_v1(
  p_attempt_id uuid,p_file_sha256 text
) returns jsonb language plpgsql volatile security definer
set search_path=pg_catalog,public,storage as $$
declare a public.video_project_thumbnail_attempts_v1%rowtype;
  p public.video_projects%rowtype;
  o storage.objects%rowtype;
  v_path text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Service thumbnail Storage inspection only.'
      using errcode='42501'; end if;
  select * into a from public.video_project_thumbnail_attempts_v1
    where id=p_attempt_id;
  select * into p from public.video_projects where id=a.project_id;
  if a.id is null or a.state is distinct from 'rendered'
    or p.id is null or p.stage is distinct from 'timed'
    or p.ir_version is distinct from a.ir_version
    or coalesce(p_file_sha256,'') !~ '^[0-9a-f]{64}$'
    or not public.video_project_source_current_v1(p.id) then
    raise exception 'Thumbnail Storage target is no longer current.'
      using errcode='23514'; end if;
  v_path:=a.client_id::text||'/video/projects/'||p.id::text||
    '/ir-v'||a.ir_version::text||'/thumbnail-'
    ||a.id::text||'-'||p_file_sha256||'.jpg';
  select * into o from storage.objects
    where bucket_id='client-media' and name=v_path;
  if o.id is null then
    raise exception 'Thumbnail Storage object is absent.'
      using errcode='23514'; end if;
  return jsonb_build_object('client_id',a.client_id,'project_id',p.id,
    'attempt_id',a.id,'ir_version',a.ir_version,
    'storage_path',v_path,'object_id',o.id,
    'object_version',o.version,'object_updated_at',o.updated_at);
end $$;
revoke all on function public.video_project_thumbnail_storage_identity_v1(
  uuid,text) from public,anon,authenticated,service_role;
grant execute on function public.video_project_thumbnail_storage_identity_v1(
  uuid,text) to service_role;

create function public.file_video_project_thumbnail_v1(
  p_attempt_id uuid,p_job_id uuid,p_storage_path text,
  p_file_sha256 text,p_file_bytes bigint,p_object_id uuid,
  p_object_version text,p_object_updated_at timestamptz,
  p_width integer,p_height integer
) returns uuid language plpgsql volatile security definer
set search_path=pg_catalog,public,storage as $$
declare a public.video_project_thumbnail_attempts_v1%rowtype;
  p public.video_projects%rowtype;
  o storage.objects%rowtype;
  v_path text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Service thumbnail filing only.' using errcode='42501'; end if;
  select * into a from public.video_project_thumbnail_attempts_v1
    where id=p_attempt_id for update;
  select * into p from public.video_projects where id=a.project_id for update;
  if a.id is null or a.job_id is distinct from p_job_id
    or p.id is null or p.stage is distinct from 'timed'
    or p.ir_version is distinct from a.ir_version
    or not public.video_project_source_current_v1(p.id)
    or p_width is distinct from 1280 or p_height is distinct from 720
    or coalesce(p_file_sha256,'') !~ '^[0-9a-f]{64}$'
    or p_file_bytes is null or p_file_bytes not between 101 and 8388608
    or not exists(select 1 from public.video_project_costs c
      where c.attempt_key='video-thumbnail:'||a.id::text
        and c.project_id=p.id and c.job_id=p_job_id
        and c.stage='thumbnail' and c.provider='remotion_lambda_estimate'
        and c.units=1 and c.unit='image'
        and c.usd=a.provider_usd) then
    raise exception 'Thumbnail filing differs from exact provider evidence.'
      using errcode='23514'; end if;
  v_path:=a.client_id::text||'/video/projects/'||p.id::text||
    '/ir-v'||a.ir_version::text||'/thumbnail-'
    ||a.id::text||'-'||p_file_sha256||'.jpg';
  select * into o from storage.objects
    where bucket_id='client-media' and name=v_path;
  if p_storage_path is distinct from v_path or o.id is null
    or o.id is distinct from p_object_id
    or o.version is distinct from p_object_version
    or o.updated_at is distinct from p_object_updated_at then
    raise exception 'Thumbnail Storage object changed before filing.'
      using errcode='23514'; end if;
  if a.state='filed' then
    if a.storage_path is distinct from p_storage_path
      or a.file_sha256 is distinct from p_file_sha256
      or a.file_bytes is distinct from p_file_bytes
      or a.object_id is distinct from p_object_id
      or a.object_version is distinct from p_object_version
      or a.object_updated_at is distinct from p_object_updated_at then
      raise exception 'Thumbnail replay differs from its receipt.'
        using errcode='23514'; end if;
    return a.id;
  end if;
  if a.state is distinct from 'rendered' then
    raise exception 'Thumbnail attempt needs reconciliation.'
      using errcode='23514'; end if;
  update public.video_project_thumbnail_attempts_v1
    set state='filed',storage_path=v_path,file_sha256=p_file_sha256,
      file_bytes=p_file_bytes,object_id=o.id,object_version=o.version,
      object_updated_at=o.updated_at,filed_at=clock_timestamp()
    where id=a.id;
  return a.id;
end $$;
revoke all on function public.file_video_project_thumbnail_v1(
  uuid,uuid,text,text,bigint,uuid,text,timestamptz,integer,integer)
  from public,anon,authenticated,service_role;
grant execute on function public.file_video_project_thumbnail_v1(
  uuid,uuid,text,text,bigint,uuid,text,timestamptz,integer,integer)
  to service_role;

create function public.mark_video_project_thumbnail_uncertain_v1(
  p_attempt_id uuid,p_job_id uuid,p_code text
) returns boolean language plpgsql volatile security definer
set search_path=pg_catalog,public as $$
declare a public.video_project_thumbnail_attempts_v1%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Service thumbnail uncertainty only.'
      using errcode='42501'; end if;
  select * into a from public.video_project_thumbnail_attempts_v1
    where id=p_attempt_id for update;
  if a.id is null or a.job_id is distinct from p_job_id
    or coalesce(p_code,'') !~ '^[a-z_]{3,60}$'
    or a.state='filed' then
    raise exception 'Thumbnail uncertainty differs from its attempt.'
      using errcode='23514'; end if;
  if a.state='uncertain' then
    return a.error_code is not distinct from p_code;
  end if;
  update public.video_project_thumbnail_attempts_v1
    set state='uncertain',error_code=p_code where id=a.id;
  return true;
end $$;
revoke all on function public.mark_video_project_thumbnail_uncertain_v1(
  uuid,uuid,text) from public,anon,authenticated,service_role;
grant execute on function public.mark_video_project_thumbnail_uncertain_v1(
  uuid,uuid,text) to service_role;

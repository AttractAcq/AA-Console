-- A render is an external billable action. Claim its exact IR/aspect once,
-- before calling Lambda. An unrecorded start stays uncertain, never auto-retried.
insert into public.agents(agent_key,name,initials,domain,description,
  requires_upstream,paused)
values ('video_render','Video render','VR','content_production',
  'Renders one exact code-rendered video IR through a guarded Lambda attempt.',
  '{}'::text[],true)
on conflict (agent_key) do nothing;

create table public.video_project_render_attempts_v1 (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null,
  client_id uuid not null,
  ir_version integer not null check (ir_version>0),
  aspect text not null check (aspect in ('16:9','9:16','1:1')),
  job_id uuid not null references public.agent_jobs(id),
  state text not null default 'claimed'
    check (state in ('claimed','started','uncertain','failed','succeeded')),
  region text,
  function_name text,
  render_id text,
  bucket_name text,
  out_name text,
  error_code text,
  claimed_at timestamptz not null default clock_timestamp(),
  started_at timestamptz,
  finished_at timestamptz,
  foreign key (project_id,client_id) references public.video_projects(id,client_id)
    on delete cascade,
  unique (project_id,ir_version,aspect),
  check ((state='claimed' and render_id is null and started_at is null
      and finished_at is null and error_code is null)
    or (state='started' and render_id is not null and started_at is not null
      and finished_at is null and error_code is null)
    or (state='uncertain' and finished_at is not null
      and error_code is not null)
    or (state in ('failed','succeeded') and render_id is not null
      and started_at is not null and finished_at is not null)),
  check ((render_id is null and region is null and function_name is null
      and bucket_name is null and out_name is null)
    or (render_id is not null and region is not null and function_name is not null
      and bucket_name is not null and out_name is not null))
);
create index video_project_render_attempts_client_v1
  on public.video_project_render_attempts_v1(client_id,project_id,claimed_at desc);
alter table public.video_project_render_attempts_v1 enable row level security;
create policy video_project_render_attempts_read_v1
  on public.video_project_render_attempts_v1 for select to authenticated
  using (public.can_access_client(client_id));
revoke all on public.video_project_render_attempts_v1
  from public,anon,authenticated,service_role;
grant select on public.video_project_render_attempts_v1 to authenticated,service_role;

create function public.claim_video_project_render_v1(
  p_project_id uuid,p_job_id uuid,p_ir_version integer,p_aspect text
) returns jsonb language plpgsql volatile security definer
set search_path=pg_catalog,public as $$
declare p public.video_projects%rowtype;
  j public.agent_jobs%rowtype;
  a public.video_project_render_attempts_v1%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Service video render claim only.' using errcode='42501'; end if;
  select * into p from public.video_projects where id=p_project_id for update;
  select * into j from public.agent_jobs where id=p_job_id;
  if p.id is null or p.stage is distinct from 'timed'
    or p.ir_version is distinct from p_ir_version
    or p_aspect is null or p_aspect<>all(p.aspects)
    or j.id is null or j.agent_key is distinct from 'video_render'
    or j.input_table is distinct from 'video_projects'
    or j.input_id is distinct from p.id or j.client_id is distinct from p.client_id
    or j.params->>'ir_version' is distinct from p_ir_version::text
    or not public.video_project_source_current_v1(p.id)
    or not public.complete_video_audio_project_v1(p.id,p_ir_version) then
    raise exception 'Render claim requires one current timed project and job.'
      using errcode='23514'; end if;
  select * into a from public.video_project_render_attempts_v1
    where project_id=p.id and ir_version=p_ir_version and aspect=p_aspect;
  if a.id is not null then
    return jsonb_build_object('state','already_'||a.state,
      'attempt_id',a.id,'render_id',a.render_id,'bucket_name',a.bucket_name);
  end if;
  insert into public.video_project_render_attempts_v1
    (project_id,client_id,ir_version,aspect,job_id)
  values(p.id,p.client_id,p_ir_version,p_aspect,j.id) returning * into a;
  update public.video_projects set stage_error=
    'Render claimed; Lambda start or handle may need reconciliation.'
    where id=p.id;
  return jsonb_build_object('state','claimed','attempt_id',a.id);
end $$;
revoke all on function public.claim_video_project_render_v1(uuid,uuid,integer,text)
  from public,anon,authenticated,service_role;
grant execute on function public.claim_video_project_render_v1(uuid,uuid,integer,text)
  to service_role;

create function public.record_video_project_lambda_handle_v1(
  p_attempt_id uuid,p_job_id uuid,p_region text,p_function_name text,
  p_render_id text,p_bucket_name text,p_out_name text
) returns boolean language plpgsql volatile security definer
set search_path=pg_catalog,public as $$
declare a public.video_project_render_attempts_v1%rowtype;
  p public.video_projects%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Service Lambda handle write only.' using errcode='42501'; end if;
  select * into a from public.video_project_render_attempts_v1
    where id=p_attempt_id for update;
  select * into p from public.video_projects where id=a.project_id;
  if a.id is null or p.id is null or a.job_id is distinct from p_job_id
    or a.ir_version is distinct from p.ir_version
    or p.stage is distinct from 'timed'
    or coalesce(p_region,'') !~ '^[a-z]{2}-[a-z]+-[0-9]$'
    or coalesce(p_function_name,'') !~ '^[A-Za-z0-9_-]{1,64}$'
    or coalesce(p_render_id,'') !~ '^[A-Za-z0-9-]{1,128}$'
    or coalesce(p_bucket_name,'') !~ '^[a-z0-9.-]{3,63}$'
    or p_out_name is distinct from
      (p.id::text||'-'||replace(a.aspect,':','x')||'.mp4') then
    raise exception 'Lambda handle differs from the claimed render.'
      using errcode='23514'; end if;
  if a.state='started' and a.region is not distinct from p_region
    and a.function_name is not distinct from p_function_name
    and a.render_id is not distinct from p_render_id
    and a.bucket_name is not distinct from p_bucket_name
    and a.out_name is not distinct from p_out_name then return true; end if;
  if a.state is distinct from 'claimed' then
    raise exception 'Render handle was already settled or changed.'
      using errcode='23514'; end if;
  update public.video_project_render_attempts_v1
    set state='started',region=p_region,function_name=p_function_name,
      render_id=p_render_id,bucket_name=p_bucket_name,out_name=p_out_name,
      started_at=clock_timestamp() where id=a.id;
  update public.video_projects set stage_error=
    'Lambda render running; wait for candidate readback.' where id=p.id;
  return true;
end $$;
revoke all on function public.record_video_project_lambda_handle_v1(
  uuid,uuid,text,text,text,text,text)
  from public,anon,authenticated,service_role;
grant execute on function public.record_video_project_lambda_handle_v1(
  uuid,uuid,text,text,text,text,text) to service_role;

create function public.mark_video_project_render_uncertain_v1(
  p_attempt_id uuid,p_job_id uuid,p_code text
) returns boolean language plpgsql volatile security definer
set search_path=pg_catalog,public as $$
declare a public.video_project_render_attempts_v1%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Service render uncertainty write only.' using errcode='42501'; end if;
  select * into a from public.video_project_render_attempts_v1
    where id=p_attempt_id for update;
  if a.id is null or a.job_id is distinct from p_job_id
    or a.state not in ('claimed','uncertain')
    or coalesce(p_code,'') !~ '^[a-z_]{3,40}$' then
    raise exception 'Render uncertainty must preserve its exact claim.'
      using errcode='23514'; end if;
  if a.state='uncertain' then
    if a.error_code is distinct from p_code then
      raise exception 'Render uncertainty code changed.' using errcode='23514'; end if;
    return true;
  end if;
  update public.video_project_render_attempts_v1
    set state='uncertain',error_code=p_code,finished_at=clock_timestamp()
    where id=a.id;
  update public.video_projects set stage_error=
    'Lambda render start outcome uncertain; reconcile the provider before retry.'
    where id=a.project_id;
  return true;
end $$;
revoke all on function public.mark_video_project_render_uncertain_v1(uuid,uuid,text)
  from public,anon,authenticated,service_role;
grant execute on function public.mark_video_project_render_uncertain_v1(uuid,uuid,text)
  to service_role;

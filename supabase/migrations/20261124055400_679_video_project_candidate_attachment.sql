-- Attach one accepted, exact video project version to the existing human
-- asset-approval path. Every requested aspect must have passed independently
-- through the physical probe and the internal creative-decision gate.
create table public.video_project_attachments_v1 (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null,
  client_id uuid not null,
  ir_version integer not null check (ir_version>0),
  first_candidate_id uuid not null unique
    references public.video_project_render_candidates_v1(id),
  asset_id uuid not null unique references public.client_media_assets(id),
  attached_at timestamptz not null default clock_timestamp(),
  foreign key (project_id,client_id) references public.video_projects(id,client_id),
  unique (project_id,ir_version)
);
create index video_project_attachments_client_v1
  on public.video_project_attachments_v1(client_id,attached_at desc);
alter table public.video_project_attachments_v1 enable row level security;
create policy video_project_attachments_read_v1
  on public.video_project_attachments_v1 for select to authenticated
  using (public.can_access_client(client_id));
revoke all on public.video_project_attachments_v1
  from public,anon,authenticated,service_role;
grant select on public.video_project_attachments_v1 to authenticated,service_role;

create function public.attach_video_project_render_v1(
  p_project_id uuid,p_first_candidate_id uuid
) returns uuid language plpgsql volatile security definer
set search_path=pg_catalog,public,storage as $$
declare p public.video_projects%rowtype;
  first_candidate public.video_project_render_candidates_v1%rowtype;
  candidate public.video_project_render_candidates_v1%rowtype;
  prior public.video_project_attachments_v1%rowtype;
  o storage.objects%rowtype;
  candidate_count integer;
  asset_id uuid;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Service video attachment only.' using errcode='42501'; end if;
  select * into p from public.video_projects where id=p_project_id for update;
  if p.id is null then
    raise exception 'Video project does not exist.' using errcode='23514'; end if;
  select * into prior from public.video_project_attachments_v1
    where project_id=p.id and ir_version=p.ir_version;
  if prior.id is not null then
    if prior.first_candidate_id is distinct from p_first_candidate_id then
      raise exception 'Video attachment replay differs from receipt.'
        using errcode='23514'; end if;
    return prior.asset_id;
  end if;
  if p.stage is distinct from 'timed'
    or not public.video_project_source_current_v1(p.id)
    or not public.complete_video_audio_project_v1(p.id,p.ir_version) then
    raise exception 'Video project is not ready to attach.'
      using errcode='23514'; end if;
  select * into first_candidate from public.video_project_render_candidates_v1
    where id=p_first_candidate_id;
  if first_candidate.id is null
    or first_candidate.project_id is distinct from p.id
    or first_candidate.client_id is distinct from p.client_id
    or first_candidate.ir_version is distinct from p.ir_version
    or first_candidate.aspect is distinct from p.aspects[1]
    or first_candidate.verdict is distinct from 'accepted'
    or first_candidate.probe_result is distinct from 'pass' then
    raise exception 'Choose the accepted first-aspect candidate.'
      using errcode='23514'; end if;
  select count(*) into candidate_count
    from public.video_project_render_candidates_v1
    where project_id=p.id and ir_version=p.ir_version;
  if candidate_count is distinct from cardinality(p.aspects) then
    raise exception 'Every requested aspect needs a candidate.'
      using errcode='23514'; end if;
  for candidate in select * from public.video_project_render_candidates_v1
      where project_id=p.id and ir_version=p.ir_version loop
    if candidate.aspect <> all(p.aspects)
      or candidate.verdict is distinct from 'accepted'
      or candidate.probe_result is distinct from 'pass' then
      raise exception 'Every requested aspect must pass review.'
        using errcode='23514'; end if;
    select * into o from storage.objects
      where bucket_id='client-media' and name=candidate.storage_path;
    if o.id is null or o.id is distinct from candidate.object_id
      or o.version is distinct from candidate.object_version
      or o.updated_at is distinct from candidate.object_updated_at then
      raise exception 'A render Storage object changed before attachment.'
        using errcode='23514'; end if;
  end loop;
  insert into public.client_media_assets
    (client_id,media_type,content_format,title,storage_path,render_path,
      edit_stage,width,height,duration_sec,edit_plan)
  values(p.client_id,'video',
    case when first_candidate.aspect='9:16'
      then 'reel'::public.content_format else 'single'::public.content_format end,
    left('Video — '||p.idea,300),first_candidate.storage_path,
    first_candidate.storage_path,'review_ready',
    (first_candidate.media_probe->>'width')::integer,
    (first_candidate.media_probe->>'height')::integer,
    (first_candidate.media_probe->>'duration_sec')::numeric,
    jsonb_build_object('video_project_id',p.id,'ir_version',p.ir_version,
      'first_candidate_id',first_candidate.id,'aspects',p.aspects))
  returning id into asset_id;
  perform public.attest_creative_storage_bytes_v6(asset_id,
    first_candidate.storage_path,first_candidate.file_sha256,
    first_candidate.file_bytes,first_candidate.object_id,
    first_candidate.object_version,first_candidate.object_updated_at);
  insert into public.video_project_attachments_v1
    (project_id,client_id,ir_version,first_candidate_id,asset_id)
  values(p.id,p.client_id,p.ir_version,first_candidate.id,asset_id);
  update public.video_projects set stage='attached',stage_error=null
    where id=p.id;
  return asset_id;
end $$;
revoke all on function public.attach_video_project_render_v1(uuid,uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.attach_video_project_render_v1(uuid,uuid)
  to service_role;

-- A narration revision retains the earlier scene receipt and attempt before
-- the current scene slot is cleared. Storage bytes and cost ledger rows remain
-- immutable; the archive is readable only in its own client scope.
create table public.video_scene_audio_revisions_v1 (
  scene_id uuid not null,
  project_id uuid not null,
  client_id uuid not null,
  ir_version integer not null check(ir_version>0),
  source_attempt_id uuid not null
    references public.video_project_prerender_attempts_v1(id),
  narration text not null,
  receipt jsonb not null check(jsonb_typeof(receipt)='object'),
  attempt jsonb not null check(jsonb_typeof(attempt)='object'),
  archived_at timestamptz not null default clock_timestamp(),
  primary key(scene_id,ir_version),
  foreign key(project_id,client_id)
    references public.video_projects(id,client_id) on delete cascade,
  check((receipt->>'scene_id')::uuid=scene_id),
  check((receipt->>'ir_version')::integer=ir_version),
  check((attempt->>'scene_id')::uuid=scene_id),
  check((attempt->>'ir_version')::integer=ir_version)
);
create index video_scene_audio_revisions_client_v1
  on public.video_scene_audio_revisions_v1
  (client_id,project_id,ir_version);
alter table public.video_scene_audio_revisions_v1 enable row level security;
create policy video_scene_audio_revisions_read_v1
  on public.video_scene_audio_revisions_v1 for select to authenticated
  using(public.can_access_client(client_id));
revoke all on public.video_scene_audio_revisions_v1
  from public,anon,authenticated,service_role;
grant select on public.video_scene_audio_revisions_v1
  to authenticated,service_role;

-- The project keeps its original music/audio baseline. Each current scene
-- receipt may belong to that baseline or a later narration revision, but it
-- must still match the current narration, timing and exact Storage identity.
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
  v_audio_version integer;
  v_expected_path text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Service video audio completion only.' using errcode='42501'; end if;
  select * into p from public.video_projects where id=p_project_id for update;
  if p.id is null or p.ir_version is distinct from p_ir_version
    or p.stage not in ('timing','timed')
    or not public.video_project_source_current_v1(p.id) then
    raise exception 'Video audio project is no longer current.' using errcode='23514'; end if;
  v_audio_version:=coalesce(p.audio_ir_version,p.ir_version);
  for s in select * from public.video_scenes where project_id=p.id
    order by position for share loop
    select * into receipt from public.video_scene_audio_receipts_v1
      where scene_id=s.id;
    if receipt.scene_id is null then return false; end if;
    select * into attempt from public.video_scene_audio_attempts_v1
      where scene_id=s.id;
    select * into o from storage.objects
      where bucket_id='client-media' and name=receipt.storage_path;
    v_expected_path:=p.client_id::text||'/video/projects/'||p.id::text||
      '/ir-v'||receipt.ir_version::text||'/scenes/'||s.scene_key||'/audio.mp3';
    if receipt.project_id is distinct from p.id
      or receipt.client_id is distinct from p.client_id
      or receipt.ir_version not between v_audio_version and p.ir_version
      or receipt.narration_sha256 is distinct from
        encode(sha256(convert_to(s.narration,'UTF8')),'hex')
      or receipt.storage_path is distinct from v_expected_path
      or receipt.storage_path is distinct from s.audio_path
      or receipt.alignment is distinct from s.alignment
      or receipt.duration_sec is distinct from s.duration_sec
      or attempt.scene_id is null or attempt.project_id is distinct from p.id
      or attempt.client_id is distinct from p.client_id
      or attempt.ir_version is distinct from receipt.ir_version
      or o.id is null or o.id is distinct from receipt.object_id
      or o.version is distinct from receipt.object_version
      or o.updated_at is distinct from receipt.object_updated_at then
      raise exception 'Scene audio evidence changed before completion.'
        using errcode='23514'; end if;
    update public.video_scene_audio_attempts_v1 set state='filed',
      filed_at=coalesce(filed_at,clock_timestamp())
      where scene_id=s.id and project_id=p.id
        and ir_version=receipt.ir_version and state='started';
    v_count:=v_count+1;
  end loop;
  if v_count<3 or v_count<>(select jsonb_array_length(p.ir->'scenes')) then
    raise exception 'Video audio scene count differs from the IR.'
      using errcode='23514'; end if;
  select * into music from public.video_project_music_attempts_v1
    where project_id=p.id;
  if music.project_id is null or music.state='started' then return true; end if;
  if music.client_id is distinct from p.client_id
    or music.ir_version is distinct from v_audio_version
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
      or music_receipt.ir_version is distinct from v_audio_version
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
      audio_ir_version=coalesce(p.audio_ir_version,p.ir_version),
      stage_error=case when music.state='filed' then
        'Audio and optional music verified; render and final review pending.'
        when music.state='failed' then
        'Narration ready; optional music failed: '||music.failure_code
        else 'Narration ready; optional music skipped.' end
      where id=p.id;
  end if;
  return true;
end $$;

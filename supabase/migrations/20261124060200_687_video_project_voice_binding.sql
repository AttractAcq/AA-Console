-- Bind one narrator voice to the frozen project brand and every scene receipt.
-- The first audio worker captures the managed default only when the client's
-- started brand snapshot has no narrator voice. Later workers reuse that ID.
alter table public.video_projects
  add column voice_id text
    check (voice_id is null or length(btrim(voice_id)) between 1 and 100);

create function public.video_project_voice_guard_v1()
returns trigger language plpgsql security definer
set search_path=pg_catalog,public as $$
begin
  if new.voice_id is distinct from old.voice_id then
    if old.voice_id is not null or new.voice_id is null
      or auth.role() is distinct from 'service_role'
      or current_setting('app.video_voice_bind_project',true)
        is distinct from old.id::text then
      raise exception 'Project narrator voice is immutable.'
        using errcode='23514';
    end if;
  end if;
  return new;
end $$;
revoke all on function public.video_project_voice_guard_v1()
  from public,anon,authenticated,service_role;
create trigger video_project_voice_guard_v1
  before update on public.video_projects for each row
  execute function public.video_project_voice_guard_v1();

create function public.bind_video_project_voice_v1(
  p_project_id uuid,p_ir_version integer,p_default_voice_id text
) returns text language plpgsql volatile security definer
set search_path=pg_catalog,public as $$
declare p public.video_projects%rowtype;
  v_brand_voice text;
  v_voice text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Service narrator binding only.' using errcode='42501'; end if;
  select * into p from public.video_projects where id=p_project_id for update;
  if p.id is null or p.ir_version is distinct from p_ir_version
    or p.stage not in ('timing','timed')
    or p.brand_snapshot is null
    or not public.video_project_source_current_v1(p.id) then
    raise exception 'Project narrator source is not current.'
      using errcode='23514'; end if;
  v_brand_voice:=nullif(btrim(p.brand_snapshot->>'narrator_voice_id'),'');
  if v_brand_voice is not null and length(v_brand_voice)>100 then
    raise exception 'Client narrator voice exceeds provider limit.'
      using errcode='22023'; end if;
  if p.voice_id is not null then
    if v_brand_voice is not null and p.voice_id is distinct from v_brand_voice then
      raise exception 'Bound narrator differs from started client brand.'
        using errcode='23514'; end if;
    return p.voice_id;
  end if;
  if p.stage is distinct from 'timing'
    or exists(select 1 from public.video_scene_audio_attempts_v1
      where project_id=p.id)
    or exists(select 1 from public.video_scene_audio_receipts_v1
      where project_id=p.id) then
    raise exception 'Historical audio cannot acquire a new narrator.'
      using errcode='23514'; end if;
  v_voice:=coalesce(v_brand_voice,nullif(btrim(p_default_voice_id),''));
  if v_voice is null or length(v_voice)>100 then
    raise exception 'A managed narrator voice is required.'
      using errcode='22023'; end if;
  perform set_config('app.video_voice_bind_project',p.id::text,true);
  update public.video_projects set voice_id=v_voice where id=p.id;
  return v_voice;
end $$;
revoke all on function public.bind_video_project_voice_v1(uuid,integer,text)
  from public,anon,authenticated,service_role;
grant execute on function public.bind_video_project_voice_v1(uuid,integer,text)
  to service_role;

create function public.video_scene_audio_voice_guard_v1()
returns trigger language plpgsql security definer
set search_path=pg_catalog,public as $$
declare v_voice text;
begin
  select voice_id into v_voice from public.video_projects
    where id=new.project_id;
  if v_voice is null or new.voice_id is distinct from v_voice then
    raise exception 'Scene narrator differs from the bound project voice.'
      using errcode='23514'; end if;
  return new;
end $$;
revoke all on function public.video_scene_audio_voice_guard_v1()
  from public,anon,authenticated,service_role;
create trigger video_scene_audio_voice_guard_v1
  before insert or update on public.video_scene_audio_receipts_v1
  for each row execute function public.video_scene_audio_voice_guard_v1();

comment on column public.video_projects.voice_id is
  'Immutable narrator ID selected from the started brand snapshot or first managed default, before any scene speech request.';

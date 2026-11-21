-- A failed critic can revise narration at most twice. The exact filed patch
-- advances the IR, archives old scene audio evidence, clears only changed
-- scenes, and atomically queues replacement audio jobs. Music and all other
-- scene audio retain their baseline receipts and Storage bytes.
create table public.video_project_narration_patches_v1 (
  attempt_id uuid primary key
    references public.video_project_prerender_attempts_v1(id),
  project_id uuid not null,
  client_id uuid not null,
  from_ir_version integer not null check(from_ir_version>0),
  to_ir_version integer not null check(to_ir_version=from_ir_version+1),
  source_job_id uuid not null references public.agent_jobs(id),
  old_ir jsonb not null check(jsonb_typeof(old_ir)='object'),
  new_ir jsonb not null check(jsonb_typeof(new_ir)='object'),
  changed_scene_ids text[] not null check(cardinality(changed_scene_ids)>0),
  next_job_ids uuid[] not null check(cardinality(next_job_ids)>0),
  applied_at timestamptz not null default clock_timestamp(),
  foreign key(project_id,client_id) references public.video_projects(id,client_id),
  unique(project_id,from_ir_version),
  unique(project_id,to_ir_version)
);
create index video_project_narration_patches_client_v1
  on public.video_project_narration_patches_v1
  (client_id,project_id,applied_at desc);
alter table public.video_project_narration_patches_v1 enable row level security;
create policy video_project_narration_patches_read_v1
  on public.video_project_narration_patches_v1 for select to authenticated
  using(public.can_access_client(client_id));
revoke all on public.video_project_narration_patches_v1
  from public,anon,authenticated,service_role;
grant select on public.video_project_narration_patches_v1
  to authenticated,service_role;

-- The older visual RPC counts visual revisions only. This trigger enforces
-- the shared two-revision budget for a visual patch after narration changed.
create function public.video_visual_patch_revision_budget_v1()
returns trigger language plpgsql security definer
set search_path=pg_catalog,public as $$
begin
  if (select count(*) from public.video_project_visual_patches_v1
      where project_id=new.project_id)
    + (select count(*) from public.video_project_narration_patches_v1
      where project_id=new.project_id)>=2 then
    raise exception 'Video critic revision budget is exhausted.'
      using errcode='23514'; end if;
  return new;
end $$;
revoke all on function public.video_visual_patch_revision_budget_v1()
  from public,anon,authenticated,service_role;
create trigger video_visual_patch_revision_budget_v1
  before insert on public.video_project_visual_patches_v1
  for each row execute function public.video_visual_patch_revision_budget_v1();

create function public.apply_video_project_narration_patch_v1(
  p_attempt_id uuid,p_job_id uuid,p_expected_ir_version integer,
  p_new_ir jsonb
) returns jsonb language plpgsql volatile security definer
set search_path=pg_catalog,public as $$
declare a public.video_project_prerender_attempts_v1%rowtype;
  p public.video_projects%rowtype;
  prior public.video_project_narration_patches_v1%rowtype;
  scene public.video_scenes%rowtype;
  receipt public.video_scene_audio_receipts_v1%rowtype;
  audio_attempt public.video_scene_audio_attempts_v1%rowtype;
  patch jsonb;
  old_scene jsonb;
  new_scene jsonb;
  v_ir jsonb;
  v_path text;
  v_parts text[];
  v_target text[];
  v_old jsonb;
  v_value jsonb;
  v_op text;
  v_scene_id text;
  v_index integer;
  v_count integer:=0;
  v_revisions integer;
  v_changed text[]:='{}'::text[];
  v_next_jobs uuid[]:='{}'::uuid[];
  v_next_job uuid;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Service narration critic patch only.' using errcode='42501'; end if;
  select * into a from public.video_project_prerender_attempts_v1
    where id=p_attempt_id for update;
  if a.id is null or a.job_id is distinct from p_job_id
    or a.ir_version is distinct from p_expected_ir_version
    or a.state is distinct from 'decided' or a.result is distinct from 'fail'
    or jsonb_typeof(a.report->'patch') is distinct from 'array'
    or jsonb_array_length(a.report->'patch') not between 1 and 40 then
    raise exception 'Narration patch needs one exact failed critic report.'
      using errcode='23514'; end if;
  select * into p from public.video_projects where id=a.project_id for update;
  select * into prior from public.video_project_narration_patches_v1
    where attempt_id=a.id;
  if prior.attempt_id is not null then
    if prior.source_job_id is distinct from p_job_id
      or prior.from_ir_version is distinct from p_expected_ir_version
      or prior.new_ir is distinct from p_new_ir
      or p.ir_version is distinct from prior.to_ir_version
      or p.ir is distinct from prior.new_ir then
      raise exception 'Narration patch replay differs from the committed IR.'
        using errcode='23514'; end if;
    return jsonb_build_object('ir_version',prior.to_ir_version,
      'job_ids',to_jsonb(prior.next_job_ids),'replayed',true);
  end if;
  select count(*) into v_revisions from (
    select attempt_id from public.video_project_visual_patches_v1
      where project_id=p.id
    union all
    select attempt_id from public.video_project_narration_patches_v1
      where project_id=p.id) revisions;
  if p.id is null or p.client_id is distinct from a.client_id
    or p.ir_version is distinct from a.ir_version
    or p.stage is distinct from 'timed' or p.audio_ir_version is null
    or not public.video_project_source_current_v1(p.id)
    or not public.complete_video_audio_project_v1(p.id,p.ir_version)
    or exists(select 1 from public.video_project_render_attempts_v1 r
      where r.project_id=p.id and r.ir_version=p.ir_version)
    or v_revisions>=2 then
    raise exception 'Narration patch is stale, exhausted or has a render attempt.'
      using errcode='23514'; end if;
  if p_new_ir is null or jsonb_typeof(p_new_ir) is distinct from 'object'
    or jsonb_typeof(p_new_ir->'scenes') is distinct from 'array'
    or jsonb_array_length(p_new_ir->'scenes')
      is distinct from jsonb_array_length(p.ir->'scenes') then
    raise exception 'Narration patch produced an invalid IR envelope.'
      using errcode='22023'; end if;
  v_ir:=p.ir;
  for patch in select value from jsonb_array_elements(a.report->'patch') loop
    v_op:=patch->>'op';
    v_scene_id:=patch->>'sceneId';
    select (ord-1)::integer into v_index
      from jsonb_array_elements(v_ir->'scenes') with ordinality as item(value,ord)
      where item.value->>'id'=v_scene_id;
    if v_index is null then
      raise exception 'Critic patch scene is missing.' using errcode='23514'; end if;
    old_scene:=v_ir->'scenes'->v_index;
    if old_scene->>'locked'='true' then
      raise exception 'Locked scene cannot be patched.' using errcode='23514'; end if;
    v_value:=patch->'value';
    v_path:=patch->>'path';
    if v_op in ('set_prop','shorten_text') then
      if v_path='narration' then
        if jsonb_typeof(v_value) is distinct from 'string'
          or length(btrim(v_value#>>'{}')) not between 1 and 600
          or v_value is not distinct from old_scene->'narration'
          or (v_op='shorten_text' and length(v_value#>>'{}')>=
            length(old_scene->>'narration')) then
          raise exception 'Critic narration must change and remain valid.'
            using errcode='23514'; end if;
        v_ir:=jsonb_set(v_ir,array['scenes',v_index::text,'narration'],
          v_value,false);
        if not v_scene_id=any(v_changed) then
          v_changed:=array_append(v_changed,v_scene_id); end if;
      else
        if v_path is null or v_path !~ '^props(\.[A-Za-z0-9_]+)+$'
          or v_path ~ '(^|\.)(__proto__|prototype|constructor)(\.|$)' then
          raise exception 'Critic patch path is not an existing prop.'
            using errcode='23514'; end if;
        v_parts:=string_to_array(v_path,'.');
        v_target:=array['scenes',v_index::text]||v_parts;
        v_old:=v_ir#>v_target;
        if v_old is null or v_value is null or v_value=v_old then
          raise exception 'Critic prop patch is missing or unchanged.'
            using errcode='23514'; end if;
        if v_op='shorten_text' and (
          jsonb_typeof(v_old) is distinct from 'string'
          or jsonb_typeof(v_value) is distinct from 'string'
          or length(btrim(v_value#>>'{}'))=0
          or length(v_value#>>'{}')>=length(v_old#>>'{}')) then
          raise exception 'Shortened text must be shorter and nonempty.'
            using errcode='23514'; end if;
        v_ir:=jsonb_set(v_ir,v_target,v_value,false);
      end if;
    elsif v_op='set_min_duration' then
      if v_path is not null or jsonb_typeof(v_value) is distinct from 'number'
        or (v_value::text)::numeric not between 2 and 25
        or (v_value::text)::numeric<=coalesce(
          (old_scene->>'minDurationSec')::numeric,0) then
        raise exception 'Critic duration must increase within 2–25 seconds.'
          using errcode='23514'; end if;
      v_ir:=jsonb_set(v_ir,array['scenes',v_index::text,'minDurationSec'],
        v_value,true);
    elsif v_op='set_transition' then
      if v_path is not null or jsonb_typeof(v_value) is distinct from 'string'
        or v_value#>>'{}' not in ('cut','fade','slideLeft','slideUp','wipeBrand')
        or v_value#>>'{}' is not distinct from
          coalesce(old_scene->>'transitionIn','cut') then
        raise exception 'Critic transition is invalid or unchanged.'
          using errcode='23514'; end if;
      v_ir:=jsonb_set(v_ir,array['scenes',v_index::text,'transitionIn'],
        v_value,true);
    else
      raise exception 'Critic patch operation is unsupported.' using errcode='23514';
    end if;
  end loop;
  if cardinality(v_changed)=0 or v_ir is distinct from p_new_ir then
    raise exception 'Proposed IR differs from the filed narration operations.'
      using errcode='23514'; end if;
  for scene in select * from public.video_scenes where project_id=p.id
    order by position for update loop
    old_scene:=p.ir->'scenes'->(scene.position-1);
    new_scene:=p_new_ir->'scenes'->(scene.position-1);
    if old_scene->>'id' is distinct from scene.scene_key
      or old_scene->>'component' is distinct from scene.component
      or old_scene->'props' is distinct from scene.props
      or old_scene->>'narration' is distinct from scene.narration
      or coalesce(old_scene->>'transitionIn','cut')
        is distinct from scene.transition_in
      or (old_scene->>'minDurationSec')::numeric
        is distinct from scene.min_duration_sec
      or coalesce((old_scene->>'locked')::boolean,false)
        is distinct from scene.locked
      or new_scene->>'id' is distinct from scene.scene_key
      or new_scene->>'component' is distinct from scene.component
      or coalesce((new_scene->>'locked')::boolean,false)
        is distinct from scene.locked then
      raise exception 'Scene row differs from the exact IR.' using errcode='23514';
    end if;
    if scene.scene_key=any(v_changed) then
      select * into receipt from public.video_scene_audio_receipts_v1
        where scene_id=scene.id for update;
      select * into audio_attempt from public.video_scene_audio_attempts_v1
        where scene_id=scene.id for update;
      if receipt.scene_id is null or audio_attempt.scene_id is null
        or audio_attempt.state is distinct from 'filed'
        or receipt.ir_version is distinct from audio_attempt.ir_version
        or receipt.narration_sha256 is distinct from
          encode(sha256(convert_to(scene.narration,'UTF8')),'hex')
        or receipt.storage_path is distinct from scene.audio_path then
        raise exception 'Old scene audio evidence is incomplete.'
          using errcode='23514'; end if;
      insert into public.video_scene_audio_revisions_v1
        (scene_id,project_id,client_id,ir_version,source_attempt_id,
          narration,receipt,attempt)
      values(scene.id,p.id,p.client_id,receipt.ir_version,a.id,
        scene.narration,to_jsonb(receipt),to_jsonb(audio_attempt));
      delete from public.video_scene_audio_receipts_v1 where scene_id=scene.id;
      delete from public.video_scene_audio_attempts_v1 where scene_id=scene.id;
      update public.video_scenes set props=new_scene->'props',
        narration=new_scene->>'narration',
        transition_in=coalesce(new_scene->>'transitionIn','cut'),
        min_duration_sec=(new_scene->>'minDurationSec')::numeric,
        audio_path=null,alignment=null,duration_sec=null
        where id=scene.id;
    else
      if new_scene->>'narration' is distinct from scene.narration then
        raise exception 'Unlisted scene narration changed.' using errcode='23514'; end if;
      update public.video_scenes set props=new_scene->'props',
        transition_in=coalesce(new_scene->>'transitionIn','cut'),
        min_duration_sec=(new_scene->>'minDurationSec')::numeric
        where id=scene.id;
    end if;
    v_count:=v_count+1;
  end loop;
  if v_count is distinct from jsonb_array_length(p.ir->'scenes') then
    raise exception 'Narration patch scene set is incomplete.' using errcode='23514'; end if;
  update public.video_projects set ir=p_new_ir,ir_version=p.ir_version+1,
    stage='timing',
    stage_error='Narration critic patch committed; changed scene audio pending.'
    where id=p.id;
  for scene in select * from public.video_scenes
    where project_id=p.id and scene_key=any(v_changed)
    order by position loop
    insert into public.agent_jobs(agent_key,client_id,input_table,input_id,
      created_by,params)
    values('video_audio',p.client_id,'video_scenes',scene.id,p.started_by,
      jsonb_build_object('project_id',p.id,'ir_version',p.ir_version+1,
        'scene_key',scene.scene_key,'narration_sha256',
        encode(sha256(convert_to(scene.narration,'UTF8')),'hex')))
    returning id into v_next_job;
    insert into public.agent_job_events(job_id,description,payload)
    values(v_next_job,'Queued: revised video scene audio',
      jsonb_build_object('project_id',p.id,'ir_version',p.ir_version+1,
        'scene_key',scene.scene_key,'critic_attempt_id',a.id));
    v_next_jobs:=array_append(v_next_jobs,v_next_job);
  end loop;
  insert into public.video_project_narration_patches_v1
    (attempt_id,project_id,client_id,from_ir_version,to_ir_version,
      source_job_id,old_ir,new_ir,changed_scene_ids,next_job_ids)
  values(a.id,p.id,p.client_id,p.ir_version,p.ir_version+1,
    p_job_id,p.ir,p_new_ir,v_changed,v_next_jobs);
  return jsonb_build_object('ir_version',p.ir_version+1,
    'job_ids',to_jsonb(v_next_jobs),'replayed',false);
end $$;
revoke all on function public.apply_video_project_narration_patch_v1(
  uuid,uuid,integer,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.apply_video_project_narration_patch_v1(
  uuid,uuid,integer,jsonb) to service_role;

create or replace function public.resolve_video_project_critic_failure_v1(
  p_attempt_id uuid,p_job_id uuid
) returns text language plpgsql volatile security definer
set search_path=pg_catalog,public as $$
declare a public.video_project_prerender_attempts_v1%rowtype;
  p public.video_projects%rowtype;
  v_patches integer;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Service critic failure resolution only.' using errcode='42501'; end if;
  select * into a from public.video_project_prerender_attempts_v1
    where id=p_attempt_id for update;
  select * into p from public.video_projects where id=a.project_id for update;
  if a.id is null or p.id is null or a.job_id is distinct from p_job_id
    or a.project_id is distinct from p.id
    or a.client_id is distinct from p.client_id
    or a.state is distinct from 'decided' or a.result is distinct from 'fail'
    or a.ir_version is distinct from p.ir_version
    or p.stage not in ('timed','needs_human') then
    raise exception 'Critic failure differs from the current version.'
      using errcode='23514'; end if;
  select count(*) into v_patches from (
    select attempt_id from public.video_project_visual_patches_v1
      where project_id=p.id
    union all
    select attempt_id from public.video_project_narration_patches_v1
      where project_id=p.id) revisions;
  if v_patches>=2 then
    update public.video_projects set stage='needs_human',
      stage_error='Third failed pre-render review; human revision required.'
      where id=p.id;
    return 'needs_human';
  end if;
  if p.stage='needs_human'
    or jsonb_array_length(a.report->'patch')=0 then
    return 'needs_human';
  end if;
  if exists(select 1 from jsonb_array_elements(a.report->'patch') patch
      where patch->>'path'='narration') then
    return 'timing_required';
  end if;
  return 'visual_patch';
end $$;

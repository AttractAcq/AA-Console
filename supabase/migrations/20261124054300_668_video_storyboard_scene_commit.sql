-- Commit a reviewed storyboard and its scene rows together. This still stops
-- at human review; it does not advance to audio or render.
alter function public.video_project_source_current_v1(uuid) volatile;

create function public.commit_video_storyboard_v1(
  p_project_id uuid, p_job_id uuid, p_expected_ir_version integer,
  p_ir jsonb, p_script jsonb, p_stage_error text
) returns integer language plpgsql volatile security definer
set search_path=pg_catalog,public as $$
declare p public.video_projects%rowtype;
  entry jsonb; scene jsonb; citation jsonb;
  v_count integer; v_position integer := 0;
  v_key text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Service video storyboard commit only.' using errcode='42501'; end if;
  select * into p from public.video_projects where id=p_project_id for update;
  if not found or p.stage<>'scripting' or p.job_id is distinct from p_job_id
    or p.ir_version is distinct from p_expected_ir_version
    or p.source_digest is null then
    raise exception 'Video project is not the exact scripting attempt.'
      using errcode='23514'; end if;
  if exists(select 1 from public.video_scenes where project_id=p.id) then
    raise exception 'Video scenes already exist for this project.'
      using errcode='23514'; end if;
  -- Hold the linked rows through commit so a concurrent source change cannot
  -- invalidate the final check between reading and writing the storyboard.
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
  if not public.video_project_source_current_v1(p.id) then
    raise exception 'Video source or route is no longer current.'
      using errcode='23514'; end if;
  if jsonb_typeof(p_ir) is distinct from 'object'
    or p_ir->>'version' is distinct from '1'
    or jsonb_typeof(p_ir->'scenes') is distinct from 'array'
    or jsonb_typeof(p_script) is distinct from 'object'
    or p_script->>'source_digest' is distinct from p.source_digest
    or jsonb_typeof(p_script->'scene_sources') is distinct from 'array'
    or jsonb_typeof(p_script->'independent_review') is distinct from 'object'
    or nullif(btrim(p_stage_error),'') is null or length(p_stage_error)>1000 then
    raise exception 'Video storyboard packet is invalid.' using errcode='22023'; end if;
  v_count:=jsonb_array_length(p_ir->'scenes');
  if v_count not between 3 and 40
    or jsonb_array_length(p_script->'scene_sources')<>v_count then
    raise exception 'Video scene count or citations are invalid.'
      using errcode='22023'; end if;
  for scene in select value from jsonb_array_elements(p_ir->'scenes') loop
    v_position:=v_position+1;
    v_key:='s'||lpad(v_position::text,2,'0');
    citation:=p_script->'scene_sources'->(v_position-1);
    if jsonb_typeof(scene) is distinct from 'object'
      or scene->>'id' is distinct from v_key
      or jsonb_typeof(scene->'props') is distinct from 'object'
      or nullif(btrim(scene->>'component'),'') is null
      or nullif(btrim(scene->>'narration'),'') is null
      or citation->>'sceneId' is distinct from v_key
      or jsonb_typeof(citation->'sourceIds') is distinct from 'array'
      or jsonb_array_length(citation->'sourceIds')<1 then
      raise exception 'Video scene % is invalid.',v_key using errcode='22023'; end if;
    if exists(select 1 from jsonb_array_elements_text(citation->'sourceIds') as source(id)
      where not exists(select 1 from jsonb_array_elements(p.source_snapshot) as snap(value)
        where snap.value->>'id'=source.id)
      and not (source.id='operator_prompt' and jsonb_array_length(p.source_snapshot)=0)) then
      raise exception 'Video scene % cites an unavailable source.',v_key
        using errcode='23514'; end if;
    insert into public.video_scenes(project_id,client_id,position,scene_key,
      component,props,narration,transition_in,min_duration_sec,chapter,locked)
    values(p.id,p.client_id,v_position,v_key,scene->>'component',
      scene->'props',scene->>'narration',coalesce(scene->>'transitionIn','cut'),
      (scene->>'minDurationSec')::numeric,
      coalesce((scene->>'chapter')::boolean,false),
      coalesce((scene->>'locked')::boolean,false));
  end loop;
  update public.video_projects set ir=p_ir,script=p_script,
    ir_version=p.ir_version+1,stage='needs_human',stage_error=p_stage_error
    where id=p.id;
  return p.ir_version+1;
end $$;
revoke all on function public.commit_video_storyboard_v1(
  uuid,uuid,integer,jsonb,jsonb,text)
  from public,anon,authenticated,service_role;
grant execute on function public.commit_video_storyboard_v1(
  uuid,uuid,integer,jsonb,jsonb,text)
  to service_role;

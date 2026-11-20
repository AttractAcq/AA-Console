-- One estimated Eleven v3 charge per successful scene synthesis response.
-- The provider can charge an uncertain request before an error reaches us;
-- such attempts remain held for manual reconciliation, never silently retried.
create function public.record_video_scene_speech_cost_v1(
  p_project_id uuid, p_scene_id uuid, p_job_id uuid,
  p_ir_version integer, p_attempt integer, p_units integer, p_usd numeric
) returns uuid language plpgsql volatile security definer
set search_path=pg_catalog,public as $$
declare p public.video_projects%rowtype;
  s public.video_scenes%rowtype;
  j public.agent_jobs%rowtype;
  a public.video_scene_audio_attempts_v1%rowtype;
  saved public.video_project_costs%rowtype;
  v_key text;
  v_id uuid;
  v_expected numeric(12,6);
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Service video speech cost only.' using errcode='42501'; end if;
  if p_attempt is null or p_attempt not between 1 and 2
    or p_units is null or p_units<1
    or p_usd is null or p_usd<0 then
    raise exception 'Invalid video speech cost units.' using errcode='22023'; end if;
  select * into p from public.video_projects where id=p_project_id for update;
  select * into s from public.video_scenes where id=p_scene_id;
  select * into j from public.agent_jobs where id=p_job_id;
  select * into a from public.video_scene_audio_attempts_v1 where scene_id=p_scene_id;
  if p.id is null or s.id is null or j.id is null or a.scene_id is null
    or p.stage not in ('timing','timed')
    or p.ir_version is distinct from p_ir_version
    or s.project_id is distinct from p.id or s.client_id is distinct from p.client_id
    or j.agent_key is distinct from 'video_audio'
    or j.input_table is distinct from 'video_scenes'
    or j.input_id is distinct from s.id or j.client_id is distinct from p.client_id
    or j.params->>'project_id' is distinct from p.id::text
    or j.params->>'ir_version' is distinct from p_ir_version::text
    or j.params->>'scene_key' is distinct from s.scene_key
    or j.params->>'narration_sha256' is distinct from
      encode(sha256(convert_to(s.narration,'UTF8')),'hex')
    or a.project_id is distinct from p.id or a.client_id is distinct from p.client_id
    or a.job_id is distinct from j.id or a.ir_version is distinct from p_ir_version
    or a.state is distinct from 'started'
    or p_units is distinct from char_length(s.narration)
    or not public.video_project_source_current_v1(p.id) then
    raise exception 'Speech cost is not bound to the current scene attempt.'
      using errcode='23514'; end if;
  v_expected:=round((p_units::numeric * 0.10 / 1000),6);
  if p_usd is distinct from v_expected then
    raise exception 'Speech cost estimate does not match the reviewed rate.'
      using errcode='22023'; end if;
  v_key:='video-audio:'||j.id::text||':tts:'||p_attempt::text;
  insert into public.video_project_costs(project_id,client_id,job_id,stage,
    provider,units,unit,usd,attempt_key)
  values(p.id,p.client_id,j.id,'audio','elevenlabs_v3_estimate',p_units,
    'characters',p_usd,v_key)
  on conflict(attempt_key) do nothing returning id into v_id;
  if v_id is null then
    select * into saved from public.video_project_costs where attempt_key=v_key;
    if saved.id is null or saved.project_id is distinct from p.id
      or saved.client_id is distinct from p.client_id
      or saved.job_id is distinct from j.id
      or saved.stage is distinct from 'audio'
      or saved.provider is distinct from 'elevenlabs_v3_estimate'
      or saved.units is distinct from p_units
      or saved.unit is distinct from 'characters'
      or saved.usd is distinct from p_usd then
      raise exception 'Speech cost key was reused with different evidence.'
        using errcode='23514'; end if;
    return saved.id;
  end if;
  update public.video_projects set cost_usd=cost_usd+p_usd where id=p.id;
  return v_id;
end $$;
revoke all on function public.record_video_scene_speech_cost_v1(
  uuid,uuid,uuid,integer,integer,integer,numeric)
  from public,anon,authenticated,service_role;
grant execute on function public.record_video_scene_speech_cost_v1(
  uuid,uuid,uuid,integer,integer,integer,numeric) to service_role;

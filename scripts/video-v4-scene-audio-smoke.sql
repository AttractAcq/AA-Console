-- Rollback-only exact-scene audio receipt fixture. No real Storage bytes or
-- external speech request are made; runtime tests verify byte read-back.
begin;
insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
values ('f1111111-1111-4111-8111-111111111111',
  '00000000-0000-0000-0000-000000000000','authenticated','authenticated',
  'video-audio-admin@example.invalid','',now(),now());
insert into public.profiles(id,role,email)
values ('f1111111-1111-4111-8111-111111111111','admin',
  'video-audio-admin@example.invalid');
insert into public.clients(id,name,initials)
values ('f2222222-2222-4222-8222-222222222222','Video audio fixture','VA');
select set_config('request.jwt.claim.sub',
  'f1111111-1111-4111-8111-111111111111',true);
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claims',
  '{"sub":"f1111111-1111-4111-8111-111111111111","role":"authenticated","aal":"aal2"}',true);
update public.agents set paused=false where agent_key='video_script';

do $checks$
declare p public.video_projects%rowtype; s public.video_scenes%rowtype;
  o storage.objects%rowtype; path text; job uuid; audio_job uuid;
  first_cost uuid;
  narration_hash text; audio_hash text:=repeat('a',64);
  words jsonb:='[{"text":"Hello.","startSec":0.1,"endSec":2.1,"loss":0.05}]'::jsonb;
begin
  p:=public.create_video_project_draft_v1(
    'f2222222-2222-4222-8222-222222222222',
    'Explain reviewed evidence to a local buyer.',
    'Local buyers','calm',90,array['16:9'],null,null,null,'audio-receipt');
  job:=public.start_video_project_v1(p.id,0,array[]::uuid[],
    'The exact operator prompt is the reviewed source.');
  perform set_config('request.jwt.claim.role','service_role',true);
  update public.video_projects set stage='timing',ir_version=1 where id=p.id;
  insert into public.video_scenes(project_id,client_id,position,scene_key,
    component,props,narration)
  values(p.id,p.client_id,1,'s01','TitleCard','{}'::jsonb,'Hello.')
  returning * into s;
  path:=p.client_id::text||'/video/projects/'||p.id::text||
    '/ir-v1/scenes/s01/audio.mp3';
  narration_hash:=encode(sha256(convert_to(s.narration,'UTF8')),'hex');
  insert into public.agent_jobs(agent_key,client_id,input_table,input_id,
    created_by,params)
  values('video_audio',p.client_id,'video_scenes',s.id,p.started_by,
    jsonb_build_object('project_id',p.id,'ir_version',1,
      'scene_key','s01','narration_sha256',narration_hash))
  returning id into audio_job;
  if not public.begin_video_scene_audio_attempt_v1(p.id,s.id,audio_job,1) then
    raise exception 'Exact speech attempt did not begin'; end if;
  first_cost:=public.record_video_scene_speech_cost_v1(
    p.id,s.id,audio_job,1,1,6,0.000600);
  if public.record_video_scene_speech_cost_v1(
    p.id,s.id,audio_job,1,1,6,0.000600) is distinct from first_cost then
    raise exception 'Speech cost replay was not idempotent'; end if;
  begin
    perform public.record_video_scene_speech_cost_v1(
      p.id,s.id,audio_job,1,2,7,0.000700);
    raise exception 'Wrong narration units were accepted';
  exception when check_violation then null; end;
  perform public.record_video_scene_speech_cost_v1(
    p.id,s.id,audio_job,1,2,6,0.000600);
  if (select count(*) from public.video_project_costs
      where project_id=p.id and stage='audio')<>2
    or (select cost_usd from public.video_projects where id=p.id)
      is distinct from 0.0012 then
    raise exception 'Per-attempt speech cost was duplicated or lost'; end if;
  insert into storage.objects(id,bucket_id,name,version)
  values ('f5555555-5555-4555-8555-555555555555',
    'client-media',path,'v1') returning * into o;
  if not public.video_project_source_current_v1(p.id) then
    raise exception 'Reviewed source did not remain current in timing'; end if;
  if public.video_scene_audio_upload_target_v1(p.id,s.id)->>'storage_path'
    is distinct from path then
    raise exception 'Audio upload target did not bind the exact scene'; end if;
  if (public.video_scene_audio_storage_identity_v1(p.id,s.id)->>'object_id')::uuid
    is distinct from o.id then
    raise exception 'Storage inspection did not bind the exact object'; end if;
  perform set_config('request.jwt.claim.role','authenticated',true);
  begin
    perform public.commit_video_scene_audio_v1(p.id,s.id,1,narration_hash,
      audio_hash,path,1024,o.id,o.version,o.updated_at,words,0.05,
      2.2,-16,'narrator-1',1);
    raise exception 'Browser committed scene audio';
  exception when insufficient_privilege then null; end;
  perform set_config('request.jwt.claim.role','service_role',true);
  begin
    perform public.commit_video_scene_audio_v1(p.id,s.id,1,
      repeat('b',64),audio_hash,path,1024,o.id,o.version,o.updated_at,
      words,0.05,2.2,-16,'narrator-1',1);
    raise exception 'Wrong narration hash committed';
  exception when invalid_parameter_value then null; end;
  if exists(select 1 from public.video_scene_audio_receipts_v1
    where scene_id=s.id) then raise exception 'Failed commit left a receipt'; end if;
  if public.commit_video_scene_audio_v1(p.id,s.id,1,narration_hash,
      audio_hash,path,1024,o.id,o.version,o.updated_at,words,0.05,
      2.2,-16,'narrator-1',1) is distinct from s.id then
    raise exception 'Commit returned the wrong scene'; end if;
  if public.commit_video_scene_audio_v1(p.id,s.id,1,narration_hash,
      audio_hash,path,1024,o.id,o.version,o.updated_at,words,0.05,
      2.2,-16,'narrator-1',1) is distinct from s.id then
    raise exception 'Exact replay was not idempotent'; end if;
  if (select audio_path from public.video_scenes where id=s.id)
      is distinct from path or
    (select count(*) from public.video_scene_audio_receipts_v1
      where scene_id=s.id)<>1 then
    raise exception 'Scene and receipt were not committed together'; end if;
  begin
    perform public.commit_video_scene_audio_v1(p.id,s.id,1,narration_hash,
      repeat('c',64),path,1024,o.id,o.version,o.updated_at,
      words,0.05,2.2,-16,'narrator-1',1);
    raise exception 'Different replay was accepted';
  exception when check_violation then null; end;
  update storage.objects set version='v2' where id=o.id;
  begin
    perform public.commit_video_scene_audio_v1(p.id,s.id,1,narration_hash,
      audio_hash,path,1024,o.id,o.version,o.updated_at,words,0.05,
      2.2,-16,'narrator-1',1);
    raise exception 'Replaced object was accepted';
  exception when check_violation then null; end;
  if (select count(*) from public.video_scene_audio_receipts_v1
    where scene_id=s.id)<>1 then raise exception 'Receipt changed after rejection'; end if;
end $checks$;
rollback;

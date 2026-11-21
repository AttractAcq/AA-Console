-- Rollback-only exact project music outcome fixture. Storage metadata is
-- disposable; runtime tests separately verify uploaded bytes by read-back.
begin;
insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
values ('e1111111-1111-4111-8111-111111111111',
  '00000000-0000-0000-0000-000000000000','authenticated','authenticated',
  'video-music-admin@example.invalid','',now(),now());
insert into public.profiles(id,role,email)
values ('e1111111-1111-4111-8111-111111111111','admin',
  'video-music-admin@example.invalid');
insert into public.clients(id,name,initials)
values ('e2222222-2222-4222-8222-222222222222','Video music fixture','VM');
select set_config('request.jwt.claim.sub',
  'e1111111-1111-4111-8111-111111111111',true);
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claims',
  '{"sub":"e1111111-1111-4111-8111-111111111111","role":"authenticated","aal":"aal2"}',true);
update public.agents set paused=false where agent_key='video_script';

do $checks$
declare p public.video_projects%rowtype;
  s public.video_scenes%rowtype;
  o storage.objects%rowtype;
  script_job uuid; audio_job uuid; first_cost uuid;
  music_job uuid; v_music_path text; scene_path text;
  prompt text:='instrumental, no vocals, warm piano, calm, loopable, suitable for an educational explainer';
  song_hash text:=repeat('b',64);
  narration_hash text;
  entry jsonb;
  result jsonb;
begin
  p:=public.create_video_project_draft_v1(
    'e2222222-2222-4222-8222-222222222222',
    'Explain reviewed evidence to a local buyer.',
    'Local buyers','calm',90,array['16:9'],null,null,null,'music-receipt');
  script_job:=public.start_video_project_v1(p.id,0,array[]::uuid[],
    'The exact operator prompt is the reviewed source.');
  perform set_config('request.jwt.claim.role','service_role',true);
  update public.video_projects set stage='timing',ir_version=1,
    ir='{"music":{"enabled":true,"mood":"warm piano"},"scenes":[{"id":"s01"},{"id":"s02"},{"id":"s03"}]}'::jsonb
    where id=p.id;
  if public.bind_video_project_voice_v1(p.id,1,'narrator-1')
      is distinct from 'narrator-1' then
    raise exception 'Project narrator was not bound'; end if;
  for entry in select value from jsonb_array_elements(
    '[{"key":"s01","narration":"Hello one."},
      {"key":"s02","narration":"Hello two."},
      {"key":"s03","narration":"Hello three."}]'::jsonb) loop
    insert into public.video_scenes(project_id,client_id,position,scene_key,
      component,props,narration)
    values(p.id,p.client_id,substring(entry->>'key' from 2)::integer,
      entry->>'key','TitleCard','{}'::jsonb,entry->>'narration')
    returning * into s;
    narration_hash:=encode(sha256(convert_to(s.narration,'UTF8')),'hex');
    insert into public.agent_jobs(agent_key,client_id,input_table,input_id,
      created_by,params)
    values('video_audio',p.client_id,'video_scenes',s.id,p.started_by,
      jsonb_build_object('project_id',p.id,'ir_version',1,
        'scene_key',s.scene_key,'narration_sha256',narration_hash))
    returning id into audio_job;
    if not public.begin_video_scene_audio_attempt_v1(p.id,s.id,audio_job,1) then
      raise exception 'Scene audio attempt was not bound'; end if;
    scene_path:=p.client_id::text||'/video/projects/'||p.id::text||
      '/ir-v1/scenes/'||s.scene_key||'/audio.mp3';
    insert into storage.objects(bucket_id,name,version)
    values('client-media',scene_path,'v1') returning * into o;
    perform public.commit_video_scene_audio_v1(p.id,s.id,1,narration_hash,
      repeat('a',64),scene_path,1024,o.id,o.version,o.updated_at,
      '[{"text":"Hello","startSec":0.1,"endSec":1.5,"loss":0.05}]'::jsonb,
      0.05,4,-16,'narrator-1',1);
  end loop;
  if not public.complete_video_audio_project_v1(p.id,1) then
    raise exception 'Scene receipts were incomplete'; end if;
  if (select stage from public.video_projects where id=p.id)<>'timing' then
    raise exception 'Scenes advanced before music was settled'; end if;
  select id into music_job from public.agent_jobs where client_id=p.client_id
    and agent_key='video_audio' and params->>'scene_key'='s03';
  result:=public.begin_video_project_music_v1(
    p.id,music_job,1,true,prompt,15000);
  if result->>'state' is distinct from 'started' then
    raise exception 'Music attempt was not unique'; end if;
  if (select stage_error from public.video_projects where id=p.id)
      not like 'Optional music is in progress%' then
    raise exception 'Stalled music attempt is not visible to the operator'; end if;
  result:=public.begin_video_project_music_v1(
    p.id,music_job,1,true,prompt,15000);
  if result->>'state' is distinct from 'already_started' then
    raise exception 'Concurrent music attempt was not held'; end if;
  if public.video_project_music_storage_exists_v1(p.id,1) then
    raise exception 'Music preflight found a nonexistent file'; end if;
  first_cost:=public.record_video_project_music_cost_v1(
    p.id,music_job,1,15000,0.037500);
  if public.record_video_project_music_cost_v1(
    p.id,music_job,1,15000,0.037500) is distinct from first_cost then
    raise exception 'Music cost replay duplicated the charge'; end if;
  begin
    perform public.record_video_project_music_cost_v1(
      p.id,music_job,1,15000,0.040000);
    raise exception 'Wrong music cost was accepted';
  exception when invalid_parameter_value then null; end;
  v_music_path:=p.client_id::text||'/video/projects/'||p.id::text||
    '/ir-v1/music.mp3';
  insert into storage.objects(bucket_id,name,version)
    values('client-media',v_music_path,'v1') returning * into o;
  if (public.video_project_music_storage_identity_v1(p.id,1)->>'object_id')::uuid
    is distinct from o.id then
    raise exception 'Music Storage identity did not bind the object'; end if;
  perform public.commit_video_project_music_v1(
    p.id,music_job,1,v_music_path,song_hash,2048,o.id,o.version,o.updated_at,
    15,-24,prompt,'song-fixture',15000);
  if not public.complete_video_audio_project_v1(p.id,1) then
    raise exception 'Completed music did not pass audio verification'; end if;
  if (select stage from public.video_projects where id=p.id)<>'timed'
    or (select music_path from public.video_projects where id=p.id)
      is distinct from v_music_path
    or (select count(*) from public.video_project_costs
      where project_id=p.id and stage='music')<>1 then
    raise exception 'Music receipt did not advance one exact project: stage=%, path=%, expected=%, costs=%',
      (select stage from public.video_projects where id=p.id),
      (select music_path from public.video_projects where id=p.id),
      v_music_path,
      (select count(*) from public.video_project_costs
        where project_id=p.id and stage='music'); end if;
  update storage.objects set version='v2' where id=o.id;
  begin
    perform public.complete_video_audio_project_v1(p.id,1);
    raise exception 'Replaced music object was accepted';
  exception when check_violation then null; end;
  perform set_config('request.jwt.claim.role','authenticated',true);
  begin
    perform public.begin_video_project_music_v1(p.id,music_job,1,
      true,prompt,15000);
    raise exception 'Browser started music';
  exception when insufficient_privilege then null; end;
end $checks$;
rollback;

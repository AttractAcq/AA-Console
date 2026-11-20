-- Disposable rollback fixture: one exact project render claim and provider
-- handle, plus the unresolved-start path. No Lambda call is made.
begin;
insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
values ('f1111111-1111-4111-8111-111111111111',
  '00000000-0000-0000-0000-000000000000','authenticated','authenticated',
  'video-render-admin@example.invalid','',now(),now());
insert into public.profiles(id,role,email)
values ('f1111111-1111-4111-8111-111111111111','admin',
  'video-render-admin@example.invalid');
insert into public.clients(id,name,initials)
values ('f2222222-2222-4222-8222-222222222222','Video render fixture','VR');
select set_config('request.jwt.claim.sub',
  'f1111111-1111-4111-8111-111111111111',true);
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claims',
  '{"sub":"f1111111-1111-4111-8111-111111111111","role":"authenticated","aal":"aal2"}',true);
update public.agents set paused=false where agent_key='video_script';

do $checks$
declare p public.video_projects%rowtype;
  s public.video_scenes%rowtype;
  o storage.objects%rowtype;
  script_job uuid; audio_job uuid; render_job uuid;
  render_attempt uuid; second_attempt uuid;
  scene_path text; narration_hash text;
  entry jsonb; result jsonb;
  out_name text;
  candidate_path text; candidate_id uuid; candidate_probe jsonb;
begin
  p:=public.create_video_project_draft_v1(
    'f2222222-2222-4222-8222-222222222222',
    'Explain verified information to a local buyer.',
    'Local buyers','calm',90,array['16:9','9:16'],
    null,null,null,'render-attempt');
  script_job:=public.start_video_project_v1(p.id,0,array[]::uuid[],
    'The exact operator prompt is the reviewed source.');
  perform set_config('request.jwt.claim.role','service_role',true);
  update public.video_projects set stage='timing',ir_version=1,
    ir='{"music":{"enabled":false,"mood":""},"scenes":[{"id":"s01"},{"id":"s02"},{"id":"s03"}]}'::jsonb
    where id=p.id;
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
  select id into audio_job from public.agent_jobs where client_id=p.client_id
    and agent_key='video_audio' and params->>'scene_key'='s03';
  result:=public.begin_video_project_music_v1(p.id,audio_job,1,false,null,null);
  if result->>'state' is distinct from 'skipped' then
    raise exception 'Narration-only music decision was not recorded'; end if;
  if not public.complete_video_audio_project_v1(p.id,1) then
    raise exception 'Video audio completion failed'; end if;
  if (select stage from public.video_projects where id=p.id)<>'timed' then
    raise exception 'Video did not reach timed stage'; end if;
  render_job:=public.queue_video_render_v1(p.id,1);
  if render_job is distinct from public.queue_video_render_v1(p.id,1) then
    raise exception 'Render queue replay created another job'; end if;
  begin
    perform public.queue_video_render_v1(p.id,2);
    raise exception 'Stale render IR was queued';
  exception when check_violation then null; end;
  begin
    perform public.claim_video_project_render_v1(p.id,render_job,1,'1:1');
    raise exception 'Unrequested aspect was claimed';
  exception when check_violation then null; end;
  result:=public.claim_video_project_render_v1(p.id,render_job,1,'16:9');
  render_attempt:=(result->>'attempt_id')::uuid;
  if result->>'state' is distinct from 'claimed' then
    raise exception 'First render claim was not unique'; end if;
  result:=public.claim_video_project_render_v1(p.id,render_job,1,'16:9');
  if result->>'state' is distinct from 'already_claimed'
    or (result->>'attempt_id')::uuid is distinct from render_attempt then
    raise exception 'Render claim replay could start another Lambda'; end if;
  out_name:=p.id::text||'-16x9.mp4';
  begin
    perform public.record_video_project_lambda_handle_v2(render_attempt,
      render_job,'eu-central-1','remotion-render-test','render1',
      'remotion-fixture-bucket','wrong.mp4',
      'https://site.example.invalid/ir-v1');
    raise exception 'Wrong Lambda output was accepted';
  exception when check_violation then null; end;
  if not public.record_video_project_lambda_handle_v2(render_attempt,
    render_job,'eu-central-1','remotion-render-test','render1',
    'remotion-fixture-bucket',out_name,
    'https://site.example.invalid/ir-v1') then
    raise exception 'Lambda handle was not persisted'; end if;
  if not public.record_video_project_lambda_handle_v2(render_attempt,
    render_job,'eu-central-1','remotion-render-test','render1',
    'remotion-fixture-bucket',out_name,
    'https://site.example.invalid/ir-v1') then
    raise exception 'Exact Lambda handle replay failed'; end if;
  begin
    perform public.record_video_project_lambda_handle_v2(render_attempt,
      render_job,'eu-central-1','remotion-render-test','render2',
      'remotion-fixture-bucket',out_name,
      'https://site.example.invalid/ir-v1');
    raise exception 'Changed Lambda handle was accepted';
  exception when check_violation then null; end;
  begin
    perform public.record_video_project_lambda_handle_v2(render_attempt,
      render_job,'eu-central-1','remotion-render-test','render1',
      'remotion-fixture-bucket',out_name,
      'https://site.example.invalid/another-release');
    raise exception 'Changed renderer site was accepted';
  exception when check_violation then null; end;
  candidate_path:=p.client_id::text||'/video/projects/'||p.id::text||
    '/ir-v1/candidates/'||render_attempt::text||'-16x9-'||repeat('c',64)||'.mp4';
  insert into storage.objects(bucket_id,name,version)
    values('client-media',candidate_path,'v1') returning * into o;
  result:=public.video_project_render_candidate_identity_v1(render_attempt,repeat('c',64));
  if result->>'storage_path' is distinct from candidate_path
    or (result->>'object_id')::uuid is distinct from o.id then
    raise exception 'Candidate Storage identity mismatch'; end if;
  candidate_probe:='{"result":"pass","width":1920,"height":1080,
    "duration_sec":60,"has_audio":true,"checks":[]}'::jsonb;
  begin
    perform public.record_video_project_render_candidate_v1(render_attempt,
      render_job,candidate_path,repeat('c',64),1024,o.id,'wrong',o.updated_at,
      candidate_probe);
    raise exception 'Changed Storage object was accepted';
  exception when check_violation then null; end;
  begin
    perform public.record_video_project_render_candidate_v1(render_attempt,
      render_job,candidate_path,repeat('c',64),1024,o.id,o.version,o.updated_at,
      candidate_probe||'{"duration_sec":"bad"}'::jsonb);
    raise exception 'Invalid media probe was accepted';
  exception when check_violation then null; end;
  candidate_id:=public.record_video_project_render_candidate_v1(render_attempt,
    render_job,candidate_path,repeat('c',64),1024,o.id,o.version,o.updated_at,
    candidate_probe);
  if candidate_id is distinct from public.record_video_project_render_candidate_v1(
    render_attempt,render_job,candidate_path,repeat('c',64),1024,o.id,o.version,
    o.updated_at,candidate_probe) then
    raise exception 'Candidate exact replay changed receipt'; end if;
  begin
    perform public.record_video_project_render_candidate_v1(render_attempt,
      render_job,candidate_path,repeat('d',64),1024,o.id,o.version,o.updated_at,
      candidate_probe);
    raise exception 'Changed candidate bytes were accepted';
  exception when check_violation then null; end;
  if (select state from public.video_project_render_attempts_v1
      where id=render_attempt)<>'succeeded' then
    raise exception 'Passed candidate did not close render attempt'; end if;
  result:=public.claim_video_project_render_v1(p.id,render_job,1,'9:16');
  second_attempt:=(result->>'attempt_id')::uuid;
  if not public.mark_video_project_render_uncertain_v1(
    second_attempt,render_job,'start_unknown') then
    raise exception 'Uncertain render was not recorded'; end if;
  result:=public.claim_video_project_render_v1(p.id,render_job,1,'9:16');
  if result->>'state' is distinct from 'already_uncertain' then
    raise exception 'Uncertain render could be restarted'; end if;
  perform set_config('request.jwt.claim.role','authenticated',true);
  begin
    perform public.queue_video_render_v1(p.id,1);
    raise exception 'Browser queued an external render';
  exception when insufficient_privilege then null; end;
  begin
    perform public.claim_video_project_render_v1(p.id,render_job,1,'16:9');
    raise exception 'Browser claimed an external render';
  exception when insufficient_privilege then null; end;
  if (select count(*) from public.video_project_render_attempts_v1
      where project_id=p.id)<>2 then
    raise exception 'Render attempt count changed'; end if;
end $checks$;
rollback;

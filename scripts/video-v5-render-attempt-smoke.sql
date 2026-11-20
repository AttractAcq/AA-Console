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
  creative_review jsonb;
  first_candidate_id uuid; attached_asset_id uuid;
  thumbnail_attempt uuid; thumbnail_path text;
  thumbnail_hash text:=repeat('e',64);
  thumbnail_cost uuid;
  creative_attempt uuid;
  render_cost uuid;
  prerender_attempt uuid;
  prerender_report jsonb;
  still_receipts jsonb;
  patched_ir jsonb;
  patched_result jsonb;
begin
  p:=public.create_video_project_draft_v1(
    'f2222222-2222-4222-8222-222222222222',
    'Explain verified information to a local buyer.',
    'Local buyers','calm',90,array['16:9','9:16'],
    null,null,null,'render-attempt');
  script_job:=public.start_video_project_v1(p.id,0,array[]::uuid[],
    'The exact operator prompt is the reviewed source.');
  perform set_config('request.jwt.claim.role','service_role',true);
  if (select brand_snapshot from public.video_projects where id=p.id)
      is distinct from '{}'::jsonb
    or (select brand_snapshot_sha256 from public.video_projects where id=p.id)
      is distinct from encode(sha256(convert_to('{}','UTF8')),'hex') then
    raise exception 'Started project did not freeze its exact brand fallback'; end if;
  begin
    update public.video_projects set brand_snapshot='{"colour_primary":"#123456"}'::jsonb
      where id=p.id;
    raise exception 'Started brand snapshot was editable';
  exception when check_violation then null; end;
  update public.video_projects set stage='timing',ir_version=1,
    ir='{"version":1,"title":"Fixture","audience":"Operators","tone":"calm",
      "aspects":["16:9","9:16"],"music":{"enabled":false,"mood":""},
      "scenes":[
        {"id":"s01","component":"TitleCard","props":{"title":"Original title"},
          "narration":"Hello one.","transitionIn":"cut","locked":false},
        {"id":"s02","component":"BulletReveal","props":{"heading":"Evidence","items":["Demand"]},
          "narration":"Hello two.","transitionIn":"fade","locked":false},
        {"id":"s03","component":"Outro","props":{"headline":"Next step","cta":"Continue"},
          "narration":"Hello three.","transitionIn":"fade","locked":false}
      ]}'::jsonb
    where id=p.id;
  if public.bind_video_project_voice_v1(p.id,1,'narrator-1')
      is distinct from 'narrator-1' then
    raise exception 'Project narrator was not bound'; end if;
  for entry in select value from jsonb_array_elements(
    (select ir->'scenes' from public.video_projects where id=p.id)) loop
    insert into public.video_scenes(project_id,client_id,position,scene_key,
      component,props,narration,transition_in)
    values(p.id,p.client_id,substring(entry->>'id' from 2)::integer,
      entry->>'id',entry->>'component',entry->'props',entry->>'narration',
      entry->>'transitionIn')
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
  if (select audio_ir_version from public.video_projects where id=p.id)<>1 then
    raise exception 'Exact audio version was not bound at timing completion'; end if;
  begin
    update public.video_projects set ir_version=2 where id=p.id;
    if not public.complete_video_audio_project_v1(p.id,2) then
      raise exception 'Unchanged audio was not valid for a visual IR revision'; end if;
    update public.video_scenes set narration='Changed narration.'
      where project_id=p.id and scene_key='s01';
    begin
      perform public.complete_video_audio_project_v1(p.id,2);
      raise exception 'Changed narration reused old audio';
    exception when check_violation then null; end;
    raise exception 'Rollback isolated visual-version test' using errcode='Z0001';
  exception when sqlstate 'Z0001' then null; end;
  render_job:=public.queue_video_render_v1(p.id,1);
  if render_job is distinct from public.queue_video_render_v1(p.id,1) then
    raise exception 'Render queue replay created another job'; end if;
  begin
    result:=public.claim_video_project_prerender_v1(p.id,render_job,1);
    prerender_attempt:=(result->>'attempt_id')::uuid;
    select jsonb_agg(jsonb_build_object('sceneId',
        's'||lpad(((n-1)/3+1)::text,2,'0'),
        'frame',n*10,'renderId','patch-still-'||n::text,'costUsd',0.001)
        order by n) into still_receipts
      from generate_series(1,9) n;
    prerender_report:='{"result":"fail","sampled_frames":9,"batches":1,
      "model":"claude-test","patch":[{"op":"shorten_text","sceneId":"s01",
        "path":"props.title","value":"Short"}],
      "usage":{"inputTokens":100,"outputTokens":20,"costUsd":0.012},
      "checks":[
        {"area":"text_overflow","verdict":"fail","sceneId":"s01","reason":"Too long."},
        {"area":"caption_overlap","verdict":"pass","sceneId":"s01","reason":"No overlap."},
        {"area":"contrast","verdict":"pass","sceneId":"s02","reason":"Contrast passes."},
        {"area":"safe_area","verdict":"pass","sceneId":"s02","reason":"In safe area."},
        {"area":"reading_time","verdict":"pass","sceneId":"s02","reason":"Time sufficient."},
        {"area":"brand_token","verdict":"pass","sceneId":"s03","reason":"Brand matches."},
        {"area":"empty_frame","verdict":"pass","sceneId":"s03","reason":"No empty frame."},
        {"area":"narration_visual_match","verdict":"pass","sceneId":"s03","reason":"Visual matches."}
      ]}'::jsonb;
    if public.finish_video_project_prerender_v1(prerender_attempt,
      render_job,prerender_report,still_receipts,'claude-test',100,20,
      0.012,0.009) is distinct from 'fail' then
      raise exception 'Patch fixture critic did not fail'; end if;
    if public.resolve_video_project_critic_failure_v1(prerender_attempt,
      render_job) is distinct from 'visual_patch' then
      raise exception 'First visual critic failure was not patchable'; end if;
    patched_ir:=jsonb_set((select ir from public.video_projects where id=p.id),
      '{scenes,0,props,title}','"Short"'::jsonb,false);
    begin
      perform public.apply_video_project_visual_patch_v1(prerender_attempt,
        render_job,1,jsonb_set(patched_ir,'{scenes,0,props,title}',
          '"Different"'::jsonb,false));
      raise exception 'Unfiled visual patch was accepted';
    exception when check_violation then null; end;
    patched_result:=public.apply_video_project_visual_patch_v1(
      prerender_attempt,render_job,1,patched_ir);
    if (patched_result->>'ir_version')::integer<>2
      or (select audio_ir_version from public.video_projects where id=p.id)<>1
      or (select props->>'title' from public.video_scenes
        where project_id=p.id and scene_key='s01') is distinct from 'Short'
      or not public.complete_video_audio_project_v1(p.id,2) then
      raise exception 'Visual patch lost audio or scene lineage'; end if;
    if public.apply_video_project_visual_patch_v1(
      prerender_attempt,render_job,1,patched_ir)->>'job_id'
      is distinct from patched_result->>'job_id' then
      raise exception 'Visual patch replay created another job'; end if;
    raise exception 'Rollback isolated visual critic patch test'
      using errcode='Z0001';
  exception when sqlstate 'Z0001' then null; end;
  begin
    result:=public.claim_video_project_prerender_v1(p.id,render_job,1);
    prerender_attempt:=(result->>'attempt_id')::uuid;
    prerender_report:=jsonb_set(prerender_report,'{patch}',
      '[{"op":"shorten_text","sceneId":"s01","path":"narration",
        "value":"Hi."}]'::jsonb,false);
    if public.finish_video_project_prerender_v1(prerender_attempt,
      render_job,prerender_report,still_receipts,'claude-test',100,20,
      0.012,0.009) is distinct from 'fail' then
      raise exception 'Narration fixture critic did not fail'; end if;
    if public.resolve_video_project_critic_failure_v1(prerender_attempt,
      render_job) is distinct from 'timing_required' then
      raise exception 'Narration critic did not require new timing'; end if;
    patched_ir:=jsonb_set((select ir from public.video_projects where id=p.id),
      '{scenes,0,narration}','"Hi."'::jsonb,false);
    patched_result:=public.apply_video_project_narration_patch_v1(
      prerender_attempt,render_job,1,patched_ir);
    if (patched_result->>'ir_version')::integer<>2
      or jsonb_array_length(patched_result->'job_ids')<>1
      or (select stage from public.video_projects where id=p.id)<>'timing'
      or (select audio_ir_version from public.video_projects where id=p.id)<>1
      or (select count(*) from public.video_scene_audio_revisions_v1
        where project_id=p.id and ir_version=1)<>1
      or (select count(*) from public.video_scene_audio_receipts_v1
        where project_id=p.id and ir_version=1)<>2
      or (select count(*) from public.agent_jobs j
        join public.video_scenes scene_join on scene_join.id=j.input_id
        where scene_join.project_id=p.id and j.agent_key='video_audio'
          and j.params->>'ir_version'='2')<>1 then
      raise exception 'Narration patch did not preserve unchanged audio'; end if;
    select * into s from public.video_scenes
      where project_id=p.id and scene_key='s01';
    audio_job:=(patched_result->'job_ids'->>0)::uuid;
    if not public.begin_video_scene_audio_attempt_v1(p.id,s.id,audio_job,2) then
      raise exception 'Revised audio attempt was not bound'; end if;
    scene_path:=p.client_id::text||'/video/projects/'||p.id::text||
      '/ir-v2/scenes/s01/audio.mp3';
    insert into storage.objects(bucket_id,name,version)
    values('client-media',scene_path,'v2') returning * into o;
    narration_hash:=encode(sha256(convert_to(s.narration,'UTF8')),'hex');
    perform public.commit_video_scene_audio_v1(p.id,s.id,2,narration_hash,
      repeat('b',64),scene_path,1024,o.id,o.version,o.updated_at,
      '[{"text":"Hi","startSec":0.1,"endSec":1.5,"loss":0.05}]'::jsonb,
      0.05,4,-16,'narrator-1',1);
    if not public.complete_video_audio_project_v1(p.id,2) then
      raise exception 'Revised audio receipts were incomplete'; end if;
    if (select stage from public.video_projects where id=p.id)<>'timed'
      or (select audio_ir_version from public.video_projects where id=p.id)<>1
      or (select count(*) from public.video_scene_audio_receipts_v1
        where project_id=p.id and ir_version=2)<>1 then
      raise exception 'Mixed revised audio did not complete: stage %, baseline %, revised receipts %',
        (select stage from public.video_projects where id=p.id),
        (select audio_ir_version from public.video_projects where id=p.id),
        (select count(*) from public.video_scene_audio_receipts_v1
          where project_id=p.id and ir_version=2); end if;
    if public.apply_video_project_narration_patch_v1(
      prerender_attempt,render_job,1,patched_ir)->'job_ids'
      is distinct from patched_result->'job_ids' then
      raise exception 'Narration replay queued another audio job'; end if;
    raise exception 'Rollback isolated narration critic patch test'
      using errcode='Z0001';
  exception when sqlstate 'Z0001' then null; end;
  begin
    perform public.claim_video_project_render_v1(p.id,render_job,1,'16:9');
    raise exception 'Render started without a pre-render critic receipt';
  exception when check_violation then null; end;
  result:=public.claim_video_project_prerender_v1(p.id,render_job,1);
  prerender_attempt:=(result->>'attempt_id')::uuid;
  if result->>'state' is distinct from 'claimed'
    or (public.claim_video_project_prerender_v1(p.id,render_job,1)->>'state')
      is distinct from 'already_claimed' then
    raise exception 'Pre-render paid review claim was not unique'; end if;
  select jsonb_agg(jsonb_build_object('sceneId',
      's'||lpad(((n-1)/3+1)::text,2,'0'),
      'frame',n*10,'renderId','still-'||n::text,'costUsd',0.001)
      order by n) into still_receipts
    from generate_series(1,9) n;
  prerender_report:='{"result":"pass","sampled_frames":9,"batches":1,
    "model":"claude-test","patch":[],"usage":{"inputTokens":100,
      "outputTokens":20,"costUsd":0.012},"checks":[
    {"area":"text_overflow","verdict":"pass","sceneId":"s01","reason":"Text fits."},
    {"area":"caption_overlap","verdict":"pass","sceneId":"s01","reason":"No overlap."},
    {"area":"contrast","verdict":"pass","sceneId":"s02","reason":"Contrast passes."},
    {"area":"safe_area","verdict":"pass","sceneId":"s02","reason":"In safe area."},
    {"area":"reading_time","verdict":"pass","sceneId":"s02","reason":"Time sufficient."},
    {"area":"brand_token","verdict":"pass","sceneId":"s03","reason":"Brand matches."},
    {"area":"empty_frame","verdict":"pass","sceneId":"s03","reason":"No empty frame."},
    {"area":"narration_visual_match","verdict":"pass","sceneId":"s03","reason":"Visual matches."}
  ]}'::jsonb;
  begin
    perform public.finish_video_project_prerender_v1(prerender_attempt,
      render_job,prerender_report,still_receipts,'claude-test',100,20,
      0.012,0.008);
    raise exception 'Changed still cost was accepted';
  exception when check_violation then null; end;
  if public.finish_video_project_prerender_v1(prerender_attempt,
      render_job,prerender_report,still_receipts,'claude-test',100,20,
      0.012,0.009) is distinct from 'pass' then
    raise exception 'Pre-render critic did not pass'; end if;
  if public.finish_video_project_prerender_v1(prerender_attempt,
      render_job,prerender_report,still_receipts,'claude-test',100,20,
      0.012,0.009) is distinct from 'pass' then
    raise exception 'Exact pre-render replay did not pass'; end if;
  if (select count(*) from public.video_project_costs
      where attempt_key in ('video-prerender-stills:'||prerender_attempt::text,
        'video-prerender-model:'||prerender_attempt::text))<>2 then
    raise exception 'Pre-render cost receipts were not filed exactly once'; end if;
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
    insert into public.video_project_render_candidates_v1
      (attempt_id,project_id,client_id,ir_version,aspect,storage_path,
        file_sha256,file_bytes,object_id,object_updated_at,
        media_probe,probe_result)
    values(render_attempt,p.id,p.client_id,1,'16:9','pre-cost.mp4',
      repeat('e',64),1024,gen_random_uuid(),clock_timestamp(),
      '{"result":"pass"}'::jsonb,'pass');
    raise exception 'Candidate without Lambda cost was accepted';
  exception when check_violation then null; end;
  begin
    perform public.record_video_project_render_cost_v1(render_attempt,
      render_job,42000,0.036,'EUR');
    raise exception 'Non-USD Lambda estimate was accepted';
  exception when invalid_parameter_value then null; end;
  render_cost:=public.record_video_project_render_cost_v1(render_attempt,
    render_job,42000,0.036,'USD');
  if render_cost is distinct from public.record_video_project_render_cost_v1(
    render_attempt,render_job,42000,0.036,'USD') then
    raise exception 'Exact Lambda cost replay duplicated the receipt'; end if;
  begin
    perform public.record_video_project_render_cost_v1(render_attempt,
      render_job,43000,0.036,'USD');
    raise exception 'Changed Lambda billing duration was accepted';
  exception when check_violation then null; end;
  if (select count(*) from public.video_project_costs
      where attempt_key='video-render:'||render_attempt::text)<>1 then
    raise exception 'Lambda render cost count changed'; end if;
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
  creative_review:='{"result":"pass","summary":"All required checks passed.","checks":[
    {"area":"text_overflow","verdict":"pass","reason":"Text fits."},
    {"area":"caption_overlap","verdict":"pass","reason":"No overlap."},
    {"area":"contrast","verdict":"pass","reason":"Contrast passes."},
    {"area":"safe_area","verdict":"pass","reason":"In safe area."},
    {"area":"reading_time","verdict":"pass","reason":"Time sufficient."},
    {"area":"brand_token","verdict":"pass","reason":"Brand matches."},
    {"area":"empty_frame","verdict":"pass","reason":"No empty frame."},
    {"area":"narration_visual_match","verdict":"pass","reason":"Narration matches."}
  ]}'::jsonb;
  result:=public.claim_video_project_creative_v1(candidate_id,render_job);
  creative_attempt:=(result->>'attempt_id')::uuid;
  if result->>'state' is distinct from 'claimed'
    or (public.claim_video_project_creative_v1(candidate_id,render_job)->>'state')
      is distinct from 'already_claimed' then
    raise exception 'Creative claim was not unique'; end if;
  begin
    perform public.finish_video_project_creative_v1(creative_attempt,
      render_job,creative_review-'checks','claude-test',100,20,0.012);
    raise exception 'Incomplete creative review was accepted';
  exception when check_violation or invalid_parameter_value then null; end;
  begin
    perform public.finish_video_project_creative_v1(creative_attempt,
      render_job,creative_review||'{"result":"fail"}'::jsonb,
      'claude-test',100,20,0.012);
    raise exception 'Passing review was rejected';
  exception when check_violation then null; end;
  if candidate_id is distinct from public.finish_video_project_creative_v1(
    creative_attempt,render_job,creative_review,'claude-test',100,20,0.012) then
    raise exception 'Creative decision did not bind candidate'; end if;
  if candidate_id is distinct from public.finish_video_project_creative_v1(
    creative_attempt,render_job,creative_review,'claude-test',100,20,0.012) then
    raise exception 'Creative decision replay changed receipt'; end if;
  if (select count(*) from public.video_project_costs
      where attempt_key='video-creative:'||creative_attempt::text)<>1 then
    raise exception 'Creative cost receipt count changed'; end if;
  begin
    perform public.finish_video_project_creative_v1(creative_attempt,
      render_job,creative_review,'claude-test',101,20,0.012);
    raise exception 'Creative decision was overwritten';
  exception when check_violation then null; end;
  first_candidate_id:=candidate_id;
  begin
    perform public.attach_video_project_render_v1(p.id,first_candidate_id);
    raise exception 'Missing derivative was attached';
  exception when check_violation then null; end;
  begin
    result:=public.claim_video_project_render_v1(p.id,render_job,1,'9:16');
    second_attempt:=(result->>'attempt_id')::uuid;
    if not public.mark_video_project_render_uncertain_v1(
      second_attempt,render_job,'start_unknown') then
      raise exception 'Uncertain render was not recorded'; end if;
    result:=public.claim_video_project_render_v1(p.id,render_job,1,'9:16');
    if result->>'state' is distinct from 'already_uncertain' then
      raise exception 'Uncertain render could be restarted'; end if;
    raise exception 'Rollback isolated uncertainty test' using errcode='Z0001';
  exception when sqlstate 'Z0001' then null; end;
  result:=public.claim_video_project_render_v1(p.id,render_job,1,'9:16');
  second_attempt:=(result->>'attempt_id')::uuid;
  out_name:=p.id::text||'-9x16.mp4';
  perform public.record_video_project_lambda_handle_v2(second_attempt,
    render_job,'eu-central-1','remotion-render-test','render-vertical',
    'remotion-fixture-bucket',out_name,
    'https://site.example.invalid/ir-v1');
  perform public.record_video_project_render_cost_v1(second_attempt,
    render_job,42000,0.036,'USD');
  candidate_path:=p.client_id::text||'/video/projects/'||p.id::text||
    '/ir-v1/candidates/'||second_attempt::text||'-9x16-'||repeat('d',64)||'.mp4';
  insert into storage.objects(bucket_id,name,version)
    values('client-media',candidate_path,'v1') returning * into o;
  candidate_probe:='{"result":"pass","width":1080,"height":1920,
    "duration_sec":60,"has_audio":true,"checks":[]}'::jsonb;
  candidate_id:=public.record_video_project_render_candidate_v1(second_attempt,
    render_job,candidate_path,repeat('d',64),1024,o.id,o.version,o.updated_at,
    candidate_probe);
  if candidate_id is distinct from public.decide_video_project_render_candidate_v1(
    candidate_id,'accepted',null,null) then
    raise exception 'Derivative creative inheritance failed'; end if;
  if (select candidate_row.creative_review->>'inherited_from'
      from public.video_project_render_candidates_v1 candidate_row
      where candidate_row.id=candidate_id)
      is distinct from first_candidate_id::text then
    raise exception 'Derivative did not name first review'; end if;
  begin
    perform public.attach_video_project_render_v1(p.id,candidate_id);
    raise exception 'Derivative was used as the primary attachment';
  exception when check_violation then null; end;
  begin
    perform public.claim_video_project_thumbnail_v1(
      p.id,render_job,1,candidate_id);
    raise exception 'Derivative claimed the thumbnail';
  exception when check_violation then null; end;
  result:=public.claim_video_project_thumbnail_v1(
    p.id,render_job,1,first_candidate_id);
  thumbnail_attempt:=(result->>'attempt_id')::uuid;
  if result->>'state' is distinct from 'claimed'
    or (public.claim_video_project_thumbnail_v1(
      p.id,render_job,1,first_candidate_id)->>'state')
      is distinct from 'already_claimed' then
    raise exception 'Thumbnail billable attempt was not unique'; end if;
  thumbnail_cost:=public.record_video_project_thumbnail_provider_v1(
    thumbnail_attempt,render_job,'thumbnail-render-fixture',0.001234);
  if thumbnail_cost is distinct from
      public.record_video_project_thumbnail_provider_v1(
        thumbnail_attempt,render_job,'thumbnail-render-fixture',0.001234)
    or (select count(*) from public.video_project_costs
      where attempt_key='video-thumbnail:'||thumbnail_attempt::text)<>1 then
    raise exception 'Thumbnail provider cost was not idempotent'; end if;
  thumbnail_path:=p.client_id::text||'/video/projects/'||p.id::text||
    '/ir-v1/thumbnail-'||thumbnail_attempt::text||'-'||thumbnail_hash||'.jpg';
  insert into storage.objects(bucket_id,name,version)
  values('client-media',thumbnail_path,'v1') returning * into o;
  if public.video_project_thumbnail_storage_identity_v1(
      thumbnail_attempt,thumbnail_hash)->>'object_id'
      is distinct from o.id::text then
    raise exception 'Thumbnail Storage identity was not exact'; end if;
  begin
    perform public.file_video_project_thumbnail_v1(thumbnail_attempt,
      render_job,thumbnail_path,thumbnail_hash,2048,o.id,o.version,
      o.updated_at,1280,721);
    raise exception 'Wrong thumbnail dimensions were accepted';
  exception when check_violation then null; end;
  -- Keep mutation checks in separate statements; SQL does not promise
  -- left-to-right evaluation of volatile calls inside one boolean expression.
  if public.file_video_project_thumbnail_v1(thumbnail_attempt,
      render_job,thumbnail_path,thumbnail_hash,2048,o.id,o.version,
      o.updated_at,1280,720) is distinct from thumbnail_attempt then
    raise exception 'Thumbnail first filing returned another attempt'; end if;
  if public.file_video_project_thumbnail_v1(thumbnail_attempt,
      render_job,thumbnail_path,thumbnail_hash,2048,o.id,o.version,
      o.updated_at,1280,720) is distinct from thumbnail_attempt then
    raise exception 'Thumbnail filing replay returned another attempt'; end if;
  if (select state from public.video_project_thumbnail_attempts_v1
      where id=thumbnail_attempt) is distinct from 'filed' then
    raise exception 'Thumbnail state was not filed: %',
      (select state from public.video_project_thumbnail_attempts_v1
        where id=thumbnail_attempt); end if;
  attached_asset_id:=public.attach_video_project_render_v1(p.id,first_candidate_id);
  if attached_asset_id is distinct from public.attach_video_project_render_v1(
    p.id,first_candidate_id)
    or (select stage from public.video_projects where id=p.id)<>'attached'
    or (select delivery_bytes_sha256 from public.client_media_assets
      where id=attached_asset_id) is distinct from repeat('c',64)
    or (select human_approved_at from public.client_media_assets
      where id=attached_asset_id) is not null then
    raise exception 'Exact review-ready attachment was not stable'; end if;
  perform set_config('request.jwt.claim.role','authenticated',true);
  begin
    perform public.queue_video_render_v1(p.id,1);
    raise exception 'Browser queued an external render';
  exception when insufficient_privilege then null; end;
  begin
    perform public.claim_video_project_render_v1(p.id,render_job,1,'16:9');
    raise exception 'Browser claimed an external render';
  exception when insufficient_privilege then null; end;
  begin
    perform public.record_video_project_render_cost_v1(render_attempt,
      render_job,42000,0.036,'USD');
    raise exception 'Browser filed Lambda render cost';
  exception when insufficient_privilege then null; end;
  begin
    perform public.attach_video_project_render_v1(p.id,first_candidate_id);
    raise exception 'Browser attached a render';
  exception when insufficient_privilege then null; end;
  begin
    perform public.claim_video_project_creative_v1(first_candidate_id,render_job);
    raise exception 'Browser claimed creative review';
  exception when insufficient_privilege then null; end;
  begin
    perform public.claim_video_project_thumbnail_v1(
      p.id,render_job,1,first_candidate_id);
    raise exception 'Browser claimed billable thumbnail work';
  exception when insufficient_privilege then null; end;
  if (select count(*) from public.video_project_render_attempts_v1
      where project_id=p.id)<>2 then
    raise exception 'Render attempt count changed'; end if;
end $checks$;
rollback;

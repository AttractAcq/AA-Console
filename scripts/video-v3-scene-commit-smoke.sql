-- Rollback-only atomic scene commit and stale-source fixture.
begin;
insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
values ('f1111111-1111-4111-8111-111111111111',
  '00000000-0000-0000-0000-000000000000','authenticated','authenticated',
  'video-scene-admin@example.invalid','',now(),now());
insert into public.profiles(id,role,email)
values ('f1111111-1111-4111-8111-111111111111','admin',
  'video-scene-admin@example.invalid');
insert into public.clients(id,name,initials)
values ('f2222222-2222-4222-8222-222222222222','Video scene fixture','VS');
insert into public.client_agent_records(id,client_id,domain,item_key,item_type,title,body)
values ('f3333333-3333-4333-8333-333333333333',
  'f2222222-2222-4222-8222-222222222222','offer_strategy',
  'video_scene_source','section','Reviewed service',
  'An operator reviews the exact version before release.');
select set_config('request.jwt.claim.sub',
  'f1111111-1111-4111-8111-111111111111',true);
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claims',
  '{"sub":"f1111111-1111-4111-8111-111111111111","role":"authenticated","aal":"aal2"}',true);
select public.review_model_section_v7('f3333333-3333-4333-8333-333333333333',
  'Owner interview',current_date,'supported','Checked wording');
update public.agents set paused=false where agent_key='video_script';

do $checks$
declare p public.video_projects%rowtype; q public.video_projects%rowtype;
  job_id uuid; q_job uuid; ir jsonb; script jsonb; bad jsonb;
begin
  p:=public.create_video_project_draft_v1(
    'f2222222-2222-4222-8222-222222222222',
    'Explain a reviewed service to local buyers.',
    'Local buyers','calm',90,array['16:9'],null,null,null,'scene-good');
  job_id:=public.start_video_project_v1(p.id,0,
    array['f3333333-3333-4333-8333-333333333333']::uuid[],null);
  select * into p from public.video_projects where id=p.id;
  ir:='{"version":1,"title":"Reviewed service","audience":"Local buyers",'
    ||'"tone":"calm","aspects":["16:9"],"music":{"enabled":false,"mood":""},'
    ||'"scenes":['
    ||'{"id":"s01","component":"TitleCard","props":{"title":"Reviewed service"},"narration":"Start with the service.","transitionIn":"cut","chapter":false,"locked":false},'
    ||'{"id":"s02","component":"BulletReveal","props":{"heading":"Check","items":["Evidence"]},"narration":"Check the evidence.","transitionIn":"fade","chapter":true,"locked":false},'
    ||'{"id":"s03","component":"Outro","props":{"headline":"Review","cta":"Continue"},"narration":"Review the exact version.","transitionIn":"fade","chapter":false,"locked":false}'
    ||']}'::text;
  script:=jsonb_build_object('source_digest',p.source_digest,
    'independent_review',jsonb_build_object('accepted',true,'reasons','[]'::jsonb,'edits',0),
    'scene_sources',jsonb_build_array(
      jsonb_build_object('sceneId','s01','sourceIds',jsonb_build_array('f3333333-3333-4333-8333-333333333333')),
      jsonb_build_object('sceneId','s02','sourceIds',jsonb_build_array('f3333333-3333-4333-8333-333333333333')),
      jsonb_build_object('sceneId','s03','sourceIds',jsonb_build_array('f3333333-3333-4333-8333-333333333333'))));
  begin
    perform public.commit_video_storyboard_v1(p.id,job_id,0,ir,script,'Human review pending.');
    raise exception 'Browser committed video scenes';
  exception when insufficient_privilege then null; end;
  perform set_config('request.jwt.claim.role','service_role',true);
  update public.video_projects set stage='scripting' where id=p.id;
  bad:=jsonb_set(script,'{scene_sources,2,sourceIds}',
    '["not-a-source"]'::jsonb);
  begin
    perform public.commit_video_storyboard_v1(p.id,job_id,0,ir,bad,'Human review pending.');
    raise exception 'Unknown scene source committed';
  exception when check_violation then null; end;
  if exists(select 1 from public.video_scenes where project_id=p.id)
    or (select stage from public.video_projects where id=p.id)<>'scripting' then
    raise exception 'Failed commit left partial scene data'; end if;
  if public.commit_video_storyboard_v1(p.id,job_id,0,ir,script,
    'Renderer compile and human claim review pending.')<>1 then
    raise exception 'Storyboard commit returned wrong version'; end if;
  if (select count(*) from public.video_scenes where project_id=p.id)<>3
    or (select stage from public.video_projects where id=p.id)<>'needs_human'
    or (select ir_version from public.video_projects where id=p.id)<>1 then
    raise exception 'Scenes and project were not committed atomically'; end if;
  begin
    perform public.commit_video_storyboard_v1(p.id,job_id,0,ir,script,'Replay');
    raise exception 'Second commit accepted';
  exception when check_violation then null; end;
  perform set_config('request.jwt.claim.role','authenticated',true);
  q:=public.create_video_project_draft_v1(p.client_id,
    'Explain a second reviewed service to local buyers.',
    'Local buyers','calm',90,array['16:9'],null,null,null,'scene-stale');
  q_job:=public.start_video_project_v1(q.id,0,
    array['f3333333-3333-4333-8333-333333333333']::uuid[],null);
  update public.client_agent_records set body='The source changed after review.'
    where id='f3333333-3333-4333-8333-333333333333';
  perform set_config('request.jwt.claim.role','service_role',true);
  update public.video_projects set stage='scripting' where id=q.id;
  select * into q from public.video_projects where id=q.id;
  script:=jsonb_set(script,'{source_digest}',to_jsonb(q.source_digest));
  begin
    perform public.commit_video_storyboard_v1(q.id,q_job,0,ir,script,'Human review pending.');
    raise exception 'Stale source committed';
  exception when check_violation then null; end;
  if exists(select 1 from public.video_scenes where project_id=q.id) then
    raise exception 'Stale source left scene rows'; end if;
end $checks$;
rollback;

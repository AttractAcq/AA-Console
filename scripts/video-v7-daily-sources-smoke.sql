-- Rollback-only daily code-video source configuration. No Engine or worker is
-- enabled and no provider action is made.
begin;
insert into auth.users(id,instance_id,aud,role,email,encrypted_password,
  created_at,updated_at)
values ('e1111111-1111-4111-8111-111111111111',
  '00000000-0000-0000-0000-000000000000',
  'authenticated','authenticated','daily-video-admin@example.invalid','',now(),now());
insert into public.profiles(id,role,email)
values ('e1111111-1111-4111-8111-111111111111','admin',
  'daily-video-admin@example.invalid');
insert into public.clients(id,name,initials) values
  ('e2222222-2222-4222-8222-222222222222','Daily video A','DA'),
  ('e3333333-3333-4333-8333-333333333333','Daily video B','DB');
insert into public.client_agent_records(id,client_id,domain,item_key,item_type,
  title,body)
values ('e4444444-4444-4444-8444-444444444444',
  'e2222222-2222-4222-8222-222222222222','offer_strategy',
  'daily_video_source','section','Reviewed service',
  'The service includes an assessed installation and documented handoff.'),
  ('e5555555-5555-4555-8555-555555555555',
  'e3333333-3333-4333-8333-333333333333','offer_strategy',
  'other_daily_video_source','section','Other service',
  'This source belongs to a different client.');
insert into public.client_campaigns(id,client_id,name,brief,audience,offer_summary,
  acquisition_mode,runs_organic,built_at)
values ('e6666666-6666-4666-8666-666666666666',
  'e2222222-2222-4222-8222-222222222222',
  'Daily video campaign','A reviewed organic video route.',
  'Local service buyers','Assessed installation and documented handoff',
  'organic',true,now());
insert into public.campaign_route_packages_v6(id,client_id,campaign_id,
  route,version,plan_fingerprint)
select 'e7777777-7777-4777-8777-777777777777',c.client_id,c.id,
  'organic',1,public.campaign_plan_fingerprint(c)
from public.client_campaigns c
where c.id='e6666666-6666-4666-8666-666666666666';
insert into public.client_content_pillars(id,client_id,slug,name,premise,
  belongs,does_not_belong)
values ('e8888888-8888-4888-8888-888888888888',
  'e2222222-2222-4222-8222-222222222222','daily-video',
  'Daily video','Explain the service to buyers.','Service explanations.',
  'Unrelated topics.');
insert into public.client_daily_package_settings
  (client_id,campaign_id,pillar_id,enabled)
values ('e2222222-2222-4222-8222-222222222222',
  'e6666666-6666-4666-8666-666666666666',
  'e8888888-8888-4888-8888-888888888888',false);

select set_config('request.jwt.claim.sub',
  'e1111111-1111-4111-8111-111111111111',true);
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claims',
  '{"sub":"e1111111-1111-4111-8111-111111111111","role":"authenticated","aal":"aal2"}',true);
select public.review_model_section_v7(
  'e4444444-4444-4444-8444-444444444444',
  'Fixture owner interview',current_date,'supported','Checked source');

do $checks$
begin
  begin
    perform public.configure_daily_video_sources_v1(
      'e2222222-2222-4222-8222-222222222222',
      'e7777777-7777-4777-8777-777777777777',
      array['e4444444-4444-4444-8444-444444444444']::uuid[]);
    raise exception 'Authenticated user configured service-only source';
  exception when insufficient_privilege then null; end;
end $checks$;

set local role service_role;
select set_config('request.jwt.claim.role','service_role',true);
do $checks$
declare result jsonb; configured public.client_daily_video_sources_v1%rowtype;
begin
  begin
    perform public.configure_daily_video_sources_v1(
      'e2222222-2222-4222-8222-222222222222',
      'e7777777-7777-4777-8777-777777777777',
      array['e5555555-5555-4555-8555-555555555555']::uuid[]);
    raise exception 'Cross-client source configured daily video';
  exception when check_violation then null; end;
  result:=public.configure_daily_video_sources_v1(
    'e2222222-2222-4222-8222-222222222222',
    'e7777777-7777-4777-8777-777777777777',
    array['e4444444-4444-4444-8444-444444444444']::uuid[]);
  select * into configured from public.client_daily_video_sources_v1
    where client_id='e2222222-2222-4222-8222-222222222222';
  if result->>'source_count'<>'1' or configured.route_package_id<>
      'e7777777-7777-4777-8777-777777777777'::uuid
    or configured.source_digest is distinct from
      encode(sha256(convert_to(configured.review_snapshot::text,'UTF8')),'hex')
    or configured.review_snapshot->0->>'review_id' is null
    or not public.daily_video_sources_current_v1(configured.client_id)
    or (select enabled from public.client_daily_package_settings
      where client_id=configured.client_id) is not false
    or exists(select 1 from public.video_projects
      where client_id=configured.client_id) then
    raise exception 'Daily source configuration did not preserve hold and lineage';
  end if;
  insert into public.campaign_route_packages_v6(id,client_id,campaign_id,
    route,version,plan_fingerprint)
  select 'e9999999-9999-4999-8999-999999999999',c.client_id,c.id,
    'organic',2,public.campaign_plan_fingerprint(c)
  from public.client_campaigns c
  where c.id='e6666666-6666-4666-8666-666666666666';
  begin
    perform public.configure_daily_video_sources_v1(
      'e2222222-2222-4222-8222-222222222222',
      'e7777777-7777-4777-8777-777777777777',
      array['e4444444-4444-4444-8444-444444444444']::uuid[]);
    raise exception 'Stale route configured daily video';
  exception when check_violation then null; end;
  if public.daily_video_sources_current_v1(configured.client_id) then
    raise exception 'Superseded daily route remained current';
  end if;
end $checks$;

-- Construct one sealed new-version daily run with an accepted video brief.
-- The older v5 planner is deliberately not invoked or modified.
do $fixture$
declare configured public.client_daily_video_sources_v1%rowtype;
  route public.campaign_route_packages_v6%rowtype;
  run public.workflow_runs%rowtype;
  idea_step public.workflow_steps%rowtype;
  brief_step public.workflow_steps%rowtype;
  video_step public.workflow_steps%rowtype;
  package public.daily_packages%rowtype;
begin
  perform public.configure_daily_video_sources_v1(
    'e2222222-2222-4222-8222-222222222222',
    'e9999999-9999-4999-8999-999999999999',
    array['e4444444-4444-4444-8444-444444444444']::uuid[]);
  select * into configured from public.client_daily_video_sources_v1
    where client_id='e2222222-2222-4222-8222-222222222222';
  select * into route from public.campaign_route_packages_v6
    where id=configured.route_package_id;
  update public.client_daily_package_settings set enabled=true
    where client_id=configured.client_id;
  run:=public.create_workflow_run(configured.client_id,
    'daily_content_package','v6.daily.code_video.1','2099-01-02',
    jsonb_build_object('video_route_package_id',route.id,
      'video_source_digest',configured.source_digest,
      'plan_fingerprint',route.plan_fingerprint),
    timestamptz '2099-01-02 09:00+00',configured.campaign_id);
  idea_step:=public.add_workflow_agent_step(run.id,'reel_idea',
    '{}'::text[],'ideation','clients',configured.client_id);
  brief_step:=public.add_workflow_agent_step(run.id,'reel_brief',
    array['reel_idea'],'brief','client_ideas',null,'{}'::jsonb,'reel_idea');
  video_step:=public.add_workflow_agent_step(run.id,'reel_video',
    array['reel_brief'],'video_script','video_projects',null,
    '{}'::jsonb,'reel_brief');
  insert into public.daily_packages(run_id,client_id,package_day,cutoff_at,
    platform,story_media_type)
  values(run.id,configured.client_id,date '2099-01-02',
    timestamptz '2099-01-02 09:00+00','instagram','image')
  returning * into package;
  insert into public.daily_package_items(package_id,role,content_format,
    media_type,campaign_id,pillar_id,final_step_id)
  values(package.id,'reel','reel','video',configured.campaign_id,
    'e8888888-8888-4888-8888-888888888888',video_step.id);
  perform public.seal_workflow_run(run.id);
  insert into public.client_ideas(id,client_id,campaign_id,campaign_position,
    pillar_id,target_platform,content_format,media_type,title,source,status)
  values('eaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',configured.client_id,
    configured.campaign_id,1,'e8888888-8888-4888-8888-888888888888',
    'instagram','reel','video','A daily code-video idea','manual','draft');
  insert into public.client_briefs(id,client_id,source_idea_id,title,body,
    media_type,content_format,target_platform,status)
  values('ebbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',configured.client_id,
    'eaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'Daily code-video brief',
    'Explain the assessed service to local buyers with one clear process and a documented handoff.',
    'video','reel','instagram','approved');
  update public.workflow_steps set status='completed'
    where id in (idea_step.id,brief_step.id);
  insert into public.workflow_artifacts(run_id,step_id,artifact_kind,
    record_id,version_key,qa_evidence)
  values(run.id,idea_step.id,'idea',
    'eaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','fixture-v1',
    '{"result":"pass","checks":["fixture_idea"]}'::jsonb),
    (run.id,brief_step.id,'brief',
    'ebbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','fixture-v1',
    '{"result":"pass","checks":["fixture_brief"]}'::jsonb);
end $fixture$;

do $planner_checks$
declare planned public.daily_packages%rowtype;
  replay public.daily_packages%rowtype;
  reel_step public.workflow_steps%rowtype;
  story_step public.workflow_steps%rowtype;
begin
  planned:=public.plan_daily_code_video_package_v1(
    'e2222222-2222-4222-8222-222222222222',date '2099-01-03');
  replay:=public.plan_daily_code_video_package_v1(
    'e2222222-2222-4222-8222-222222222222',date '2099-01-03');
  select s.* into reel_step from public.daily_package_items i
    join public.workflow_steps s on s.id=i.final_step_id
    where i.package_id=planned.id and i.role='reel';
  select s.* into story_step from public.daily_package_items i
    join public.workflow_steps s on s.id=i.final_step_id
    where i.package_id=planned.id and i.role='story';
  if replay.id is distinct from planned.id
    or (select count(*) from public.daily_package_items
      where package_id=planned.id)<>4
    or reel_step.agent_key is distinct from 'video_script'
    or reel_step.input_table is distinct from 'video_projects'
    or story_step.agent_key is distinct from 'creative_build'
    or exists(select 1 from public.workflow_steps s
      where s.run_id=planned.run_id
        and s.agent_key in ('video_build','video_edit')) then
    raise exception 'New daily planner did not create an idempotent code-video graph';
  end if;
end $planner_checks$;

do $start_checks$
declare item_id uuid; result jsonb; replay jsonb;
  project public.video_projects%rowtype;
  step public.workflow_steps%rowtype;
begin
  select i.id into item_id from public.daily_package_items i
    join public.daily_packages p on p.id=i.package_id
    where p.client_id='e2222222-2222-4222-8222-222222222222'
      and p.package_day=date '2099-01-02' and i.role='reel';
  perform public.reconcile_workflow_runs(100);
  if exists(select 1 from public.workflow_steps s
    join public.daily_package_items i on i.final_step_id=s.id
    where i.id=item_id and (s.status<>'pending' or s.job_id is not null)) then
    raise exception 'Generic v5 reconciler took the v6 code-video step';
  end if;
  update public.client_daily_package_settings set enabled=false
    where client_id='e2222222-2222-4222-8222-222222222222';
  begin
    perform public.start_daily_video_project_v1(item_id);
    raise exception 'Disabled daily Engine started a video project';
  exception when check_violation then null; end;
  update public.client_daily_package_settings set enabled=true
    where client_id='e2222222-2222-4222-8222-222222222222';
  begin
    perform public.start_daily_video_project_v1(item_id);
    raise exception 'Paused video script worker started daily project';
  exception when check_violation then null; end;
  if exists(select 1 from public.video_projects where daily_item_id=item_id) then
    raise exception 'Paused start left a partial project'; end if;
  update public.agents set paused=false where agent_key='video_script';
  perform public.reconcile_daily_code_video_steps_v1(20);
  select jsonb_build_object('project_id',p.id,'job_id',p.job_id)
    into result from public.video_projects p where p.daily_item_id=item_id;
  select * into project from public.video_projects
    where id=(result->>'project_id')::uuid;
  select * into step from public.workflow_steps
    where id=(select final_step_id from public.daily_package_items
      where id=item_id);
  if project.id is null or project.daily_item_id is distinct from item_id
    or project.brief_id is distinct from
      'ebbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'::uuid
    or project.route_package_id is distinct from
      'e9999999-9999-4999-8999-999999999999'::uuid
    or project.source_digest is null or project.daily_brief_body_sha256 is null
    or step.resolved_input_id is distinct from project.id
    or step.job_id is distinct from project.job_id
    or (select count(*) from public.agent_jobs j
      where j.input_table='video_projects' and j.input_id=project.id)<>1
    or not public.video_project_source_current_v1(project.id) then
    raise exception 'Daily project/job/brief/route binding failed'; end if;
  replay:=public.start_daily_video_project_v1(item_id);
  if replay->>'project_id'<>project.id::text
    or replay->>'job_id'<>project.job_id::text then
    raise exception 'Daily video replay duplicated project or job'; end if;
  update public.agent_jobs set status='completed' where id=project.job_id;
  perform public.reconcile_workflow_runs(100);
  perform public.reconcile_daily_code_video_steps_v1(20);
  select * into step from public.workflow_steps where id=step.id;
  if step.status not in ('queued','running')
    or exists(select 1 from public.workflow_artifacts
      where step_id=step.id) then
    raise exception 'Completed script job was treated as a finished MP4';
  end if;
  update public.client_briefs set body=body||' Revised.'
    where id=project.brief_id;
  if public.video_project_source_current_v1(project.id) then
    raise exception 'Changed daily brief remained current'; end if;
end $start_checks$;

-- Synthesize only the terminal provider state to isolate the daily handoff.
-- The separate V5 render fixture exercises real pre-render, cost, probe,
-- creative and thumbnail gates; these trigger bypasses are rollback-only and are
-- re-enabled before the reconciler is called.
reset role;
alter table public.video_project_render_attempts_v1
  disable trigger video_project_prerender_render_gate_v1;
alter table public.video_project_render_candidates_v1
  disable trigger video_project_render_candidate_cost_gate_v1;
alter table public.video_project_attachments_v1
  disable trigger video_attachment_thumbnail_guard_v1;
do $terminal_fixture$
declare project public.video_projects%rowtype;
  object_row storage.objects%rowtype;
  candidate_id uuid; asset_id uuid; attempt_id uuid;
  media_path text;
begin
  update public.client_briefs set body=
    'Explain the assessed service to local buyers with one clear process and a documented handoff.'
    where id='ebbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  select * into project from public.video_projects
    where brief_id='ebbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  if project.id is null or not public.video_project_source_current_v1(project.id) then
    raise exception 'Terminal fixture lost the current daily project'; end if;
  update public.video_projects set stage='attached',ir_version=1
    where id=project.id;
  insert into public.video_project_render_attempts_v1
    (project_id,client_id,ir_version,aspect,job_id,state,region,function_name,
      render_id,bucket_name,out_name,started_at)
  values(project.id,project.client_id,1,'9:16',project.job_id,'started',
    'eu-central-1','rollback-fixture','terminal-receipt','rollback-fixture',
    'daily-fixture.mp4',now()) returning id into attempt_id;
  media_path:=project.client_id::text||'/video/projects/'||project.id::text||
    '/ir-v1/candidates/'||attempt_id::text||'-9x16-'||repeat('c',64)||'.mp4';
  insert into storage.objects(bucket_id,name,version)
  values('client-media',media_path,'v1') returning * into object_row;
  insert into public.video_project_render_candidates_v1
    (attempt_id,project_id,client_id,ir_version,aspect,storage_path,
      file_sha256,file_bytes,object_id,object_version,object_updated_at,
      media_probe,probe_result,verdict,reviewed_at)
  values(attempt_id,project.id,project.client_id,1,'9:16',media_path,
    repeat('c',64),2048,object_row.id,object_row.version,
    object_row.updated_at,
    '{"result":"pass","width":1080,"height":1920,"duration_sec":60}'::jsonb,
    'pass','accepted',now()) returning id into candidate_id;
  insert into public.client_media_assets
    (client_id,brief_id,media_type,content_format,title,storage_path,
      render_path,edit_stage)
  values(project.client_id,project.brief_id,'video','reel',
    'Daily terminal fixture',media_path,media_path,'review_ready')
  returning id into asset_id;
  perform set_config('request.jwt.claim.role','service_role',true);
  perform public.attest_creative_storage_bytes_v6(asset_id,media_path,
    repeat('c',64),2048,object_row.id,object_row.version,object_row.updated_at);
  insert into public.video_project_attachments_v1
    (project_id,client_id,ir_version,first_candidate_id,asset_id)
  values(project.id,project.client_id,1,candidate_id,asset_id);
  update public.video_project_render_candidates_v1
    set object_version='stale-v2' where id=candidate_id;
end $terminal_fixture$;
alter table public.video_project_render_attempts_v1
  enable trigger video_project_prerender_render_gate_v1;
alter table public.video_project_render_candidates_v1
  enable trigger video_project_render_candidate_cost_gate_v1;
alter table public.video_project_attachments_v1
  enable trigger video_attachment_thumbnail_guard_v1;
set local role service_role;
select set_config('request.jwt.claim.role','service_role',true);
do $terminal_checks$
declare step public.workflow_steps%rowtype;
  result record;
begin
  select s.* into step from public.workflow_steps s
    join public.daily_package_items i on i.final_step_id=s.id
    join public.daily_packages p on p.id=i.package_id
    where p.package_day=date '2099-01-02' and i.role='reel';
  select * into result from public.reconcile_daily_code_video_steps_v1(20);
  if result.assets_accepted<>0 or result.steps_held<1
    or exists(select 1 from public.workflow_artifacts where step_id=step.id) then
    raise exception 'Stale render object receipt completed daily video'; end if;
end $terminal_checks$;
reset role;
update public.video_project_render_candidates_v1 set object_version='v1'
  where project_id=(select id from public.video_projects
    where brief_id='ebbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
set local role service_role;
select set_config('request.jwt.claim.role','service_role',true);
do $terminal_accept$
declare step public.workflow_steps%rowtype;
  v_asset_id uuid; result record;
begin
  select s.* into step from public.workflow_steps s
    join public.daily_package_items i on i.final_step_id=s.id
    join public.daily_packages p on p.id=i.package_id
    where p.package_day=date '2099-01-02' and i.role='reel';
  select a.asset_id into v_asset_id from public.video_project_attachments_v1 a
    where a.project_id=step.resolved_input_id;
  select * into result from public.reconcile_daily_code_video_steps_v1(20);
  select * into step from public.workflow_steps where id=step.id;
  if result.assets_accepted<>1 or step.status<>'completed'
    or not exists(select 1 from public.workflow_artifacts a
      where a.step_id=step.id and a.record_id=v_asset_id
        and a.artifact_kind='asset')
    or not exists(select 1 from public.daily_package_items i
      where i.final_step_id=step.id and i.asset_id=v_asset_id)
    or (select status from public.workflow_runs where id=step.run_id)
      is distinct from 'awaiting_human_approval' then
    raise exception 'Exact attached MP4 did not complete daily internal QA'; end if;
  select * into result from public.reconcile_daily_code_video_steps_v1(20);
  if result.assets_accepted<>0 or (select count(*) from public.workflow_artifacts
    where step_id=step.id)<>1 then
    raise exception 'Daily video reconciliation duplicated a final asset'; end if;
end $terminal_accept$;
rollback;

-- Rollback-only intake checks. No agent or outward action is created.
begin;
insert into auth.users(id,instance_id,aud,role,email,encrypted_password,
  created_at,updated_at)
values ('f6666666-6666-4666-8666-666666666666',
  '00000000-0000-0000-0000-000000000000',
  'authenticated','authenticated','video-draft-admin@example.invalid','',now(),now()),
  ('f7777777-7777-4777-8777-777777777777',
  '00000000-0000-0000-0000-000000000000',
  'authenticated','authenticated','video-draft-client@example.invalid','',now(),now()),
  ('f3434343-3434-4343-8343-343434343434',
  '00000000-0000-0000-0000-000000000000',
  'authenticated','authenticated','video-draft-manager@example.invalid','',now(),now());
insert into public.profiles(id,role,email) values
  ('f6666666-6666-4666-8666-666666666666','admin','video-draft-admin@example.invalid'),
  ('f7777777-7777-4777-8777-777777777777','client','video-draft-client@example.invalid'),
  ('f3434343-3434-4343-8343-343434343434','employee','video-draft-manager@example.invalid');
insert into public.clients(id,name,initials) values
  ('f8888888-8888-4888-8888-888888888888','Video draft A','DA'),
  ('f9999999-9999-4999-8999-999999999999','Video draft B','DB');
insert into public.client_users(client_id,user_id)
values ('f9999999-9999-4999-8999-999999999999',
  'f7777777-7777-4777-8777-777777777777');
insert into public.team_members(id,user_id,category,name,initials)
values ('f4545454-4545-4454-8454-454545454545',
  'f3434343-3434-4343-8343-343434343434','smm','Video manager','VM');
alter table public.client_assignments
  disable trigger client_authority_assignment_guard_v6;
insert into public.client_assignments(member_id,client_id)
values ('f4545454-4545-4454-8454-454545454545',
  'f8888888-8888-4888-8888-888888888888');
alter table public.client_assignments
  enable trigger client_authority_assignment_guard_v6;
insert into public.client_briefs(id,client_id,title,media_type,status)
values ('faaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'f9999999-9999-4999-8999-999999999999',
  'Other client video brief','video','approved');
insert into public.client_campaigns(id,client_id,name,brief,
  acquisition_mode,runs_organic)
values ('fbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  'f8888888-8888-4888-8888-888888888888',
  'Video route fixture','One approved route package for the video.',
  'organic',true);
insert into public.campaign_route_packages_v6(id,client_id,campaign_id,
  route,version,plan_fingerprint)
select 'fccccccc-cccc-4ccc-8ccc-cccccccccccc',c.client_id,c.id,
  'organic',1,public.campaign_plan_fingerprint(c)
from public.client_campaigns c
where c.id='fbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
insert into public.client_ideas(id,client_id,campaign_id,campaign_position,
  title,source,status)
values ('f1212121-1212-4121-8121-121212121212',
  'f8888888-8888-4888-8888-888888888888',
  'fbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',1,
  'Campaign video idea','manual','draft');
insert into public.client_briefs(id,client_id,source_idea_id,title,
  media_type,status)
values ('f1313131-1313-4131-8131-131313131313',
  'f8888888-8888-4888-8888-888888888888',
  'f1212121-1212-4121-8121-121212121212',
  'Matching campaign video brief','video','approved'),
  ('f1414141-1414-4141-8141-141414141414',
  'f8888888-8888-4888-8888-888888888888',
  null,'Unrelated video brief','video','approved');

select set_config('request.jwt.claim.sub',
  'f6666666-6666-4666-8666-666666666666',true);
select set_config('request.jwt.claim.role','authenticated',true);
do $checks$
declare first_project public.video_projects%rowtype;
  replay public.video_projects%rowtype;
  route_project public.video_projects%rowtype;
  linked_project public.video_projects%rowtype;
begin
  first_project := public.create_video_project_draft_v1(
    'f8888888-8888-4888-8888-888888888888',
    'Explain the service through a clear three-step story.',
    'Local service buyers','confident',120,array['16:9','9:16'],
    null,null,null,'manual-video-1');
  replay := public.create_video_project_draft_v1(
    'f8888888-8888-4888-8888-888888888888',
    'Explain the service through a clear three-step story.',
    'Local service buyers','confident',120,array['16:9','9:16'],
    null,null,null,'manual-video-1');
  if first_project.id <> replay.id or first_project.stage <> 'draft'
    or first_project.created_by <> auth.uid()
    or (select count(*) from public.video_projects
      where client_id=first_project.client_id) <> 1
    or exists(select 1 from public.agent_jobs
      where input_table='video_projects' and input_id=first_project.id) then
    raise exception 'Manual draft was not idempotent or was prematurely queued';
  end if;
  begin
    perform public.create_video_project_draft_v1(
      first_project.client_id,
      'A different story cannot reuse the original request key.',
      'Local service buyers','confident',120,array['16:9','9:16'],
      null,null,null,'manual-video-1');
    raise exception 'Changed draft reused the same key';
  exception when check_violation then null; end;
  begin
    perform public.create_video_project_draft_v1(
      first_project.client_id, first_project.idea,
      null,'confident',120,array['16:9','16:9'],
      null,null,null,'invalid-aspects');
    raise exception 'Duplicate aspects were accepted';
  exception when invalid_parameter_value then null; end;
  begin
    perform public.create_video_project_draft_v1(
      first_project.client_id, first_project.idea,
      null,'confident',120,array['16:9'],
      'faaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',null,null,'cross-brief');
    raise exception 'Cross-client brief was accepted';
  exception when check_violation then null; end;
  route_project := public.create_video_project_draft_v1(
    first_project.client_id, first_project.idea,
    null,'calm',120,array['1:1'],null,
    'fbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    'fccccccc-cccc-4ccc-8ccc-cccccccccccc','route-v1');
  if route_project.campaign_id is null
    or route_project.route_package_id is null then
    raise exception 'Campaign route was not snapshotted'; end if;
  linked_project := public.create_video_project_draft_v1(
    first_project.client_id, first_project.idea,
    'Local service buyers','confident',120,array['16:9'],
    'f1313131-1313-4131-8131-131313131313',
    route_project.campaign_id,route_project.route_package_id,'linked-brief-route');
  if linked_project.brief_id is null or linked_project.campaign_id is null then
    raise exception 'Matched video brief and campaign route did not bind'; end if;
  begin
    perform public.create_video_project_draft_v1(
      first_project.client_id, first_project.idea,
      'Local service buyers','confident',120,array['16:9'],
      'f1414141-1414-4141-8141-141414141414',
      route_project.campaign_id,route_project.route_package_id,
      'unrelated-brief-route');
    raise exception 'Unrelated video brief was bound to a campaign route';
  exception when check_violation then null; end;
  insert into public.campaign_route_packages_v6(id,client_id,campaign_id,
    route,version,plan_fingerprint)
  select 'fddddddd-dddd-4ddd-8ddd-dddddddddddd',c.client_id,c.id,
    'organic',2,public.campaign_plan_fingerprint(c)
  from public.client_campaigns c
  where c.id=route_project.campaign_id;
  replay := public.create_video_project_draft_v1(
    first_project.client_id, first_project.idea,
    null,'calm',120,array['1:1'],null,
    route_project.campaign_id,route_project.route_package_id,'route-v1');
  if replay.id <> route_project.id then
    raise exception 'A superseded route broke an idempotent retry'; end if;
  begin
    perform public.create_video_project_draft_v1(
      first_project.client_id, first_project.idea,
      null,'calm',120,array['1:1'],null,
      route_project.campaign_id,route_project.route_package_id,'stale-route');
    raise exception 'Stale route package was accepted';
  exception when check_violation then null; end;
  perform public.create_video_project_draft_v1(
    first_project.client_id, first_project.idea,
    null,'calm',120,array['1:1'],null,
    route_project.campaign_id,'fddddddd-dddd-4ddd-8ddd-dddddddddddd',
    'route-v2');
end $checks$;

set local role authenticated;
do $status$
declare status_row public.video_project_status_v1%rowtype;
begin
  select s.* into status_row from public.video_project_status_v1 s
    join public.video_projects p on p.id=s.id and p.client_id=s.client_id
    where p.request_key='linked-brief-route';
  if status_row.id is null or status_row.stage <> 'draft'
    or status_row.scene_count <> 0 or status_row.audio_scene_count <> 0
    or status_row.candidate_count <> 0
    or status_row.accepted_candidate_count <> 0
    or status_row.asset_id is not null
    or status_row.asset_review_status is not null then
    raise exception 'Video status inflated an unproduced draft'; end if;
end $status$;

select set_config('request.jwt.claim.sub',
  'f3434343-3434-4343-8343-343434343434',true);
do $manager$
declare project public.video_projects%rowtype;
begin
  project := public.create_video_project_draft_v1(
    'f8888888-8888-4888-8888-888888888888',
    'An assigned manager can start a scoped video draft.',
    null,'confident',90,array['16:9'],null,null,null,'manager-draft');
  if project.created_by <> auth.uid() or project.stage <> 'draft' then
    raise exception 'Assigned manager could not create a draft'; end if;
  begin
    perform public.create_video_project_draft_v1(
      'f9999999-9999-4999-8999-999999999999',
      'An unassigned manager cannot create a different client draft.',
      null,'confident',90,array['16:9'],null,null,null,'manager-denied');
    raise exception 'Unassigned manager created a draft';
  exception when insufficient_privilege then null; end;
end $manager$;

select set_config('request.jwt.claim.sub',
  'f7777777-7777-4777-8777-777777777777',true);
do $denied$
begin
  if exists(select 1 from public.video_project_status_v1
    where client_id='f8888888-8888-4888-8888-888888888888') then
    raise exception 'Other client video status was readable'; end if;
  begin
    perform public.create_video_project_draft_v1(
      'f8888888-8888-4888-8888-888888888888',
      'This client account cannot open another client video project.',
      null,'confident',120,array['16:9'],null,null,null,'denied');
    raise exception 'Client role created another client draft';
  exception when insufficient_privilege then null; end;
end $denied$;
rollback;

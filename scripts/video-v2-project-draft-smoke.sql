-- Rollback-only intake checks. No agent or outward action is created.
begin;
insert into auth.users(id,instance_id,aud,role,email,encrypted_password,
  created_at,updated_at)
values ('f6666666-6666-4666-8666-666666666666',
  '00000000-0000-0000-0000-000000000000',
  'authenticated','authenticated','video-draft-admin@example.invalid','',now(),now()),
  ('f7777777-7777-4777-8777-777777777777',
  '00000000-0000-0000-0000-000000000000',
  'authenticated','authenticated','video-draft-client@example.invalid','',now(),now());
insert into public.profiles(id,role,email) values
  ('f6666666-6666-4666-8666-666666666666','admin','video-draft-admin@example.invalid'),
  ('f7777777-7777-4777-8777-777777777777','client','video-draft-client@example.invalid');
insert into public.clients(id,name,initials) values
  ('f8888888-8888-4888-8888-888888888888','Video draft A','DA'),
  ('f9999999-9999-4999-8999-999999999999','Video draft B','DB');
insert into public.client_users(client_id,user_id)
values ('f9999999-9999-4999-8999-999999999999',
  'f7777777-7777-4777-8777-777777777777');
insert into public.client_briefs(id,client_id,title,media_type,status)
values ('faaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'f9999999-9999-4999-8999-999999999999',
  'Other client video brief','video','approved');

select set_config('request.jwt.claim.sub',
  'f6666666-6666-4666-8666-666666666666',true);
select set_config('request.jwt.claim.role','authenticated',true);
do $checks$
declare first_project public.video_projects%rowtype;
  replay public.video_projects%rowtype;
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
end $checks$;

select set_config('request.jwt.claim.sub',
  'f7777777-7777-4777-8777-777777777777',true);
do $denied$
begin
  begin
    perform public.create_video_project_draft_v1(
      'f8888888-8888-4888-8888-888888888888',
      'This client account cannot open another client video project.',
      null,'confident',120,array['16:9'],null,null,null,'denied');
    raise exception 'Client role created another client draft';
  exception when insufficient_privilege then null; end;
end $denied$;
rollback;

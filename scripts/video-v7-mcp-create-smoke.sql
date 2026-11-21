-- Rollback-only MCP project start. No provider request or outward action.
begin;
insert into auth.users(id,instance_id,aud,role,email,encrypted_password,
  created_at,updated_at)
values ('d1111111-1111-4111-8111-111111111111',
  '00000000-0000-0000-0000-000000000000',
  'authenticated','authenticated','video-bot-admin@example.invalid','',now(),now());
insert into public.profiles(id,role,email)
values ('d1111111-1111-4111-8111-111111111111','admin',
  'video-bot-admin@example.invalid');
insert into public.clients(id,name,initials) values
  ('d2222222-2222-4222-8222-222222222222','Bot video A','BA'),
  ('d3333333-3333-4333-8333-333333333333','Bot video B','BB');
insert into public.client_agent_records(id,client_id,domain,item_key,item_type,
  title,body)
values ('d4444444-4444-4444-8444-444444444444',
  'd2222222-2222-4222-8222-222222222222','offer_strategy',
  'bot_video_source','section','Reviewed service',
  'The service includes an assessed installation and documented handoff.'),
  ('d5555555-5555-4555-8555-555555555555',
  'd3333333-3333-4333-8333-333333333333','offer_strategy',
  'other_bot_video_source','section','Other service',
  'This source belongs to a different client.');
insert into public.client_campaigns(id,client_id,name,brief,
  acquisition_mode,runs_organic)
values ('d6666666-6666-4666-8666-666666666666',
  'd2222222-2222-4222-8222-222222222222',
  'Bot video campaign','A reviewed campaign video route.',
  'organic',true);
insert into public.campaign_route_packages_v6(id,client_id,campaign_id,
  route,version,plan_fingerprint)
select 'd7777777-7777-4777-8777-777777777777',c.client_id,c.id,
  'organic',1,public.campaign_plan_fingerprint(c)
from public.client_campaigns c
where c.id='d6666666-6666-4666-8666-666666666666';
insert into public.client_ideas(id,client_id,campaign_id,campaign_position,
  title,source,status)
values ('d8888888-8888-4888-8888-888888888888',
  'd2222222-2222-4222-8222-222222222222',
  'd6666666-6666-4666-8666-666666666666',1,
  'Reviewed campaign video idea','manual','draft');
insert into public.client_briefs(id,client_id,source_idea_id,title,
  media_type,status)
values ('d9999999-9999-4999-8999-999999999999',
  'd2222222-2222-4222-8222-222222222222',
  'd8888888-8888-4888-8888-888888888888',
  'Approved campaign video brief','video','approved'),
  ('daaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'd2222222-2222-4222-8222-222222222222',
  null,'Unrelated video brief','video','approved');

select set_config('request.jwt.claim.sub',
  'd1111111-1111-4111-8111-111111111111',true);
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claims',
  '{"sub":"d1111111-1111-4111-8111-111111111111","role":"authenticated","aal":"aal2"}',true);
select public.review_model_section_v7(
  'd4444444-4444-4444-8444-444444444444',
  'Fixture owner interview',current_date,'supported','Checked source');

insert into public.mcp_bot_clients(bot_id,client_id) values
  ('bot_production','d2222222-2222-4222-8222-222222222222'),
  ('bot_chief_of_staff','d2222222-2222-4222-8222-222222222222');
set local role service_role;
select set_config('request.jwt.claim.role','service_role',true);
do $checks$
declare v jsonb; replay jsonb; p public.video_projects%rowtype;
  j public.agent_jobs%rowtype;
begin
  begin
    perform public.mcp_create_video_project_v1(
      'bot_production','request-bot-video','execution-bot-video',
      'd2222222-2222-4222-8222-222222222222',
      'Explain the reviewed service to prospective buyers.',
      'Local buyers','confident',120,array['16:9','9:16'],
      array['d4444444-4444-4444-8444-444444444444']::uuid[],
      'd9999999-9999-4999-8999-999999999999',
      'd6666666-6666-4666-8666-666666666666',
      'd7777777-7777-4777-8777-777777777777','bot-video-1');
    raise exception 'Paused worker accepted a bot video';
  exception when sqlstate 'P0001' then
    if SQLERRM<>'video_agent_unavailable' then raise; end if;
  end;
  if exists(select 1 from public.video_projects
    where request_key='mcp:bot-video-1') then
    raise exception 'Paused start left a partial video project'; end if;
  update public.agents set paused=false where agent_key='video_script';
  begin
    perform public.mcp_create_video_project_v1(
      'bot_chief_of_staff','request-bot-video','execution-bot-video',
      'd2222222-2222-4222-8222-222222222222',
      'Explain the reviewed service to prospective buyers.',
      'Local buyers','confident',120,array['16:9'],
      array['d4444444-4444-4444-8444-444444444444']::uuid[],
      null,null,null,'bot-video-denied');
    raise exception 'Chief of Staff started a bot video';
  exception when sqlstate 'P0001' then
    if SQLERRM<>'bot_forbidden' then raise; end if;
  end;
  begin
    perform public.mcp_create_video_project_v1(
      'bot_production','request-bot-video','execution-bot-video',
      'd3333333-3333-4333-8333-333333333333',
      'Explain a different client service to prospective buyers.',
      'Local buyers','confident',120,array['16:9'],
      array['d5555555-5555-4555-8555-555555555555']::uuid[],
      null,null,null,'bot-video-cross-client');
    raise exception 'Production bot used an ungranted client';
  exception when sqlstate 'P0001' then
    if SQLERRM<>'client_forbidden' then raise; end if;
  end;
  begin
    perform public.mcp_create_video_project_v1(
      'bot_production','request-bot-video','execution-bot-video',
      'd2222222-2222-4222-8222-222222222222',
      'Explain the reviewed service to prospective buyers.',
      'Local buyers','confident',120,array['16:9'],
      array['d5555555-5555-4555-8555-555555555555']::uuid[],
      null,null,null,'bot-video-wrong-source');
    raise exception 'Cross-client source started bot video';
  exception when sqlstate 'P0001' then
    if SQLERRM<>'video_source_invalid' then raise; end if;
  end;
  begin
    perform public.mcp_create_video_project_v1(
      'bot_production','request-bot-video','execution-bot-video',
      'd2222222-2222-4222-8222-222222222222',
      'Explain the reviewed service to prospective buyers.',
      'Local buyers','confident',120,array['16:9'],
      array['d4444444-4444-4444-8444-444444444444']::uuid[],
      'daaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'd6666666-6666-4666-8666-666666666666',
      'd7777777-7777-4777-8777-777777777777','bot-video-wrong-brief');
    raise exception 'Unrelated brief started campaign video';
  exception when check_violation then null; end;
  v:=public.mcp_create_video_project_v1(
    'bot_production','request-bot-video','execution-bot-video',
    'd2222222-2222-4222-8222-222222222222',
    'Explain the reviewed service to prospective buyers.',
    'Local buyers','confident',120,array['16:9','9:16'],
    array['d4444444-4444-4444-8444-444444444444']::uuid[],
    'd9999999-9999-4999-8999-999999999999',
    'd6666666-6666-4666-8666-666666666666',
    'd7777777-7777-4777-8777-777777777777','bot-video-1');
  select * into p from public.video_projects
    where id=(v->>'project_id')::uuid;
  select * into j from public.agent_jobs where id=(v->>'job_id')::uuid;
  if v->>'stage'<>'queued' or p.origin_bot_id<>'bot_production'
    or p.stage<>'queued' or p.job_id is distinct from j.id
    or j.agent_key<>'video_script' or j.client_id<>p.client_id
    or j.params->>'origin_bot_id'<>'bot_production'
    or j.params->>'mcp_execution_id'<>'execution-bot-video'
    or jsonb_array_length(p.source_snapshot)<>1
    or p.source_snapshot->0->>'review_id' is null
    or p.source_digest is distinct from
      encode(sha256(convert_to(p.source_snapshot::text,'UTF8')),'hex') then
    raise exception 'Bot video did not atomically bind source and queue'; end if;
  replay:=public.mcp_create_video_project_v1(
    'bot_production','request-retry','execution-retry',
    'd2222222-2222-4222-8222-222222222222',
    'Explain the reviewed service to prospective buyers.',
    'Local buyers','confident',120,array['16:9','9:16'],
    array['d4444444-4444-4444-8444-444444444444']::uuid[],
    'd9999999-9999-4999-8999-999999999999',
    'd6666666-6666-4666-8666-666666666666',
    'd7777777-7777-4777-8777-777777777777','bot-video-1');
  if replay->>'job_id'<>j.id::text
    or (select count(*) from public.agent_jobs
      where input_table='video_projects' and input_id=p.id)<>1 then
    raise exception 'Idempotent retry made a second video job'; end if;
  insert into public.campaign_route_packages_v6(id,client_id,campaign_id,
    route,version,plan_fingerprint)
  select 'dbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',c.client_id,c.id,
    'organic',2,public.campaign_plan_fingerprint(c)
  from public.client_campaigns c
  where c.id='d6666666-6666-4666-8666-666666666666';
  begin
    perform public.mcp_create_video_project_v1(
      'bot_production','request-new-route','execution-new-route',
      'd2222222-2222-4222-8222-222222222222',
      'Explain the reviewed service to prospective buyers.',
      'Local buyers','confident',120,array['16:9','9:16'],
      array['d4444444-4444-4444-8444-444444444444']::uuid[],
      'd9999999-9999-4999-8999-999999999999',
      'd6666666-6666-4666-8666-666666666666',
      'd7777777-7777-4777-8777-777777777777','bot-video-stale-route');
    raise exception 'Superseded route started a new bot video';
  exception when sqlstate 'P0001' then
    if SQLERRM<>'video_route_stale' then raise; end if;
  end;
  replay:=public.mcp_create_video_project_v1(
    'bot_production','request-retry','execution-retry',
    'd2222222-2222-4222-8222-222222222222',
    'Explain the reviewed service to prospective buyers.',
    'Local buyers','confident',120,array['16:9','9:16'],
    array['d4444444-4444-4444-8444-444444444444']::uuid[],
    'd9999999-9999-4999-8999-999999999999',
    'd6666666-6666-4666-8666-666666666666',
    'd7777777-7777-4777-8777-777777777777','bot-video-1');
  if replay->>'job_id'<>j.id::text
    or public.video_project_source_current_v1(p.id) then
    raise exception 'Stale route did not hold new work or changed old identity'; end if;
  begin
    perform public.mcp_create_video_project_v1(
      'bot_production','request-retry','execution-retry',
      'd2222222-2222-4222-8222-222222222222',
      'A different idea cannot reuse the video request key.',
      'Local buyers','confident',120,array['16:9','9:16'],
      array['d4444444-4444-4444-8444-444444444444']::uuid[],
      'd9999999-9999-4999-8999-999999999999',
      'd6666666-6666-4666-8666-666666666666',
      'd7777777-7777-4777-8777-777777777777','bot-video-1');
    raise exception 'Changed bot video reused the request key';
  exception when sqlstate 'P0001' then
    if SQLERRM<>'idempotency_conflict' then raise; end if;
  end;
end $checks$;
rollback;

-- Rollback-only source snapshot and guarded queue fixture.
begin;
insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
values ('e1111111-1111-4111-8111-111111111111',
  '00000000-0000-0000-0000-000000000000','authenticated','authenticated',
  'video-start-admin@example.invalid','',now(),now());
insert into public.profiles(id,role,email)
values ('e1111111-1111-4111-8111-111111111111','admin',
  'video-start-admin@example.invalid');
insert into public.clients(id,name,initials)
values ('e2222222-2222-4222-8222-222222222222','Video start A','SA'),
  ('e3333333-3333-4333-8333-333333333333','Video start B','SB');
insert into public.client_agent_records(id,client_id,domain,item_key,item_type,title,body)
values ('e4444444-4444-4444-8444-444444444444',
  'e2222222-2222-4222-8222-222222222222','offer_strategy',
  'video_start_source','section','Reviewed service','The service includes a surveyed installation.'),
  ('e5555555-5555-4555-8555-555555555555',
  'e3333333-3333-4333-8333-333333333333','offer_strategy',
  'video_start_other','section','Other service','This belongs to a different client.');
select set_config('request.jwt.claim.sub',
  'e1111111-1111-4111-8111-111111111111',true);
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claims',
  '{"sub":"e1111111-1111-4111-8111-111111111111","role":"authenticated","aal":"aal2"}',true);
select public.review_model_section_v7('e4444444-4444-4444-8444-444444444444',
  'Fixture owner interview',current_date,'supported','Checked source');

do $checks$
declare p public.video_projects%rowtype; stale public.video_projects%rowtype;
  job_id uuid; cost_id uuid; source_row jsonb;
begin
  p:=public.create_video_project_draft_v1(
    'e2222222-2222-4222-8222-222222222222',
    'Explain the reviewed service to prospective buyers.',
    'Local buyers','confident',90,array['16:9'],null,null,null,'start-v1');
  begin
    perform public.start_video_project_v1(p.id,0,
      array['e4444444-4444-4444-8444-444444444444']::uuid[],null);
    raise exception 'Paused video script agent accepted a job';
  exception when others then
    if SQLERRM not like 'Agent video_script is paused%' then raise; end if;
  end;
  if (select stage from public.video_projects where id=p.id)<>'draft'
    or exists(select 1 from public.agent_jobs where input_id=p.id
      and agent_key='video_script') then
    raise exception 'Paused attempt changed project or queue'; end if;
  update public.agents set paused=false where agent_key='video_script';
  begin
    perform public.start_video_project_v1(p.id,1,'{}'::uuid[],null);
    raise exception 'Wrong IR version started the project';
  exception when check_violation then null; end;
  begin
    perform public.start_video_project_v1(p.id,0,
      array['e5555555-5555-4555-8555-555555555555']::uuid[],null);
    raise exception 'Cross-client model source was accepted';
  exception when check_violation then null; end;
  job_id:=public.start_video_project_v1(p.id,0,
    array['e4444444-4444-4444-8444-444444444444']::uuid[],
    'Operator requests a clear explanation.');
  select * into p from public.video_projects where id=p.id;
  if p.stage<>'queued' or p.job_id<>job_id
    or p.source_digest !~ '^[0-9a-f]{64}$'
    or jsonb_array_length(p.source_snapshot)<>2
    or (select count(*) from public.agent_jobs
      where input_id=p.id and agent_key='video_script')<>1 then
    raise exception 'Start did not atomically snapshot and queue'; end if;
  source_row:=p.source_snapshot->0;
  if source_row->>'review_id' is null
    or source_row->>'record_hash' is null
    or source_row->>'kind'<>'offer'
    or p.source_snapshot->1->>'kind'<>'operator' then
    raise exception 'Exact reviewed and operator sources were not separated'; end if;
  begin
    perform public.video_project_source_current_v1(p.id);
    raise exception 'Browser role read the worker-only source gate';
  exception when insufficient_privilege then null; end;
  perform set_config('request.jwt.claim.role','service_role',true);
  if not public.video_project_source_current_v1(p.id) then
    raise exception 'Current source snapshot was rejected'; end if;
  cost_id:=public.record_video_project_cost_v1(p.id,job_id,
    job_id::text||':script:1','anthropic',300,0.015);
  if public.record_video_project_cost_v1(p.id,job_id,
      job_id::text||':script:1','anthropic',300,0.015)<>cost_id
    or (select cost_usd from public.video_projects where id=p.id)<>0.015
    or (select count(*) from public.video_project_costs where project_id=p.id)<>1 then
    raise exception 'Video cost retry duplicated a charge'; end if;
  begin
    perform public.record_video_project_cost_v1(p.id,job_id,
      job_id::text||':script:1','anthropic',300,0.020);
    raise exception 'Changed cost receipt was accepted';
  exception when check_violation then null; end;
  perform set_config('request.jwt.claim.role','authenticated',true);
  begin
    update public.video_projects set source_snapshot='[]'::jsonb where id=p.id;
    raise exception 'Started source snapshot changed';
  exception when check_violation then null; end;
  begin
    perform public.start_video_project_v1(p.id,0,'{}'::uuid[],null);
    raise exception 'Started project queued a second job';
  exception when check_violation then null; end;
  stale:=public.create_video_project_draft_v1(
    p.client_id,'Explain a second reviewed service to buyers.',
    'Local buyers','calm',90,array['1:1'],null,null,null,'stale-source');
  update public.client_agent_records set body='The service details changed after review.'
    where id='e4444444-4444-4444-8444-444444444444';
  perform set_config('request.jwt.claim.role','service_role',true);
  if public.video_project_source_current_v1(p.id) then
    raise exception 'Stale model source was treated as current'; end if;
  perform set_config('request.jwt.claim.role','authenticated',true);
  begin
    perform public.start_video_project_v1(stale.id,0,
      array['e4444444-4444-4444-8444-444444444444']::uuid[],null);
    raise exception 'Stale reviewed source was accepted';
  exception when check_violation then null; end;
end $checks$;
rollback;

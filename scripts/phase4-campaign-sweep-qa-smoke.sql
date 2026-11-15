-- Rollback-only proof that one failed campaign branch does not stop an
-- independent branch, and an internal QA check accepts only real output.
begin;
insert into public.clients(id,name,initials) values
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Sweep QA fixture','SQ');
insert into public.client_campaigns(id,client_id,name,brief,acquisition_mode,runs_organic,runs_paid)
values ('cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Independent pieces','Synthetic QA',
  'organic',true,false);
insert into public.agent_jobs(agent_key,client_id,status,completed_at)
values ('icp','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','completed',now()),
  ('brand_strategy','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','completed',now());
select set_config('request.jwt.claim.role','service_role',true);
select set_config('request.jwt.claims','{"role":"service_role"}',true);

do $checks$
declare run_id uuid; first_id uuid; second_id uuid; job_id uuid;
  queued integer; accepted integer;
begin
  select id into run_id from public.create_workflow_run(
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','campaign_sweep','v7.fixture',
    'sweep-qa-fixture','{}'::jsonb,now()+interval '1 day',
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc');
  select id into first_id from public.add_workflow_agent_step(run_id,'piece1_idea','{}',
    'ideation','clients','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    '{"target_platform":"instagram","media_type":"image","content_format":"single"}'::jsonb);
  select id into second_id from public.add_workflow_agent_step(run_id,'piece2_idea','{}',
    'ideation','clients','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    '{"target_platform":"instagram","media_type":"image","content_format":"single"}'::jsonb);
  perform public.seal_workflow_run(run_id);
  update public.workflow_steps set status='blocked',blocker='Synthetic first-piece failure'
    where id=first_id;
  select steps_queued into queued from public.reconcile_workflow_runs(20);
  if queued<>1 or (select status from public.workflow_runs where id=run_id)<>'running'
    then raise exception 'A blocked sibling stopped independent work: queued %, run %, second %',
      queued,(select status from public.workflow_runs where id=run_id),
      (select status from public.workflow_steps where id=second_id); end if;
  select s.job_id into job_id from public.workflow_steps s where s.id=second_id;
  insert into public.client_ideas(client_id,campaign_id,campaign_position,title,body,source_question,
    media_type,content_format,target_platform,source,status,job_id)
  values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc',2,'Independent idea',
    'A complete and specific buyer question for the independent piece.',
    'Why should a buyer act now?','image','single','instagram','auto','draft',job_id);
  update public.agent_jobs set status='completed' where id=job_id;
  perform public.reconcile_workflow_runs(20);
  select steps_accepted into accepted from public.accept_ready_campaign_workflow_steps_v7(20);
  if accepted<>1 or (select status from public.workflow_steps where id=second_id)<>'completed'
    then raise exception 'Campaign output did not pass internal QA'; end if;
  perform public.reconcile_workflow_runs(20);
  if (select status from public.workflow_runs where id=run_id)<>'blocked'
    or (select status from public.workflow_steps where id=first_id)<>'blocked'
    then raise exception 'The failed branch was hidden after its sibling completed'; end if;
end $checks$;
rollback;

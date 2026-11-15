-- Rollback-only campaign page -> sales-agent preparation and QA evidence.
begin;
insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','00000000-0000-0000-0000-000000000000',
  'authenticated','authenticated','conversion-fixture@example.invalid','',now(),now());
insert into public.profiles(id,role,email) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','admin','conversion-fixture@example.invalid');
insert into public.clients(id,name,initials) values
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Conversion fixture','CF');
insert into public.client_campaigns(id,client_id,name,brief,acquisition_mode,runs_organic,runs_paid,
  content_count,organic_content_count,paid_content_count,built_at,
  needs_landing_page,needs_sales_agent)
values ('cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Conversion sweep','Test source',
  'organic',true,false,1,1,0,now(),true,true);
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true);
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal2"}',true);
select public.set_campaign_content_spec_v7('cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  '[{"route":"organic","platform":"instagram","media_type":"image","content_format":"single"}]'::jsonb);
select public.approve_campaign_plan_v6('cccccccc-cccc-4ccc-8ccc-cccccccccccc');
select set_config('request.jwt.claim.role','service_role',true);
select set_config('request.jwt.claims','{"role":"service_role"}',true);

do $checks$
declare
  cid uuid:='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  client uuid:='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  rid uuid; page_step uuid; agent_step uuid; page_job uuid; agent_job uuid;
  d public.campaign_conversion_drafts_v7%rowtype;
  again public.campaign_conversion_drafts_v7%rowtype;
  accepted integer; synced integer;
begin
  select id into rid from public.create_workflow_run(client,'campaign_sweep',
    'v7.conversion.fixture','conversion-fixture','{}'::jsonb,now()+interval '1 day',cid);
  select * into d from public.ensure_campaign_conversion_drafts_v7(cid,rid);
  select * into again from public.ensure_campaign_conversion_drafts_v7(cid,rid);
  if d.page_id is null or d.sales_agent_id is null
     or d.page_work_item_id is null or d.sales_work_item_id is null
     or d.page_id<>again.page_id
     or (select page_id from public.client_sales_agents where id=d.sales_agent_id)<>d.page_id
     then raise exception 'Conversion drafts were not linked or idempotent'; end if;
  select id into page_step from public.add_workflow_agent_step(rid,'conversion_page','{}',
    'landing_page','client_pages',d.page_id);
  select id into agent_step from public.add_workflow_agent_step(rid,
    'conversion_sales_agent','{conversion_page}','sales_agent',
    'client_sales_agents',d.sales_agent_id);
  perform public.bind_campaign_conversion_work_v7(d.page_work_item_id,rid,'conversion_page');
  perform public.bind_campaign_conversion_work_v7(d.sales_work_item_id,rid,
    'conversion_sales_agent');
  perform public.seal_workflow_run(rid);
  synced:=public.sync_campaign_conversion_work_v7(10);
  if synced<>2 or (select count(*) from public.delivery_work_items_v6
    where id in (d.page_work_item_id,d.sales_work_item_id)
      and state='prepared')<>2 then
    raise exception 'Conversion work did not prepare'; end if;
  update public.workflow_steps set status='blocked',blocker='Page fixture failure'
    where id=page_step;
  synced:=public.sync_campaign_conversion_work_v7(10);
  if synced<>2 or (select count(*) from public.delivery_work_items_v6
    where id in (d.page_work_item_id,d.sales_work_item_id)
      and state='held')<>2 then
    raise exception 'Blocked page did not hold dependent sales agent'; end if;
  perform set_config('request.jwt.claim.role','authenticated',true);
  perform set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true);
  perform set_config('request.jwt.claims',
    '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal2"}',true);
  perform public.retry_campaign_conversion_step_v7(page_step);
  if (select status from public.workflow_steps where id=page_step)<>'pending'
    or (select status from public.workflow_steps where id=agent_step)<>'pending'
    or (select count(*) from public.campaign_sweep_step_retries_v7
      where step_id=page_step)<>1 then
    raise exception 'Page retry changed its dependent step or lost audit'; end if;
  perform set_config('request.jwt.claim.role','service_role',true);
  perform set_config('request.jwt.claims','{"role":"service_role"}',true);
  perform public.sync_campaign_conversion_work_v7(10);

  insert into public.agent_jobs(agent_key,client_id,input_table,input_id,status,completed_at)
    values('landing_page',client,'client_pages',d.page_id,'completed',now())
    returning id into page_job;
  update public.client_pages set html=repeat('<section>Specific offer and proof.</section>',20),
    body=repeat('Campaign copy with a clear action. ',3),
    built_at=now(),job_id=page_job where id=d.page_id;
  update public.workflow_steps set status='needs_internal_qa',job_id=page_job,
    resolved_input_id=d.page_id where id=page_step;
  update public.workflow_runs set status='needs_internal_qa' where id=rid;
  select steps_accepted into accepted
    from public.accept_ready_campaign_conversion_steps_v7(10);
  if accepted<>1 or (select status from public.workflow_steps where id=page_step)<>'completed'
    then raise exception 'Exact page output failed internal QA'; end if;
  perform public.sync_campaign_conversion_work_v7(10);
  if (select state from public.delivery_work_items_v6 where id=d.page_work_item_id)
       <>'ready_for_review' then raise exception 'Page QA did not reach review'; end if;

  insert into public.agent_jobs(agent_key,client_id,input_table,input_id,status,completed_at)
    values('sales_agent',client,'client_sales_agents',d.sales_agent_id,'completed',now())
    returning id into agent_job;
  update public.client_sales_agents set greeting='Hello, how can I help?',
    system_prompt=repeat('Use the approved offer and ask before promising. ',12),
    qualification='[{"question":"What outcome do you need?"},
      {"question":"When do you need it?"},{"question":"What have you tried?"}]'::jsonb,
    guardrails='No unsupported claims.',escalation_rule='Hand unclear cases to a person.',
    built_at=now(),job_id=agent_job where id=d.sales_agent_id;
  update public.workflow_steps set status='needs_internal_qa',job_id=agent_job,
    resolved_input_id=d.sales_agent_id where id=agent_step;
  update public.workflow_runs set status='needs_internal_qa' where id=rid;
  select steps_accepted into accepted
    from public.accept_ready_campaign_conversion_steps_v7(10);
  if accepted<>1 or (select status from public.workflow_steps where id=agent_step)<>'completed'
    then raise exception 'Exact sales-agent output failed internal QA'; end if;
  perform public.sync_campaign_conversion_work_v7(10);
  if (select state from public.delivery_work_items_v6 where id=d.sales_work_item_id)
       <>'ready_for_review' or (select status from public.client_sales_agents
       where id=d.sales_agent_id)<>'draft' or (select published_url from public.client_pages
       where id=d.page_id) is not null then
    raise exception 'Conversion QA did not stop before public use'; end if;
end $checks$;
rollback;

-- Rollback-only exact PDF version, byte attestation and campaign work gate.
begin;
insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','00000000-0000-0000-0000-000000000000',
  'authenticated','authenticated','magnet-producer@example.invalid','',now(),now());
insert into public.profiles(id,role,email) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','admin','magnet-producer@example.invalid');
insert into public.clients(id,name,initials) values
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Magnet producer fixture','MP');
insert into public.client_campaigns(id,client_id,name,brief,acquisition_mode,runs_organic,runs_paid,
  content_count,organic_content_count,paid_content_count,built_at)
values ('cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Magnet campaign','Fixture',
  'organic',true,false,1,1,0,now());
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true);
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal2"}',true);
select public.set_campaign_content_spec_v7('cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  '[{"route":"organic","platform":"instagram","media_type":"image","content_format":"single"}]'::jsonb);
select public.set_campaign_magnet_requirement_v7('cccccccc-cccc-4ccc-8ccc-cccccccccccc',true);
select public.approve_campaign_plan_v6('cccccccc-cccc-4ccc-8ccc-cccccccccccc');
select set_config('request.jwt.claim.role','service_role',true);
select set_config('request.jwt.claims','{"role":"service_role"}',true);

do $checks$
declare cid uuid:='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  client uuid:='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  rid uuid; sid uuid; jid uuid; vid uuid;
  d public.campaign_magnet_drafts_v7%rowtype;
  accepted integer; synced integer;
  digest text:=repeat('a',64);
begin
  select id into rid from public.create_workflow_run(client,'campaign_sweep',
    'v7.magnet.fixture','magnet-producer-fixture',
    jsonb_build_object('plan_fingerprint',(select public.campaign_plan_fingerprint(c)
      from public.client_campaigns c where c.id=cid),'needs_lead_magnet',true),
    now()+interval '1 day',cid);
  select * into d from public.ensure_campaign_magnet_draft_v7(cid,rid);
  select id into sid from public.add_workflow_agent_step(rid,'conversion_lead_magnet','{}',
    'lead_magnet_build','lead_magnets',d.magnet_id);
  perform public.seal_workflow_run(rid);
  synced:=public.sync_campaign_magnet_work_v7(10);
  if synced<>1 or (select state from public.delivery_work_items_v6 where id=d.work_item_id)
      <>'prepared' then raise exception 'Magnet work was not prepared'; end if;
  update public.workflow_steps set status='blocked',blocker='Fixture producer failure'
    where id=sid;
  update public.workflow_runs set status='blocked',blocker='Fixture producer failure'
    where id=rid;
  perform public.sync_campaign_magnet_work_v7(10);
  if (select state from public.delivery_work_items_v6 where id=d.work_item_id)<>'held'
    then raise exception 'Magnet failure did not hold work'; end if;
  perform set_config('request.jwt.claim.role','authenticated',true);
  perform set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true);
  perform set_config('request.jwt.claims',
    '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal2"}',true);
  perform public.retry_campaign_magnet_step_v7(sid);
  if (select status from public.workflow_steps where id=sid)<>'pending'
    then raise exception 'Magnet retry did not reset its step'; end if;
  perform set_config('request.jwt.claim.role','service_role',true);
  perform set_config('request.jwt.claims','{"role":"service_role"}',true);
  insert into public.agent_jobs(agent_key,client_id,input_table,input_id,status,completed_at)
    values('lead_magnet_build',client,'lead_magnets',d.magnet_id,'completed',now())
    returning id into jid;
  insert into public.lead_magnet_versions(magnet_id,client_id,version,storage_path,
    content_sha256,file_bytes,media_type,delivery_channel,created_by_job_id)
  values(d.magnet_id,client,1,'fixture/magnet.pdf',digest,1000,
    'application/pdf','download_link',jid) returning id into vid;
  update public.workflow_steps set status='needs_internal_qa',job_id=jid,
    resolved_input_id=d.magnet_id where id=sid;
  update public.workflow_runs set status='needs_internal_qa' where id=rid;
  select steps_accepted into accepted from public.accept_ready_campaign_magnet_steps_v7(10);
  if accepted<>0 then raise exception 'Unattested bytes passed internal QA'; end if;
  insert into public.campaign_magnet_byte_checks_v7
    (version_id,client_id,job_id,content_sha256,file_bytes)
  values(vid,client,jid,digest,1000);
  select steps_accepted into accepted from public.accept_ready_campaign_magnet_steps_v7(10);
  if accepted<>1 or (select status from public.workflow_steps where id=sid)<>'completed'
    then raise exception 'Attested magnet version failed internal QA'; end if;
  perform public.sync_campaign_magnet_work_v7(10);
  if (select state from public.delivery_work_items_v6 where id=d.work_item_id)
      <>'ready_for_review'
    or (select qa_state from public.delivery_work_items_v6 where id=d.work_item_id)
      <>'passed' then raise exception 'Magnet did not reach human review'; end if;
end $checks$;
rollback;

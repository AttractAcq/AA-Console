-- Exact daily demand survives a creative step retry and separates QA from review.
begin;
do $checks$
declare
  c public.clients%rowtype;
  campaign public.client_campaigns%rowtype;
  pillar public.client_content_pillars%rowtype;
  idea public.client_ideas%rowtype;
  brief public.client_briefs%rowtype;
  run public.workflow_runs%rowtype;
  step public.workflow_steps%rowtype;
  package public.daily_packages%rowtype;
  asset public.client_media_assets%rowtype;
  first_job uuid;
  retry_job uuid;
  generation_id uuid;
  counts public.production_demand_counts_v7%rowtype;
begin
  insert into public.clients(name,initials) values ('Lineage fixture','LF') returning * into c;
  insert into public.client_campaigns(client_id,name,brief,built_at)
    values(c.id,'Lineage campaign','Fixture',now()) returning * into campaign;
  insert into public.client_content_pillars
    (client_id,slug,name,premise,belongs,does_not_belong)
    values(c.id,'fixture','Fixture','Fixture premise','Fixture topic','Other topic')
    returning * into pillar;
  insert into public.client_ideas
    (client_id,title,media_type,source,campaign_id,campaign_position,pillar_id,target_platform)
    values(c.id,'Lineage idea','image','manual',campaign.id,1,pillar.id,'instagram')
    returning * into idea;
  insert into public.client_briefs(client_id,source_idea_id,title,media_type,target_platform)
    values(c.id,idea.id,'Lineage brief','image','instagram') returning * into brief;
  insert into public.workflow_runs
    (client_id,campaign_id,kind,workflow_version,idempotency_key,input_snapshot,deadline_at)
    values(c.id,campaign.id,'daily_content_package','fixture','lineage-fixture','{}',now()+interval '1 day')
    returning * into run;
  insert into public.workflow_steps
    (run_id,step_key,agent_key,input_table,input_id)
    values(run.id,'static_a_create','creative_build','client_briefs',brief.id)
    returning * into step;
  insert into public.daily_packages(run_id,client_id,package_day,cutoff_at,platform,story_media_type)
    values(run.id,c.id,current_date,now()+interval '1 hour','instagram','image')
    returning * into package;
  insert into public.daily_package_items
    (package_id,role,content_format,media_type,campaign_id,pillar_id,final_step_id)
    values(package.id,'static_a','single','image',campaign.id,pillar.id,step.id);
  insert into public.client_media_assets(client_id,brief_id,media_type,title,storage_path)
    values(c.id,brief.id,'image','Fixture asset',c.id::text||'/fixture.png')
    returning * into asset;
  insert into public.agent_jobs(agent_key,client_id,input_table,input_id,params)
    values('creative_build',c.id,'client_briefs',brief.id,
      jsonb_build_object('v5_workflow_run_id',run.id,'v5_step_key','static_a_create'))
    returning id into first_job;
  insert into public.creative_generations(client_id,brief_id,job_id,media_type)
    values(c.id,brief.id,first_job,'image') returning id into generation_id;
  insert into public.creative_renders(generation_id,client_id,job_id,status,asset_id)
    values(generation_id,c.id,first_job,'done',asset.id);
  select * into counts from public.production_demand_counts_v7
    where run_id=run.id and piece_key='static_a';
  if counts.attempts<>1 or counts.produced<>1 or counts.workflow_accepted<>0
    or counts.human_approved<>0 then
    raise exception 'Unreviewed render counted as accepted: %',row_to_json(counts);
  end if;
  insert into public.agent_jobs(agent_key,client_id,input_table,input_id,params)
    values('creative_build',c.id,'client_briefs',brief.id,
      jsonb_build_object('v5_workflow_run_id',run.id,'v5_step_key','static_a_create'))
    returning id into retry_job;
  update public.workflow_steps set job_id=retry_job where id=step.id;
  insert into public.creative_generations(client_id,brief_id,job_id,media_type)
    values(c.id,brief.id,retry_job,'image') returning id into generation_id;
  insert into public.creative_renders(generation_id,client_id,job_id,status,error)
    values(generation_id,c.id,retry_job,'failed','Fixture failure');
  select * into counts from public.production_demand_counts_v7
    where run_id=run.id and piece_key='static_a';
  if counts.attempts<>2 or counts.produced<>1 or counts.rejected<>1 then
    raise exception 'Retry lost an older attempt: %',row_to_json(counts);
  end if;
  insert into public.workflow_artifacts
    (run_id,step_id,artifact_kind,record_id,version_key,qa_evidence)
    values(run.id,step.id,'asset',asset.id,'fixture-sha','{}');
  update public.client_media_assets set review_status='approved' where id=asset.id;
  select * into counts from public.production_demand_counts_v7
    where run_id=run.id and piece_key='static_a';
  if counts.workflow_accepted<>1 or counts.human_approved<>1 then
    raise exception 'QA or human approval not counted: %',row_to_json(counts);
  end if;
end $checks$;
rollback;

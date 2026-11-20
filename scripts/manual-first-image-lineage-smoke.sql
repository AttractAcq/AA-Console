-- Rollback-only source contract for one manual image and a two-route campaign
-- image set. These are synthetic rows, not generated image bytes or a provider
-- result. The check proves exact idea/brief/asset and work/QA/review lineage.
begin;
select set_config('request.jwt.claim.role','service_role',true);
select set_config('request.jwt.claims','{"role":"service_role"}',true);

do $checks$
declare
  c public.clients%rowtype;
  campaign public.client_campaigns%rowtype;
  manual_idea public.client_ideas%rowtype;
  manual_brief public.client_briefs%rowtype;
  manual_asset public.client_media_assets%rowtype;
  run public.workflow_runs%rowtype;
  idea public.client_ideas%rowtype;
  brief public.client_briefs%rowtype;
  asset public.client_media_assets%rowtype;
  step public.workflow_steps%rowtype;
  v_route public.campaign_route_packages_v6%rowtype;
  work public.delivery_work_items_v6%rowtype;
  piece integer;
  route_name text;
  v_job_id uuid;
  generation_id uuid;
  qa_fingerprint text;
  counts public.production_demand_counts_v8%rowtype;
begin
  insert into public.clients(name,initials)
    values ('Manual image lineage fixture','MI') returning * into c;
  insert into public.client_ideas(client_id,title,body,media_type,content_format,
      target_platform,source,status,source_question)
    values(c.id,'Manual image idea','A specific customer question for a manual image.',
      'image','single','instagram','manual','approved','What does the service involve?')
    returning * into manual_idea;
  insert into public.client_briefs(client_id,source_idea_id,title,media_type,
      content_format,target_platform)
    values(c.id,manual_idea.id,'Manual image brief','image','single','instagram')
    returning * into manual_brief;
  insert into public.client_media_assets(client_id,brief_id,media_type,
      content_format,title,storage_path)
    values(c.id,manual_brief.id,'image','single','Manual image output',
      c.id::text || '/manual-image.png') returning * into manual_asset;
  if (select count(*) from public.client_media_assets
      where client_id=c.id and brief_id=manual_brief.id) <> 1
     or manual_idea.campaign_id is not null then
    raise exception 'Manual idea/brief/asset did not stay a single source chain';
  end if;

  insert into public.client_campaigns(client_id,name,brief,acquisition_mode,
      runs_organic,runs_paid,paid_platform,built_at,objective,audience,
      content_count,organic_content_count,paid_content_count,channels)
    values(c.id,'Two route image fixture','One reviewed plan for two image pieces',
      'both',true,true,'meta',now(),'Explain the service','Local buyers',
      2,1,1,array['instagram','meta']::text[]) returning * into campaign;
  perform public.set_campaign_content_spec_v7(campaign.id,
    '[{"route":"organic","platform":"instagram","media_type":"image","content_format":"single"},
      {"route":"paid","platform":"facebook","media_type":"image","content_format":"single"}]'::jsonb);
  select * into campaign from public.client_campaigns where id=campaign.id;
  update public.client_campaigns set plan_approved_at=now(),
      plan_approved_fingerprint=public.campaign_plan_fingerprint(campaign)
    where id=campaign.id;
  if public.campaign_sweep_blocker_v6(campaign.id) is not null then
    raise exception 'Synthetic approved image plan failed the sweep gate: %',
      public.campaign_sweep_blocker_v6(campaign.id);
  end if;
  select id into run.id from public.create_workflow_run(c.id,'campaign_sweep',
    'fixture.image.1','manual-first-image-lineage','{}'::jsonb,
    now()+interval '1 day',campaign.id);

  for piece in 1..2 loop
    route_name:=case when piece=1 then 'organic' else 'paid' end;
    insert into public.client_ideas(client_id,campaign_id,campaign_position,
        acquisition_route,title,body,media_type,content_format,target_platform,
        source,status,source_question)
      values(c.id,campaign.id,piece,route_name,
        'Campaign image idea ' || piece,'One specific campaign image idea.',
        'image','single',(case when piece=1 then 'instagram' else 'facebook' end)::public.post_platform,
        'manual','approved','How does this service help now?') returning * into idea;
    insert into public.client_briefs(client_id,source_idea_id,title,media_type,
        content_format,target_platform)
      values(c.id,idea.id,'Campaign image brief ' || piece,'image','single',
        idea.target_platform) returning * into brief;
    insert into public.client_media_assets(client_id,brief_id,media_type,
        content_format,title,storage_path)
      values(c.id,brief.id,'image','single','Campaign image output ' || piece,
        c.id::text || '/campaign-image-' || piece || '.png') returning * into asset;
    select id into step.id from public.add_workflow_agent_step(run.id,
      'piece' || piece || '_create','{}','creative_build','client_briefs',
      brief.id,'{}'::jsonb);
    insert into public.agent_jobs(agent_key,client_id,input_table,input_id,status,
        completed_at,params)
      values('creative_build',c.id,'client_briefs',brief.id,'completed',now(),
        jsonb_build_object('v5_workflow_run_id',run.id,
          'v5_step_key','piece' || piece || '_create')) returning id into v_job_id;
    update public.workflow_steps set status='completed',job_id=v_job_id,
        resolved_input_id=brief.id where id=step.id;
    insert into public.creative_generations(client_id,brief_id,job_id,media_type)
      values(c.id,brief.id,v_job_id,'image') returning id into generation_id;
    insert into public.creative_renders(generation_id,client_id,job_id,status,asset_id)
      values(generation_id,c.id,v_job_id,'done',asset.id);
  end loop;
  perform public.seal_workflow_run(run.id);
  perform public.ensure_campaign_route_packages_v7(campaign.id,run.id);

  for piece in 1..2 loop
    route_name:=case when piece=1 then 'organic' else 'paid' end;
    select p.* into v_route from public.campaign_route_packages_v6 p
      where p.campaign_id=campaign.id and p.route=route_name order by p.version desc limit 1;
    select a.* into asset from public.client_media_assets a
      join public.client_briefs b on b.id=a.brief_id
      join public.client_ideas i on i.id=b.source_idea_id
      where i.campaign_id=campaign.id and i.campaign_position=piece;
    perform public.register_delivery_asset_bytes_v6(asset.id,asset.storage_path,
      encode(sha256(convert_to('synthetic-image-' || piece,'UTF8')),'hex'));
    select * into work from public.create_delivery_work_item_v6(
      campaign.id,v_route.id,null,null,'content_piece' || piece,v_route.version,
      'content_production_factory',true,
      jsonb_build_object('workflow_run_id',run.id,'piece_index',piece),
      jsonb_build_object('artifact_kind','asset','route',route_name,
        'media_type','image','content_format','single',
        'platform',case when piece=1 then 'instagram' else 'facebook' end));
    perform public.bind_campaign_sweep_work_v7(work.id,run.id,
      'piece' || piece,'piece' || piece || '_create');
  end loop;
  if public.sync_campaign_sweep_work_v7(10) <> 0 or exists (
      select 1 from public.delivery_work_items_v6
      where campaign_id=campaign.id and state='ready_for_review') then
    raise exception 'Image work reached review without an accepted QA artifact';
  end if;
  for piece in 1..2 loop
    select a.* into asset from public.client_media_assets a
      join public.client_briefs b on b.id=a.brief_id
      join public.client_ideas i on i.id=b.source_idea_id
      where i.campaign_id=campaign.id and i.campaign_position=piece;
    select fingerprint into qa_fingerprint from public.delivery_source_catalog_v6
      where entity_kind='content_asset' and source_key=asset.id::text
        and client_id=c.id;
    select * into step from public.workflow_steps
      where run_id=run.id and step_key='piece' || piece || '_create';
    insert into public.workflow_artifacts(run_id,step_id,artifact_kind,record_id,
        version_key,qa_evidence)
      values(run.id,step.id,'asset',asset.id,qa_fingerprint,
        jsonb_build_object('source_fingerprint',qa_fingerprint));
  end loop;
  if public.sync_campaign_sweep_work_v7(10) <> 2 then
    raise exception 'Two campaign image work items did not reach internal QA';
  end if;
  for counts in select * from public.production_demand_counts_v8
      where campaign_id=campaign.id and demand_kind='campaign' loop
    if counts.attempts<>1 or counts.produced<>1 or counts.workflow_accepted<>1
       or counts.human_approved<>0 or not exists (
         select 1 from public.delivery_work_items_v6 w
         where w.id=counts.demand_id and w.state='ready_for_review') then
      raise exception 'Campaign image demand did not preserve QA/review separation: %',
        row_to_json(counts);
    end if;
  end loop;
  if (select count(*) from public.production_demand_counts_v8
      where campaign_id=campaign.id and demand_kind='campaign')<>2
     or (select count(*) from public.campaign_artifacts
      where campaign_id=campaign.id and kind='content' and brief_id is not null)<>2
     or (select count(*) from public.client_media_assets a
      join public.client_briefs b on b.id=a.brief_id
      join public.client_ideas i on i.id=b.source_idea_id
      where i.campaign_id=campaign.id)<>2 then
    raise exception 'Campaign image route or source record count changed';
  end if;
end $checks$;
rollback;

-- Route new daily code-video demand through a versioned workflow graph.
-- The v5 daily planner and every existing run remain unchanged.

create or replace function reconcile_workflow_runs(p_limit integer default 100)
returns table (steps_queued integer, steps_for_qa integer, steps_blocked integer)
language plpgsql security definer set search_path to 'public' as $$
declare v_run workflow_runs; v_step workflow_steps; v_job agent_jobs;
  v_queued integer := 0; v_qa integer := 0; v_blocked integer := 0; v_job_id uuid;
  v_resolved_input uuid; v_source_kind text;
begin
  if auth.role() <> 'service_role' then raise exception 'AUTH: service role required'; end if;
  if p_limit not between 1 and 500 then raise exception 'Limit must be 1..500.'; end if;
  for v_run in select * from workflow_runs r
    where r.sealed_at is not null and (r.status in ('pending', 'running', 'needs_internal_qa')
      or (r.kind = 'campaign_sweep' and r.status = 'blocked'))
    order by r.deadline_at, r.created_at for update skip locked limit p_limit
  loop
    if v_run.deadline_at <= now() then
      update workflow_runs set status = 'blocked', blocker = 'Workflow deadline passed.', updated_at = now()
      where id = v_run.id;
      continue;
    end if;
    for v_step in select * from workflow_steps s where s.run_id = v_run.id order by s.created_at, s.id
    loop
      -- A code-video project spans several jobs. Its dedicated reconciler
      -- owns this step until a complete, internally reviewed asset exists.
      if v_run.kind = 'daily_content_package'
        and v_run.workflow_version = 'v6.daily.code_video.1'
        and v_step.agent_key = 'video_script'
        and v_step.input_table = 'video_projects' then
        continue;
      end if;
      if v_step.status = 'pending' and not exists (
        select 1 from unnest(v_step.dependencies) dep
        where not exists (select 1 from workflow_steps prerequisite
          where prerequisite.run_id = v_run.id and prerequisite.step_key = dep
            and prerequisite.status = 'completed')
      ) then
        begin
          v_resolved_input := v_step.input_id;
          if v_step.input_from_step_key is not null then
            select a.record_id, a.artifact_kind into v_resolved_input, v_source_kind
            from workflow_steps source_step
            join workflow_artifacts a on a.step_id = source_step.id
            where source_step.run_id = v_run.id
              and source_step.step_key = v_step.input_from_step_key;
            if v_resolved_input is null or
              (v_source_kind, v_step.input_table) not in (
                ('idea', 'client_ideas'), ('brief', 'client_briefs'),
                ('asset', 'client_media_assets'), ('page', 'client_pages'),
                ('sales_agent', 'client_sales_agents')) then
              raise exception 'Accepted input artefact does not match %.', v_step.input_table;
            end if;
          end if;
          v_job_id := enqueue_workflow_step_job(v_run, v_step, v_resolved_input);
          update agent_jobs set run_id = v_run.id where id = v_job_id;
          update workflow_steps set status = 'queued', resolved_input_id = v_resolved_input,
            job_id = v_job_id, updated_at = now()
          where id = v_step.id;
          v_queued := v_queued + 1;
        exception when others then
          update workflow_steps set status = 'blocked', blocker = sqlerrm, updated_at = now()
          where id = v_step.id;
          v_blocked := v_blocked + 1;
        end;
      elsif v_step.status in ('queued', 'running') and v_step.job_id is not null then
        select * into v_job from agent_jobs where id = v_step.job_id;
        if v_job.status = 'completed' then
          update workflow_steps set status = 'needs_internal_qa', updated_at = now()
          where id = v_step.id;
          v_qa := v_qa + 1;
        elsif v_job.status = 'failed' and (v_job.terminal or v_job.attempts >= v_job.max_attempts) then
          update workflow_steps set status = 'blocked', blocker = coalesce(v_job.error, 'Agent job failed.'), updated_at = now()
          where id = v_step.id;
          v_blocked := v_blocked + 1;
        elsif v_job.status = 'cancelled' then
          update workflow_steps set status = 'blocked', blocker = 'Agent job was cancelled.', updated_at = now()
          where id = v_step.id;
          v_blocked := v_blocked + 1;
        elsif v_job.status in ('claimed', 'running') and v_step.status = 'queued' then
          update workflow_steps set status = 'running', updated_at = now() where id = v_step.id;
        end if;
      end if;
    end loop;
    update workflow_runs r set
      status = case
        when r.kind = 'campaign_sweep' then case
          when exists (select 1 from workflow_steps s where s.run_id = r.id and s.status = 'needs_internal_qa')
            then 'needs_internal_qa'
          when exists (select 1 from workflow_steps s where s.run_id = r.id and s.status in ('queued','running'))
            then 'running'
          when exists (select 1 from workflow_steps s where s.run_id = r.id and s.status = 'blocked')
            then 'blocked'
          when not exists (select 1 from workflow_steps s where s.run_id = r.id and s.status <> 'completed')
            then 'awaiting_human_approval'
          else 'running' end
        when exists (select 1 from workflow_steps s where s.run_id = r.id and s.status = 'blocked')
          then 'blocked'
        when exists (select 1 from workflow_steps s where s.run_id = r.id and s.status = 'needs_internal_qa')
          then 'needs_internal_qa'
        else 'running' end,
      blocker = (select s.blocker from workflow_steps s
        where s.run_id = r.id and s.status = 'blocked' order by s.created_at, s.id limit 1),
      updated_at = now()
    where r.id = v_run.id;
  end loop;
  return query select v_queued, v_qa, v_blocked;
end;
$$;

create function public.plan_daily_code_video_package_v1(
  p_client_id uuid,p_day date
) returns public.daily_packages language plpgsql volatile security definer
set search_path=pg_catalog,public as $$
declare
  settings public.client_daily_package_settings%rowtype;
  configured public.client_daily_video_sources_v1%rowtype;
  campaign public.client_campaigns%rowtype;
  pillar public.client_content_pillars%rowtype;
  route public.campaign_route_packages_v6%rowtype;
  zone text;
  cutoff timestamptz;
  snapshot jsonb;
  run public.workflow_runs%rowtype;
  package public.daily_packages%rowtype;
  role_name text;
  format_name public.content_format;
  media_name public.media_type;
  previous_idea text;
  idea_step public.workflow_steps%rowtype;
  brief_step public.workflow_steps%rowtype;
  final_step public.workflow_steps%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Service daily code-video planner only.' using errcode='42501';
  end if;
  if p_client_id is null or p_day is null then
    raise exception 'Client and package day are required.' using errcode='22023';
  end if;
  select * into settings from public.client_daily_package_settings
    where client_id=p_client_id for update;
  select * into configured from public.client_daily_video_sources_v1
    where client_id=p_client_id;
  select * into campaign from public.client_campaigns
    where id=settings.campaign_id and client_id=p_client_id for share;
  select * into pillar from public.client_content_pillars
    where id=settings.pillar_id and client_id=p_client_id for share;
  select * into route from public.campaign_route_packages_v6
    where id=configured.route_package_id and client_id=p_client_id;
  if settings.client_id is null or not settings.enabled
    or configured.client_id is null or campaign.id is null or pillar.id is null
    or route.id is null or not pillar.active
    or campaign.status not in ('planning','live')
    or campaign.built_at is null or campaign.archived_at is not null
    or configured.campaign_id is distinct from campaign.id
    or route.route is distinct from 'organic'
    or not public.daily_video_sources_current_v1(p_client_id)
    or nullif(btrim(coalesce(campaign.audience,'')),'') is null
    or nullif(btrim(coalesce(campaign.offer_summary,'')),'') is null then
    raise exception 'Daily code-video needs enabled settings, a built campaign, active pillar and current organic sources.'
      using errcode='23514';
  end if;
  if exists(select 1 from public.client_engine_settings e
    where e.client_id=p_client_id and e.enabled) then
    raise exception 'Disable legacy Engine planning before daily package pilot.'
      using errcode='23514';
  end if;
  select timezone into zone from public.clients where id=p_client_id;
  cutoff:=(p_day+settings.approval_cutoff) at time zone zone;
  if cutoff<=now() then
    raise exception 'Package approval cutoff has passed.' using errcode='23514';
  end if;
  snapshot:=jsonb_build_object(
    'package_day',p_day,'platform',settings.platform,
    'story_media_type',settings.story_media_type,
    'campaign_id',campaign.id,'campaign_name',campaign.name,
    'audience',campaign.audience,'offer',campaign.offer_summary,
    'core_message',campaign.core_message,
    'pillar_id',pillar.id,'pillar_premise',pillar.premise,
    'video_route_package_id',route.id,
    'video_source_digest',configured.source_digest,
    'plan_fingerprint',route.plan_fingerprint,
    'cutoff_at',cutoff,'required_roles',
      jsonb_build_array('reel','story','static_a','static_b'));
  run:=public.create_workflow_run(p_client_id,'daily_content_package',
    'v6.daily.code_video.1',p_day::text,snapshot,cutoff,campaign.id);
  insert into public.daily_packages(run_id,client_id,package_day,cutoff_at,
    platform,story_media_type)
  values(run.id,p_client_id,p_day,cutoff,settings.platform,
    settings.story_media_type)
  on conflict(client_id,package_day) do nothing returning * into package;
  if package.id is null then
    select * into package from public.daily_packages
      where client_id=p_client_id and package_day=p_day;
    if package.run_id is distinct from run.id then
      raise exception 'idempotency_conflict' using errcode='23514';
    end if;
  end if;
  foreach role_name in array array['reel','story','static_a','static_b'] loop
    format_name:=case role_name
      when 'reel' then 'reel'::public.content_format
      when 'story' then 'story'::public.content_format
      else 'single'::public.content_format end;
    media_name:=case role_name
      when 'reel' then 'video'::public.media_type
      when 'story' then settings.story_media_type
      else 'image'::public.media_type end;
    idea_step:=public.add_workflow_agent_step(run.id,role_name||'_idea',
      case when previous_idea is null then '{}'::text[]
        else array[previous_idea] end,
      'ideation','clients',p_client_id,
      jsonb_build_object('target_platform',settings.platform,
        'content_format',format_name,'media_type',media_name,
        'idea_count',1,'campaign_id',campaign.id,'pillar_id',pillar.id));
    previous_idea:=role_name||'_idea';
    brief_step:=public.add_workflow_agent_step(run.id,role_name||'_brief',
      array[role_name||'_idea'],'brief','client_ideas',null,
      '{}'::jsonb,role_name||'_idea');
    if media_name='video'::public.media_type then
      final_step:=public.add_workflow_agent_step(run.id,
        role_name||'_video',array[role_name||'_brief'],
        'video_script','video_projects',null,
        jsonb_build_object('daily_code_video',true),role_name||'_brief');
    else
      final_step:=public.add_workflow_agent_step(run.id,
        role_name||'_create',array[role_name||'_brief'],
        'creative_build','client_briefs',null,
        '{}'::jsonb,role_name||'_brief');
    end if;
    insert into public.daily_package_items(package_id,role,content_format,
      media_type,campaign_id,pillar_id,final_step_id)
    values(package.id,role_name,format_name,media_name,campaign.id,
      pillar.id,final_step.id)
    on conflict(package_id,role) do nothing;
  end loop;
  perform public.seal_workflow_run(run.id);
  return package;
end $$;
revoke all on function public.plan_daily_code_video_package_v1(uuid,date)
  from public,anon,authenticated,service_role;
grant execute on function public.plan_daily_code_video_package_v1(uuid,date)
  to service_role;
comment on function public.plan_daily_code_video_package_v1(uuid,date) is
  'Plans a new four-role daily package with code-video wait steps for video roles; never rewrites v5 runs or enables a worker.';

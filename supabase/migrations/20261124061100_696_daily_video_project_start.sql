-- Bind one new-version daily video item to one code-video project and script
-- job. The v5 planner and existing in-flight daily graphs are untouched.
alter table public.video_projects
  add column daily_item_id uuid unique
    references public.daily_package_items(id) on delete restrict,
  add column daily_source_digest text
    check (daily_source_digest is null or daily_source_digest ~ '^[0-9a-f]{64}$'),
  add column daily_brief_body_sha256 text
    check (daily_brief_body_sha256 is null or daily_brief_body_sha256 ~ '^[0-9a-f]{64}$'),
  add constraint video_daily_binding_complete_v1 check (
    (daily_item_id is null and daily_source_digest is null
      and daily_brief_body_sha256 is null)
    or (daily_item_id is not null and daily_source_digest is not null
      and daily_brief_body_sha256 is not null));

create function public.guard_video_daily_binding_v1()
returns trigger language plpgsql set search_path=pg_catalog,public as $$
begin
  if new.daily_item_id is distinct from old.daily_item_id
    or new.daily_source_digest is distinct from old.daily_source_digest
    or new.daily_brief_body_sha256 is distinct from old.daily_brief_body_sha256 then
    raise exception 'Daily video item, brief and source binding are immutable.'
      using errcode='23514';
  end if;
  return new;
end $$;
create trigger video_daily_binding_guard_v1 before update on public.video_projects
  for each row execute function public.guard_video_daily_binding_v1();
revoke all on function public.guard_video_daily_binding_v1()
  from public,anon,authenticated,service_role;

create function public.start_daily_video_project_v1(p_item_id uuid)
returns jsonb language plpgsql volatile security definer
set search_path=pg_catalog,public set timezone='UTC' as $$
declare
  item public.daily_package_items%rowtype;
  package public.daily_packages%rowtype;
  run public.workflow_runs%rowtype;
  step public.workflow_steps%rowtype;
  source_step public.workflow_steps%rowtype;
  brief_artifact public.workflow_artifacts%rowtype;
  brief public.client_briefs%rowtype;
  campaign public.client_campaigns%rowtype;
  route public.campaign_route_packages_v6%rowtype;
  configured public.client_daily_video_sources_v1%rowtype;
  settings public.client_daily_package_settings%rowtype;
  agent public.agents%rowtype;
  model_record public.client_agent_records%rowtype;
  review record;
  project public.video_projects%rowtype;
  entry jsonb;
  sources jsonb:='[]'::jsonb;
  source_digest text;
  brief_digest text;
  request_key text;
  request_hash text;
  idea_text text;
  v_job_id uuid;
  count_seen integer:=0;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Service daily video start only.' using errcode='42501';
  end if;
  select * into item from public.daily_package_items
    where id=p_item_id for update;
  select * into package from public.daily_packages
    where id=item.package_id;
  select * into run from public.workflow_runs
    where id=package.run_id for update;
  select * into step from public.workflow_steps
    where id=item.final_step_id for update;
  if item.id is null or package.id is null or run.id is null
    or step.id is null or step.run_id is distinct from run.id
    or run.kind is distinct from 'daily_content_package'
    or run.workflow_version is distinct from 'v6.daily.code_video.1'
    or run.sealed_at is null or run.status not in ('pending','running')
    or run.deadline_at<=now() or package.cutoff_at<=now()
    or package.client_id is distinct from run.client_id
    or item.campaign_id is distinct from run.campaign_id
    or item.media_type is distinct from 'video'
    or item.role not in ('reel','story')
    or step.agent_key is distinct from 'video_script'
    or step.input_table is distinct from 'video_projects'
    or step.input_from_step_key is null or item.asset_id is not null
    or item.slot_id is not null then
    raise exception 'Daily code-video item is not ready for project start.'
      using errcode='23514';
  end if;
  if step.status in ('queued','running') then
    select * into project from public.video_projects
      where daily_item_id=item.id;
    if project.id is null or step.resolved_input_id is distinct from project.id
      or step.job_id is distinct from project.job_id
      or project.client_id is distinct from run.client_id
      or not public.daily_video_sources_current_v1(run.client_id) then
      raise exception 'Daily video retry no longer matches its project or sources.'
        using errcode='23514';
    end if;
    return jsonb_build_object('item_id',item.id,'project_id',project.id,
      'job_id',project.job_id,'stage',project.stage);
  end if;
  if step.status is distinct from 'pending' or step.job_id is not null
    or step.resolved_input_id is not null then
    raise exception 'Daily video step already started or held.'
      using errcode='23514';
  end if;
  select * into source_step from public.workflow_steps
    where run_id=run.id and step_key=step.input_from_step_key;
  select * into brief_artifact from public.workflow_artifacts
    where step_id=source_step.id and run_id=run.id and artifact_kind='brief';
  select * into brief from public.client_briefs
    where id=brief_artifact.record_id and client_id=run.client_id for share;
  if source_step.id is null or source_step.status is distinct from 'completed'
    or source_step.step_key<>all(step.dependencies)
    or brief_artifact.id is null or brief.id is null
    or brief.media_type is distinct from 'video'
    or brief.status not in ('approved','in_production','complete')
    or nullif(btrim(coalesce(brief.body,'')),'') is null then
    raise exception 'An accepted, approved video brief is required.'
      using errcode='23514';
  end if;
  select * into configured from public.client_daily_video_sources_v1
    where client_id=run.client_id;
  select * into settings from public.client_daily_package_settings
    where client_id=run.client_id for share;
  select * into route from public.campaign_route_packages_v6
    where id=configured.route_package_id and client_id=run.client_id;
  select * into campaign from public.client_campaigns
    where id=run.campaign_id and client_id=run.client_id;
  if configured.client_id is null or settings.client_id is null
    or not settings.enabled or route.id is null or campaign.id is null
    or not public.daily_video_sources_current_v1(run.client_id)
    or exists(select 1 from public.client_engine_settings e
      where e.client_id=run.client_id and e.enabled)
    or configured.campaign_id is distinct from run.campaign_id
    or run.input_snapshot->>'video_route_package_id' is distinct from route.id::text
    or run.input_snapshot->>'video_source_digest' is distinct from configured.source_digest
    or run.input_snapshot->>'plan_fingerprint' is distinct from route.plan_fingerprint
    or nullif(btrim(coalesce(campaign.audience,'')),'') is null then
    raise exception 'Daily video route, source or audience is stale.'
      using errcode='23514';
  end if;
  select * into agent from public.agents
    where agent_key='video_script' for share;
  if agent.agent_key is null or agent.paused
    or agent.archived_at is not null
    or not public.can_run_agent('video_script',run.client_id) then
    raise exception 'Daily video script worker is unavailable.'
      using errcode='23514';
  end if;
  for entry in select value from jsonb_array_elements(configured.review_snapshot) loop
    select * into model_record from public.client_agent_records
      where id=(entry->>'record_id')::uuid and client_id=run.client_id for share;
    select * into review from public.model_section_review_state_v7
      where record_id=model_record.id and client_id=run.client_id;
    if model_record.id is null or not found
      or review.review_state is distinct from 'supported'
      or review.review_id::text is distinct from entry->>'review_id'
      or review.record_hash is distinct from entry->>'record_hash' then
      raise exception 'Daily video source changed before start.'
        using errcode='23514';
    end if;
    count_seen:=count_seen+1;
    sources:=sources||jsonb_build_array(jsonb_build_object(
      'id',model_record.id::text,
      'kind',case
        when model_record.domain::text in ('market','icp','competitors') then 'market'
        when model_record.domain::text like '%offer%' then 'offer'
        when model_record.domain::text like '%proof%' then 'proof'
        when model_record.domain::text like '%campaign%' then 'campaign'
        else 'business' end,
      'asOf',review.observed_on,'text',model_record.body,
      'review_id',review.review_id,'record_hash',review.record_hash,
      'source_ref',review.source_ref));
  end loop;
  if count_seen<>cardinality(configured.model_record_ids) then
    raise exception 'Daily video source count changed.' using errcode='23514';
  end if;
  source_digest:=encode(sha256(convert_to(sources::text,'UTF8')),'hex');
  brief_digest:=encode(sha256(convert_to(brief.body,'UTF8')),'hex');
  idea_text:=left(coalesce(nullif(btrim(brief.title),''),'Daily video brief')
    ||' — '||btrim(brief.body),4000);
  request_key:='daily:'||item.id::text;
  request_hash:=encode(sha256(convert_to(jsonb_build_object(
    'item_id',item.id,'brief_id',brief.id,'brief_digest',brief_digest,
    'route_package_id',route.id,'daily_source_digest',configured.source_digest
  )::text,'UTF8')),'hex');
  insert into public.video_projects(client_id,idea,audience,tone,
    target_length_sec,aspects,stage,brief_id,campaign_id,route_package_id,
    request_key,request_hash,source_snapshot,source_digest,
    daily_item_id,daily_source_digest,daily_brief_body_sha256)
  values(run.client_id,idea_text,campaign.audience,'confident',60,
    array['9:16']::text[],'draft',brief.id,campaign.id,route.id,
    request_key,request_hash,sources,source_digest,
    item.id,configured.source_digest,brief_digest)
  returning * into project;
  v_job_id:=public.enqueue_agent_job_internal('video_script',run.client_id,
    'video_projects',project.id,run.created_by,
    jsonb_build_object('source_digest',source_digest,
      'ir_version',project.ir_version,'daily_item_id',item.id,
      'v5_workflow_run_id',run.id,'v5_step_key',step.step_key),
    'Queued: write a sourced daily code-video storyboard');
  update public.agent_jobs set run_id=run.id where id=v_job_id;
  update public.video_projects set stage='queued',job_id=v_job_id
    where id=project.id;
  update public.workflow_steps set status='queued',
    resolved_input_id=project.id,job_id=v_job_id,blocker=null,updated_at=now()
    where id=step.id;
  return jsonb_build_object('item_id',item.id,'project_id',project.id,
    'job_id',v_job_id,'stage','queued');
end $$;
revoke all on function public.start_daily_video_project_v1(uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.start_daily_video_project_v1(uuid)
  to service_role;
comment on function public.start_daily_video_project_v1(uuid) is
  'Atomically starts one exact daily item code-video project and script job. No provider call or external publication.';

-- The generic source guard is used by every downstream video worker. For
-- daily projects it additionally checks the exact brief body and saved
-- route/model review receipt. Older projects have no daily binding.
create or replace function public.video_project_source_current_v1(p_project_id uuid)
returns boolean language plpgsql volatile security definer
set search_path=pg_catalog,public as $$
declare p public.video_projects%rowtype;
  c public.client_campaigns%rowtype;
  route public.campaign_route_packages_v6%rowtype;
  entry jsonb; state record;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Service video source check only.' using errcode='42501'; end if;
  select * into p from public.video_projects where id=p_project_id;
  if not found or p.stage not in ('queued','scripting','timing','timed')
    or p.job_id is null
    or p.source_digest is distinct from
      encode(sha256(convert_to(p.source_snapshot::text,'UTF8')),'hex') then
    return false; end if;
  if p.brief_id is not null and not exists (
    select 1 from public.client_briefs b where b.id=p.brief_id
      and b.client_id=p.client_id and b.media_type='video'
      and b.status in ('approved','in_production','complete')) then
    return false; end if;
  if p.route_package_id is not null then
    select * into c from public.client_campaigns where id=p.campaign_id
      and client_id=p.client_id;
    select * into route from public.campaign_route_packages_v6
      where id=p.route_package_id and campaign_id=p.campaign_id
        and client_id=p.client_id;
    if c.id is null or c.status in ('cancelled','complete') or route.id is null
      or route.plan_fingerprint is distinct from public.campaign_plan_fingerprint(c)
      or route.version <> (select max(version)
        from public.campaign_route_packages_v6 rp
        where rp.campaign_id=route.campaign_id and rp.route=route.route) then
      return false; end if;
  end if;
  if p.daily_item_id is not null and (
    not public.daily_video_sources_current_v1(p.client_id)
    or p.daily_source_digest is distinct from (select d.source_digest
      from public.client_daily_video_sources_v1 d where d.client_id=p.client_id)
    or p.daily_brief_body_sha256 is distinct from (select
      encode(sha256(convert_to(b.body,'UTF8')),'hex')
      from public.client_briefs b where b.id=p.brief_id and b.client_id=p.client_id)
    or not exists(select 1 from public.daily_package_items item
      join public.daily_packages package on package.id=item.package_id
      where item.id=p.daily_item_id and package.client_id=p.client_id
        and item.campaign_id=p.campaign_id and item.final_step_id is not null)) then
    return false; end if;
  for entry in select value from jsonb_array_elements(p.source_snapshot) loop
    if entry->>'kind'='operator' then continue; end if;
    select * into state from public.model_section_review_state_v7
      where record_id=(entry->>'id')::uuid and client_id=p.client_id;
    if not found or state.review_state is distinct from 'supported'
      or state.review_id::text is distinct from entry->>'review_id'
      or state.record_hash is distinct from entry->>'record_hash' then
      return false; end if;
  end loop;
  return true;
end $$;

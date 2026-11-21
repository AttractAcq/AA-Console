-- Preserve exact brief and role lineage when an accepted code video becomes
-- a daily asset. Non-daily project attachment keeps its prior behaviour.

create or replace function public.attach_video_project_render_v1(
  p_project_id uuid,p_first_candidate_id uuid
) returns uuid language plpgsql volatile security definer
set search_path=pg_catalog,public,storage as $$
declare p public.video_projects%rowtype;
  first_candidate public.video_project_render_candidates_v1%rowtype;
  candidate public.video_project_render_candidates_v1%rowtype;
  prior public.video_project_attachments_v1%rowtype;
  daily_item public.daily_package_items%rowtype;
  o storage.objects%rowtype;
  candidate_count integer;
  asset_id uuid;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Service video attachment only.' using errcode='42501'; end if;
  select * into p from public.video_projects where id=p_project_id for update;
  if p.id is null then
    raise exception 'Video project does not exist.' using errcode='23514'; end if;
  select * into prior from public.video_project_attachments_v1
    where project_id=p.id and ir_version=p.ir_version;
  if prior.id is not null then
    if prior.first_candidate_id is distinct from p_first_candidate_id then
      raise exception 'Video attachment replay differs from receipt.'
        using errcode='23514'; end if;
    return prior.asset_id;
  end if;
  if p.stage is distinct from 'timed'
    or not public.video_project_source_current_v1(p.id)
    or not public.complete_video_audio_project_v1(p.id,p.ir_version) then
    raise exception 'Video project is not ready to attach.'
      using errcode='23514'; end if;
  select * into first_candidate from public.video_project_render_candidates_v1
    where id=p_first_candidate_id;
  if first_candidate.id is null
    or first_candidate.project_id is distinct from p.id
    or first_candidate.client_id is distinct from p.client_id
    or first_candidate.ir_version is distinct from p.ir_version
    or first_candidate.aspect is distinct from p.aspects[1]
    or first_candidate.verdict is distinct from 'accepted'
    or first_candidate.probe_result is distinct from 'pass' then
    raise exception 'Choose the accepted first-aspect candidate.'
      using errcode='23514'; end if;
  if p.daily_item_id is not null then
    select * into daily_item from public.daily_package_items
      where id=p.daily_item_id;
    if daily_item.id is null or daily_item.media_type is distinct from 'video'
      or daily_item.role not in ('reel','story')
      or first_candidate.aspect is distinct from '9:16' then
      raise exception 'Daily video attachment does not match its role or aspect.'
        using errcode='23514';
    end if;
  end if;
  select count(*) into candidate_count
    from public.video_project_render_candidates_v1
    where project_id=p.id and ir_version=p.ir_version;
  if candidate_count is distinct from cardinality(p.aspects) then
    raise exception 'Every requested aspect needs a candidate.'
      using errcode='23514'; end if;
  for candidate in select * from public.video_project_render_candidates_v1
      where project_id=p.id and ir_version=p.ir_version loop
    if candidate.aspect <> all(p.aspects)
      or candidate.verdict is distinct from 'accepted'
      or candidate.probe_result is distinct from 'pass' then
      raise exception 'Every requested aspect must pass review.'
        using errcode='23514'; end if;
    select * into o from storage.objects
      where bucket_id='client-media' and name=candidate.storage_path;
    if o.id is null or o.id is distinct from candidate.object_id
      or o.version is distinct from candidate.object_version
      or o.updated_at is distinct from candidate.object_updated_at then
      raise exception 'A render Storage object changed before attachment.'
        using errcode='23514'; end if;
  end loop;
  insert into public.client_media_assets
    (client_id,brief_id,media_type,content_format,title,storage_path,render_path,
      edit_stage,width,height,duration_sec,edit_plan)
  values(p.client_id,p.brief_id,'video',
    case when p.daily_item_id is not null then daily_item.content_format
      when first_candidate.aspect='9:16' then 'reel'::public.content_format
      else 'single'::public.content_format end,
    left('Video — '||p.idea,300),first_candidate.storage_path,
    first_candidate.storage_path,'review_ready',
    (first_candidate.media_probe->>'width')::integer,
    (first_candidate.media_probe->>'height')::integer,
    (first_candidate.media_probe->>'duration_sec')::numeric,
    jsonb_build_object('video_project_id',p.id,'ir_version',p.ir_version,
      'first_candidate_id',first_candidate.id,'aspects',p.aspects))
  returning id into asset_id;
  perform public.attest_creative_storage_bytes_v6(asset_id,
    first_candidate.storage_path,first_candidate.file_sha256,
    first_candidate.file_bytes,first_candidate.object_id,
    first_candidate.object_version,first_candidate.object_updated_at);
  insert into public.video_project_attachments_v1
    (project_id,client_id,ir_version,first_candidate_id,asset_id)
  values(p.id,p.client_id,p.ir_version,first_candidate.id,asset_id);
  update public.video_projects set stage='attached',stage_error=null
    where id=p.id;
  return asset_id;
end $$;

-- A script job is only the beginning of a code video. This bounded service
-- reconciler owns v6 video steps until the exact attached MP4 has passed
-- storage, candidate, route and brief checks. The v5 reconciler skips them.
create function public.reconcile_daily_code_video_steps_v1(p_limit integer default 20)
returns table(projects_started integer,assets_accepted integer,steps_held integer)
language plpgsql volatile security definer
set search_path=pg_catalog,public as $$
declare
  step public.workflow_steps%rowtype;
  run public.workflow_runs%rowtype;
  item public.daily_package_items%rowtype;
  package public.daily_packages%rowtype;
  project public.video_projects%rowtype;
  attachment public.video_project_attachments_v1%rowtype;
  candidate public.video_project_render_candidates_v1%rowtype;
  asset public.client_media_assets%rowtype;
  storage_identity jsonb;
  started_count integer:=0;
  accepted_count integer:=0;
  held_count integer:=0;
  candidate_count integer;
  accepted_candidate_count integer;
  version_key text;
  qa jsonb;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Service daily video reconciliation only.' using errcode='42501';
  end if;
  if p_limit not between 1 and 50 then
    raise exception 'Daily video reconciliation limit must be 1–50.'
      using errcode='22023';
  end if;
  for step in select s.* from public.workflow_steps s
    join public.workflow_runs r on r.id=s.run_id
    where r.kind='daily_content_package'
      and r.workflow_version='v6.daily.code_video.1'
      and s.agent_key='video_script' and s.input_table='video_projects'
      and s.status in ('pending','queued','running')
    order by r.deadline_at,s.created_at,s.id
    for update of s skip locked limit p_limit
  loop
    select * into run from public.workflow_runs where id=step.run_id;
    select * into item from public.daily_package_items
      where final_step_id=step.id;
    select * into package from public.daily_packages
      where id=item.package_id;
    if item.id is null or package.id is null
      or package.run_id is distinct from run.id then
      update public.workflow_steps set status='blocked',
        blocker='Daily video item or package is missing.',updated_at=now()
        where id=step.id;
      held_count:=held_count+1;
      continue;
    end if;
    if step.status='pending' then
      if exists(select 1 from unnest(step.dependencies) dep
        where not exists(select 1 from public.workflow_steps prior
          where prior.run_id=run.id and prior.step_key=dep
            and prior.status='completed')) then
        continue;
      end if;
      begin
        perform public.start_daily_video_project_v1(item.id);
        started_count:=started_count+1;
      exception when others then
        update public.workflow_steps set blocker=left(sqlerrm,1000),
          updated_at=now() where id=step.id;
        held_count:=held_count+1;
      end;
      continue;
    end if;
    select * into project from public.video_projects
      where id=step.resolved_input_id and daily_item_id=item.id;
    if project.id is null or project.client_id is distinct from run.client_id
      or project.job_id is distinct from step.job_id then
      update public.workflow_steps set status='blocked',
        blocker='Daily video project or job binding is missing.',updated_at=now()
        where id=step.id;
      held_count:=held_count+1;
      continue;
    end if;
    if project.stage not in ('attached','published') then
      update public.workflow_steps set status='running',
        blocker=case when project.stage in ('failed','needs_human')
          then coalesce(nullif(btrim(project.stage_error),''),
            'Video project needs operator review.')
          else null end,updated_at=now()
        where id=step.id;
      if project.stage in ('failed','needs_human') then
        held_count:=held_count+1;
      end if;
      continue;
    end if;
    select * into attachment from public.video_project_attachments_v1
      where project_id=project.id and ir_version=project.ir_version;
    select * into candidate from public.video_project_render_candidates_v1
      where id=attachment.first_candidate_id;
    select * into asset from public.client_media_assets
      where id=attachment.asset_id and client_id=run.client_id;
    select count(*),count(*) filter (where verdict='accepted'
      and probe_result='pass') into candidate_count,accepted_candidate_count
      from public.video_project_render_candidates_v1
      where project_id=project.id and ir_version=project.ir_version;
    if package.cutoff_at<=now() or run.deadline_at<=now()
      or attachment.id is null or candidate.id is null or asset.id is null
      or attachment.client_id is distinct from run.client_id
      or candidate.project_id is distinct from project.id
      or candidate.client_id is distinct from run.client_id
      or candidate.ir_version is distinct from project.ir_version
      or asset.brief_id is distinct from project.brief_id
      or asset.media_type is distinct from 'video'
      or asset.content_format is distinct from item.content_format
      or asset.render_path is distinct from candidate.storage_path
      or asset.delivery_bytes_sha256 is distinct from candidate.file_sha256
      or candidate_count is distinct from cardinality(project.aspects)
      or accepted_candidate_count is distinct from candidate_count
      or not public.daily_video_sources_current_v1(run.client_id)
      or project.daily_source_digest is distinct from
        (select source_digest from public.client_daily_video_sources_v1
          where client_id=run.client_id)
      or project.daily_brief_body_sha256 is distinct from
        (select encode(sha256(convert_to(b.body,'UTF8')),'hex')
          from public.client_briefs b where b.id=project.brief_id
            and b.client_id=run.client_id)
      or run.input_snapshot->>'video_route_package_id' is distinct from
        project.route_package_id::text
      or run.input_snapshot->>'video_source_digest' is distinct from
        project.daily_source_digest then
      update public.workflow_steps set status='running',
        blocker='Attached daily video failed exact source, render or cutoff checks.',
        updated_at=now() where id=step.id;
      held_count:=held_count+1;
      continue;
    end if;
    begin
      storage_identity:=public.creative_storage_identity_v6(asset.id);
    exception when others then
      update public.workflow_steps set status='running',
        blocker='Attached daily video Storage identity is unavailable.',
        updated_at=now() where id=step.id;
      held_count:=held_count+1;
      continue;
    end;
    if storage_identity->>'object_id' is distinct from candidate.object_id::text
      or storage_identity->>'object_version' is distinct from candidate.object_version
      or storage_identity->>'object_updated_at' is distinct from
        to_jsonb(candidate.object_updated_at)#>>'{}' then
      update public.workflow_steps set status='running',
        blocker='Attached daily video Storage object changed.',updated_at=now()
        where id=step.id;
      held_count:=held_count+1;
      continue;
    end if;
    version_key:=project.id::text||':ir-v'||project.ir_version::text||':'||
      candidate.file_sha256;
    qa:=jsonb_build_object('result','pass','checks',jsonb_build_array(
      'daily_item_project_binding','accepted_all_aspects','stored_mp4_bytes',
      'current_route_and_model_reviews','exact_approved_brief'),
      'project_id',project.id,'ir_version',project.ir_version,
      'candidate_id',candidate.id,'file_sha256',candidate.file_sha256,
      'source_digest',project.source_digest,
      'brief_sha256',project.daily_brief_body_sha256);
    insert into public.workflow_artifacts(run_id,step_id,artifact_kind,
      record_id,version_key,qa_evidence)
    values(run.id,step.id,'asset',asset.id,version_key,qa);
    update public.workflow_steps set status='completed',blocker=null,
      completed_at=now(),updated_at=now() where id=step.id;
    if not exists(select 1 from public.workflow_steps s
      where s.run_id=run.id and s.status<>'completed') then
      update public.workflow_runs set status='awaiting_human_approval',
        blocker=null,updated_at=now() where id=run.id;
    end if;
    accepted_count:=accepted_count+1;
  end loop;
  return query select started_count,accepted_count,held_count;
end $$;
revoke all on function public.reconcile_daily_code_video_steps_v1(integer)
  from public,anon,authenticated,service_role;
grant execute on function public.reconcile_daily_code_video_steps_v1(integer)
  to service_role;
comment on function public.reconcile_daily_code_video_steps_v1(integer) is
  'Starts v6 daily video projects after accepted briefs and accepts only exact attached MP4 assets after internal QA; human approval and publication remain separate.';

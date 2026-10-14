-- One bounded source-footage rebuild after an exhausted reel edit. The old
-- stills, clips, candidates and jobs remain; only the workflow's current
-- accepted-artifact pointers move to the new generation after internal QA.
create table workflow_reel_source_rebuilds (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null unique references workflow_runs(id) on delete cascade,
  edit_step_id uuid not null references workflow_steps(id) on delete cascade,
  source_asset_id uuid not null references client_media_assets(id),
  prior_artifacts jsonb not null check (jsonb_typeof(prior_artifacts) = 'array'),
  feedback text not null check (length(btrim(feedback)) between 20 and 4000),
  created_at timestamptz not null default now()
);
alter table workflow_reel_source_rebuilds enable row level security;
create policy workflow_reel_source_rebuilds_read on workflow_reel_source_rebuilds
  for select to authenticated using (exists (select 1 from workflow_runs r
    where r.id = run_id and can_access_client(r.client_id)));
grant select on workflow_reel_source_rebuilds to authenticated;

-- Automatic rebuilds only apply to runs planned after this migration. Older
-- pilots may have a contradictory brief, and silently replaying one is waste.
create table v5_reel_source_rebuild_activation (
  singleton boolean primary key default true check (singleton),
  activated_at timestamptz not null default now()
);
insert into v5_reel_source_rebuild_activation (singleton) values (true);

create or replace function enqueue_workflow_step_job(
  p_run workflow_runs, p_step workflow_steps, p_resolved_input uuid
) returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_brief client_briefs;
  v_prior video_render_candidates;
  v_generation_id uuid;
  v_render_id uuid;
  v_job_id uuid;
  v_params jsonb;
begin
  if auth.role() <> 'service_role' then raise exception 'AUTH: service role required'; end if;
  v_params := p_step.input_params || jsonb_build_object(
    'v5_workflow_run_id', p_run.id, 'v5_step_key', p_step.step_key);
  if p_step.agent_key = 'creative_build' then
    if p_step.input_table <> 'client_briefs' then
      raise exception 'Creative workflow step requires a brief.';
    end if;
    select * into v_brief from client_briefs where id = p_resolved_input;
    if not found or v_brief.client_id <> p_run.client_id then
      raise exception 'Creative brief is missing or belongs to another client.';
    end if;
    if v_brief.media_type = 'video' and
      (v_brief.content_format <> 'reel' or
        coalesce(v_brief.format_code, 'F6') not in ('F6', 'F7')) then
      raise exception 'Only a Phase 1 reel may use a video brief for opening stills.';
    end if;
    insert into creative_generations
      (client_id, brief_id, media_type, quality, size, created_by, remake_feedback)
    values (p_run.client_id, p_resolved_input,
      case when v_brief.media_type = 'video' then 'image'::media_type else v_brief.media_type end,
      'high', '1024x1536', p_run.created_by,
      nullif(btrim(p_step.input_params->>'v5_source_rebuild_feedback'), ''))
    returning id into v_generation_id;
    insert into creative_renders
      (generation_id, client_id, quality, size, created_by)
    values (v_generation_id, p_run.client_id, 'high', '1024x1536', p_run.created_by)
    returning id into v_render_id;
    v_params := v_params || jsonb_build_object('render_id', v_render_id);
  elsif p_step.agent_key = 'video_edit' and p_step.input_table = 'client_media_assets' then
    select * into v_prior from video_render_candidates c
      where c.asset_id = p_resolved_input and c.client_id = p_run.client_id
        and c.verdict = 'rejected'
      order by c.attempt desc, c.created_at desc, c.id desc limit 1;
    if found then
      v_params := v_params || jsonb_build_object('v5_video_revision',
        jsonb_build_object('candidate_id', v_prior.id,
          'reason', left(v_prior.rejection_reason, 1000),
          'edit_plan', v_prior.edit_plan));
    end if;
  end if;
  v_job_id := enqueue_agent_job_internal(
    p_step.agent_key, p_run.client_id, p_step.input_table, p_resolved_input,
    p_run.created_by, v_params, 'V5 workflow step queued.');
  if v_generation_id is not null then
    update creative_generations set job_id = v_job_id where id = v_generation_id;
    update creative_renders set job_id = v_job_id where id = v_render_id;
  end if;
  return v_job_id;
end;
$$;

create function retry_rejected_reel_source(p_edit_step_id uuid, p_feedback text)
returns workflow_reel_source_rebuilds language plpgsql security definer set search_path = public as $$
declare
  v_run_id uuid;
  v_edit workflow_steps;
  v_create workflow_steps;
  v_motion workflow_steps;
  v_run workflow_runs;
  v_job agent_jobs;
  v_asset client_media_assets;
  v_record workflow_reel_source_rebuilds;
  v_feedback text := btrim(coalesce(p_feedback, ''));
  v_artifacts jsonb;
begin
  if auth.role() <> 'service_role' then raise exception 'AUTH: service role required'; end if;
  if length(v_feedback) not between 20 and 4000 then
    raise exception 'Source rebuild needs specific feedback of 20..4000 characters.';
  end if;
  select run_id into v_run_id from workflow_steps where id = p_edit_step_id;
  if not found then raise exception 'Workflow step not found.'; end if;
  -- Reconciliation locks the run before its steps; keep the same lock order.
  select * into v_run from workflow_runs where id = v_run_id for update;
  select * into v_edit from workflow_steps where id = p_edit_step_id for update;
  select * into v_create from workflow_steps
    where run_id = v_run.id and step_key = 'reel_create' for update;
  select * into v_motion from workflow_steps
    where run_id = v_run.id and step_key = 'reel_motion' for update;
  select * into v_job from agent_jobs where id = v_edit.job_id;
  select * into v_asset from client_media_assets where id = v_edit.resolved_input_id;
  if v_run.kind <> 'daily_content_package' or v_run.status <> 'blocked'
    or v_run.deadline_at <= now() or v_edit.step_key <> 'reel_edit'
    or v_edit.agent_key <> 'video_edit' or v_edit.status <> 'blocked'
    or v_create.status <> 'completed' or v_create.agent_key <> 'creative_build'
    or v_motion.status <> 'completed' or v_motion.agent_key <> 'video_build'
    or v_job.status <> 'failed' or v_job.attempts < v_job.max_attempts
    or v_job.error is distinct from v_edit.blocker
    or v_asset.id is null or v_asset.client_id <> v_run.client_id
    or v_asset.render_path is not null or v_asset.human_approved_at is not null
    or exists (select 1 from workflow_steps s where s.run_id = v_run.id
      and s.id <> v_edit.id and s.status = 'blocked')
    or exists (select 1 from workflow_reel_source_rebuilds h where h.run_id = v_run.id)
    or (select count(*) from video_render_candidates c
      where c.job_id = v_job.id and c.asset_id = v_asset.id and c.verdict = 'rejected') < 2
    or exists (select 1 from video_render_candidates c
      where c.job_id = v_job.id and c.verdict <> 'rejected')
    or not exists (select 1 from workflow_artifacts a
      where a.step_id = v_create.id and a.record_id = v_asset.id)
    or not exists (select 1 from workflow_artifacts a
      where a.step_id = v_motion.id and a.record_id = v_asset.id)
    or exists (select 1 from workflow_artifacts a where a.step_id = v_edit.id)
  then raise exception 'Step is not eligible for a bounded reel source rebuild.'; end if;

  select coalesce(jsonb_agg(to_jsonb(a) order by a.accepted_at), '[]'::jsonb)
    into v_artifacts from workflow_artifacts a
    where a.step_id in (v_create.id, v_motion.id);
  insert into workflow_reel_source_rebuilds
    (run_id, edit_step_id, source_asset_id, prior_artifacts, feedback)
  values (v_run.id, v_edit.id, v_asset.id, v_artifacts, v_feedback)
  returning * into v_record;
  delete from workflow_artifacts where step_id in (v_create.id, v_motion.id);
  update workflow_steps set status = 'pending', job_id = null,
    resolved_input_id = null, blocker = null, completed_at = null,
    updated_at = now(),
    input_params = case when id = v_create.id then input_params ||
      jsonb_build_object('v5_source_rebuild_feedback', v_feedback)
      else input_params end
    where id in (v_create.id, v_motion.id, v_edit.id);
  update workflow_runs set status = 'running', blocker = null, updated_at = now()
    where id = v_run.id;
  return v_record;
end;
$$;
revoke all on function retry_rejected_reel_source(uuid, text) from public, anon, authenticated;
grant execute on function retry_rejected_reel_source(uuid, text) to service_role;

create function auto_rebuild_rejected_reel_sources(p_limit integer default 3)
returns integer language plpgsql security definer set search_path = public as $$
declare
  v_edit workflow_steps;
  v_feedback text;
  v_count integer := 0;
  v_activated_at timestamptz;
begin
  if auth.role() <> 'service_role' then raise exception 'AUTH: service role required'; end if;
  if p_limit not between 1 and 20 then raise exception 'Limit must be 1..20.'; end if;
  select activated_at into v_activated_at from v5_reel_source_rebuild_activation where singleton;
  for v_edit in select s.* from workflow_steps s
    join workflow_runs r on r.id = s.run_id
    where s.step_key = 'reel_edit' and s.status = 'blocked'
      and r.kind = 'daily_content_package' and r.status = 'blocked'
      and r.created_at >= v_activated_at and r.deadline_at > now()
      and not exists (select 1 from workflow_reel_source_rebuilds h where h.run_id = r.id)
      and exists (select 1 from video_render_candidates c
        where c.job_id = s.job_id and c.verdict = 'rejected'
          and c.creative_review->>'result' = 'fail'
          and exists (select 1 from jsonb_array_elements(case
            when jsonb_typeof(c.creative_review->'checks') = 'array'
              then c.creative_review->'checks' else '[]'::jsonb end) check_row
            where check_row->>'area' in ('continuity', 'narrative', 'visual_defects', 'crop')
              and check_row->>'verdict' = 'fail'))
    order by r.deadline_at, r.created_at
    for update of r skip locked limit p_limit
  loop
    select left('Rebuild the reel source footage, not merely the edit. Preserve one cast, location and hero prop across every shot; make the opening action visible and complete. Previous cut failed: '
      || coalesce(c.rejection_reason, ''), 4000)
      into v_feedback from video_render_candidates c
      where c.job_id = v_edit.job_id and c.verdict = 'rejected'
      order by c.attempt desc, c.created_at desc, c.id desc limit 1;
    if v_feedback is not null then
      begin
        perform retry_rejected_reel_source(v_edit.id, v_feedback);
        v_count := v_count + 1;
      exception when others then
        -- An ineligible blocked cut stays blocked for explicit review.
        raise warning 'Reel source rebuild skipped for step %: %', v_edit.id, sqlerrm;
      end;
    end if;
  end loop;
  return v_count;
end;
$$;
revoke all on function auto_rebuild_rejected_reel_sources(integer)
  from public, anon, authenticated;
grant execute on function auto_rebuild_rejected_reel_sources(integer) to service_role;
select lock_down_definer_functions();

-- Completed jobs are not accepted until their persisted output is checked.
-- This closes the daily graph without bypassing the separate owner/SMM gate.
create function accept_ready_daily_workflow_steps(p_limit integer default 20)
returns table (steps_accepted integer, steps_blocked integer)
language plpgsql security definer set search_path = public as $$
declare
  v_step workflow_steps;
  v_run workflow_runs;
  v_job agent_jobs;
  v_output jsonb;
  v_source jsonb;
  v_candidate jsonb;
  v_kind text;
  v_reason text;
  v_count integer;
  v_missing integer;
  v_record_id uuid;
  v_version text;
  v_evidence jsonb;
  v_accepted integer := 0;
  v_blocked integer := 0;
begin
  if auth.role() <> 'service_role' then raise exception 'AUTH: service role required'; end if;
  if p_limit not between 1 and 50 then raise exception 'Limit must be 1..50'; end if;

  for v_step in
    select s.* from workflow_steps s
    join workflow_runs r on r.id = s.run_id
    where r.kind = 'daily_content_package'
      and r.status = 'needs_internal_qa'
      and s.status = 'needs_internal_qa'
    order by r.deadline_at, s.created_at, s.id
    for update of s skip locked limit p_limit
  loop
    select * into v_run from workflow_runs where id = v_step.run_id;
    select * into v_job from agent_jobs where id = v_step.job_id;
    v_output := null;
    v_source := null;
    v_candidate := null;
    v_kind := null;
    v_reason := null;
    v_count := 0;
    v_missing := 0;
    if v_job.status is distinct from 'completed' then
      v_reason := 'The workflow job is not completed.';
    elsif v_step.agent_key = 'ideation' then
      select count(*), (array_agg(to_jsonb(i) order by i.created_at))[1]
        into v_count, v_output from client_ideas i where i.job_id = v_job.id;
      v_kind := 'idea';
      if v_count <> 1 then v_reason := 'Daily ideation must produce exactly one idea.';
      elsif nullif(btrim(v_output->>'title'), '') is null
         or length(btrim(coalesce(v_output->>'body', ''))) < 20
         or nullif(btrim(v_output->>'source_question'), '') is null
         or v_output->>'client_id' is distinct from v_run.client_id::text
         or v_output->>'campaign_id' is distinct from v_run.campaign_id::text
         or v_output->>'pillar_id' is distinct from v_run.input_snapshot->>'pillar_id'
         or v_output->>'target_platform' is distinct from v_step.input_params->>'target_platform'
         or v_output->>'content_format' is distinct from v_step.input_params->>'content_format'
         or v_output->>'media_type' is distinct from v_step.input_params->>'media_type'
      then v_reason := 'Generated idea failed client, campaign, pillar, format or source checks.';
      end if;
    elsif v_step.agent_key = 'brief' then
      select count(*), (array_agg(to_jsonb(b) order by b.created_at))[1]
        into v_count, v_output from client_briefs b where b.job_id = v_job.id;
      select to_jsonb(i) into v_source from client_ideas i
        where i.id = v_step.resolved_input_id;
      v_kind := 'brief';
      if v_count <> 1 then v_reason := 'Daily briefing must produce exactly one brief.';
      elsif v_source is null or v_output->>'client_id' is distinct from v_run.client_id::text
         or v_output->>'source_idea_id' is distinct from v_step.resolved_input_id::text
         or length(btrim(coalesce(v_output->>'body', ''))) < 80
         or v_output->>'content_format' is distinct from v_source->>'content_format'
         or v_output->>'media_type' is distinct from v_source->>'media_type'
         or v_output->>'target_platform' is distinct from v_source->>'target_platform'
      then v_reason := 'Generated brief failed idea lineage, format or substance checks.';
      end if;
    elsif v_step.agent_key = 'creative_build' then
      select count(*), (array_agg(to_jsonb(a) order by a.created_at))[1]
        into v_count, v_output from client_media_assets a
        where a.brief_id = v_step.resolved_input_id
          and a.client_id = v_run.client_id and a.created_at >= v_job.created_at;
      select to_jsonb(b) into v_source from client_briefs b
        where b.id = v_step.resolved_input_id;
      v_kind := 'asset';
      if v_count <> 1 then v_reason := 'Creative build must produce exactly one asset.';
      elsif v_source is null or nullif(btrim(v_output->>'storage_path'), '') is null
         or v_output->>'content_format' is distinct from v_source->>'content_format'
         or v_output->>'media_type' is distinct from v_source->>'media_type'
      then v_reason := 'Created asset failed brief, format or storage checks.';
      end if;
    elsif v_step.agent_key = 'video_build' then
      select to_jsonb(a) into v_output from client_media_assets a
      join workflow_artifacts prior on prior.record_id = a.id and prior.artifact_kind = 'asset'
      join workflow_steps prior_step on prior_step.id = prior.step_id
      where prior.run_id = v_run.id and prior_step.step_key = any(v_step.dependencies)
        and a.brief_id = v_step.resolved_input_id and a.client_id = v_run.client_id
      order by prior.accepted_at desc limit 1;
      v_kind := 'asset';
      if v_output is not null then
        select count(*), count(*) filter (where nullif(btrim(clip_path), '') is null)
          into v_count, v_missing from client_media_frames
          where asset_id = (v_output->>'id')::uuid;
      end if;
      if v_output is null or v_count < 2 or v_missing > 0 then
        v_reason := 'Video build has no accepted opening asset or complete clips.';
      end if;
    elsif v_step.agent_key = 'video_edit' then
      select to_jsonb(a) into v_output from client_media_assets a
        where a.id = v_step.resolved_input_id and a.client_id = v_run.client_id;
      select to_jsonb(c) into v_candidate from video_render_candidates c
        where c.job_id = v_job.id and c.asset_id = v_step.resolved_input_id
          and c.verdict = 'accepted'
        order by c.attempt desc limit 1;
      v_kind := 'asset';
      if v_output is null or v_candidate is null
         or v_output->>'render_path' is distinct from v_candidate->>'render_path'
         or v_candidate->'media_probe'->>'result' is distinct from 'pass'
         or v_candidate->'creative_review'->>'result' is distinct from 'pass'
      then v_reason := 'Final reel has no matching accepted media and creative review.';
      end if;
    else
      v_reason := 'No internal QA policy exists for this daily step.';
    end if;

    if v_reason is not null then
      update workflow_steps set status = 'blocked', blocker = v_reason,
        updated_at = now() where id = v_step.id;
      update workflow_runs set status = 'blocked', blocker = v_reason,
        updated_at = now() where id = v_run.id;
      v_blocked := v_blocked + 1;
      continue;
    end if;
    v_record_id := (v_output->>'id')::uuid;
    v_version := case when v_step.agent_key = 'video_edit'
      then md5(v_candidate->>'render_path') else md5(v_output::text) end;
    v_evidence := jsonb_build_object(
      'result', 'pass', 'checks', case v_step.agent_key
        when 'ideation' then jsonb_build_array('one_output', 'client_campaign_pillar', 'destination_format', 'source_question')
        when 'brief' then jsonb_build_array('one_output', 'accepted_idea_lineage', 'destination_format', 'body_substance')
        when 'creative_build' then jsonb_build_array('one_output', 'brief_lineage', 'destination_format', 'stored_asset')
        when 'video_build' then jsonb_build_array('accepted_opening_asset', 'all_shots_rendered')
        else jsonb_build_array('exact_render_path', 'media_probe_pass', 'creative_review_pass') end,
      'job_id', v_job.id, 'output_hash', md5(v_output::text),
      'candidate_id', v_candidate->>'id',
      'candidate_render_path', v_candidate->>'render_path',
      'media_probe', v_candidate->'media_probe',
      'creative_review', v_candidate->'creative_review');
    perform accept_workflow_step(v_step.id, v_kind, v_record_id, v_version, v_evidence);
    v_accepted := v_accepted + 1;
  end loop;
  return query select v_accepted, v_blocked;
end;
$$;
revoke all on function accept_ready_daily_workflow_steps(integer) from public, anon, authenticated;
grant execute on function accept_ready_daily_workflow_steps(integer) to service_role;
select lock_down_definer_functions();

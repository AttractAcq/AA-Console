-- Campaign sweeps continue independent branches after a sibling fails, and
-- apply the existing content QA checks before accepting each output.
begin;

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

create function public.accept_ready_campaign_workflow_steps_v7(p_limit integer default 20)
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
    where r.kind = 'campaign_sweep'
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
         or (v_step.input_params ? 'pillar_id'
           and v_output->>'pillar_id' is distinct from v_step.input_params->>'pillar_id')
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
      if v_output is null then
        v_reason := 'Video build has no accepted opening asset.';
      elsif v_count < 2 or v_missing > 0 then
        -- video_build completes after scheduling a paid Higgsfield collection.
        -- A queued/running follow-up is not a finished motion step; leave QA
        -- pending until it persists every clip or fails with no continuation.
        if exists (select 1 from agent_jobs follow_up
          where follow_up.id <> v_job.id and follow_up.agent_key = 'video_build'
            and follow_up.input_table = 'client_briefs'
            and follow_up.input_id = v_step.resolved_input_id
            and follow_up.params->>'v5_workflow_run_id' = v_run.id::text
            and follow_up.params->>'v5_step_key' = v_step.step_key
            and follow_up.status in ('queued', 'claimed', 'running')) then
          continue;
        end if;
        v_reason := 'Video build has no complete clips and no active collection job.';
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
    if v_kind='asset' and nullif(v_output->>'delivery_bytes_sha256','') is null then
      update workflow_steps set blocker='Waiting for exact stored-file SHA-256 attestation.',
        updated_at=now() where id=v_step.id;
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
      'creative_review', v_candidate->'creative_review',
      'source_fingerprint', case when v_kind='asset' then
        (select fingerprint from public.delivery_source_catalog_v6
          where entity_kind='content_asset' and source_key=v_record_id::text
            and client_id=v_run.client_id) else null end);
    perform accept_workflow_step(v_step.id, v_kind, v_record_id, v_version, v_evidence);
    v_accepted := v_accepted + 1;
  end loop;
  return query select v_accepted, v_blocked;
end;
$$;

revoke all on function public.accept_ready_campaign_workflow_steps_v7(integer)
  from public,anon,authenticated;
grant execute on function public.accept_ready_campaign_workflow_steps_v7(integer)
  to service_role;

commit;

-- A rejected v5 cut can spend the same job's remaining retry budget on a
-- new candidate. Feedback is tied to the rejected exact file and attempt.
create function stage_video_candidate_revision(p_candidate_id uuid)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare v_candidate video_render_candidates; v_job agent_jobs; v_feedback jsonb;
begin
  if auth.role() <> 'service_role' then raise exception 'AUTH: service role required'; end if;
  select * into v_candidate from video_render_candidates where id = p_candidate_id;
  if v_candidate.id is null or v_candidate.verdict <> 'rejected'
     or nullif(btrim(coalesce(v_candidate.rejection_reason, '')), '') is null then
    raise exception 'A rejected candidate with a reason is required.';
  end if;
  select * into v_job from agent_jobs where id = v_candidate.job_id for update;
  if v_job.id is null or v_job.agent_key <> 'video_edit'
     or v_job.input_table <> 'client_media_assets' or v_job.input_id <> v_candidate.asset_id
     or v_job.client_id <> v_candidate.client_id
     or v_job.params->>'v5_workflow_run_id' is null then
    raise exception 'Candidate must belong to a v5 video-edit job.';
  end if;
  v_feedback := jsonb_build_object('candidate_id', v_candidate.id,
    'attempt', v_candidate.attempt,
    'reason', left(v_candidate.rejection_reason, 1000),
    'edit_plan', v_candidate.edit_plan);
  if v_job.params->'v5_video_revision' = v_feedback then return v_feedback; end if;
  if v_job.attempts <> v_candidate.attempt
     or v_job.attempts >= v_job.max_attempts
     or v_job.status not in ('claimed', 'running') then
    raise exception 'This job has no active revision attempt remaining.';
  end if;
  update agent_jobs set params = coalesce(params, '{}'::jsonb)
    || jsonb_build_object('v5_video_revision', v_feedback)
    where id = v_job.id;
  return v_feedback;
end;
$$;
revoke all on function stage_video_candidate_revision(uuid) from public, anon, authenticated;
grant execute on function stage_video_candidate_revision(uuid) to service_role;
select lock_down_definer_functions();

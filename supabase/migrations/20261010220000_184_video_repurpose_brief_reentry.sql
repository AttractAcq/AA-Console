-- A selected, evidenced candidate may go through the standard Brief agent
-- immediately. The choice itself is the operator's idea review.
alter table video_repurpose_derivatives drop constraint if exists video_repurpose_derivatives_reentry_stage_check;
alter table video_repurpose_derivatives add constraint video_repurpose_derivatives_reentry_stage_check
  check (reentry_stage in ('ideation', 'brief'));

create function brief_video_repurpose_candidate(
  p_request_id uuid, p_candidate_index integer, p_target_platform post_platform
) returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_idea uuid;
  v_status idea_status;
begin
  v_idea := create_video_repurpose_idea(p_request_id, p_candidate_index, p_target_platform);
  select status into v_status from client_ideas where id = v_idea for update;
  if v_status in ('draft', 'approved') then
    perform approve_idea_and_generate_brief(v_idea);
  elsif v_status <> 'briefed' then
    raise exception 'This derivative idea can no longer be briefed.';
  end if;
  update video_repurpose_derivatives set reentry_stage = 'brief'
    where request_id = p_request_id and candidate_index = p_candidate_index
      and target_platform = p_target_platform;
  return v_idea;
end;
$$;
revoke execute on function brief_video_repurpose_candidate(uuid, integer, post_platform)
  from public, anon;
grant execute on function brief_video_repurpose_candidate(uuid, integer, post_platform)
  to authenticated;

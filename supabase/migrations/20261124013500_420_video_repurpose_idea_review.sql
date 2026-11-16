-- A repurposed quote is a draft idea, not its own human approval record.
-- The first click requests exact review; the second queues an approved brief.
begin;
create or replace function public.brief_video_repurpose_candidate(
 p_request_id uuid,p_candidate_index integer,p_target_platform public.post_platform)
returns uuid language plpgsql volatile security definer set search_path=pg_catalog,public as $$
declare v_idea uuid; v_status public.idea_status;
begin
 v_idea:=public.create_video_repurpose_idea(p_request_id,p_candidate_index,p_target_platform);
 select status into v_status from public.client_ideas where id=v_idea for update;
 if v_status='draft' then
  perform public.request_human_idea_review_v6(v_idea);
  return v_idea;
 elsif v_status='approved' then
  perform public.approve_idea_and_generate_brief(v_idea);
 elsif v_status<>'briefed' then
  raise exception 'This derivative idea can no longer be briefed.' using errcode='23514';
 end if;
 update public.video_repurpose_derivatives set reentry_stage='brief'
  where request_id=p_request_id and candidate_index=p_candidate_index
   and target_platform=p_target_platform and idea_id=v_idea;
 return v_idea;
end $$;
revoke all on function public.brief_video_repurpose_candidate(uuid,integer,public.post_platform)
 from public,anon,service_role;
grant execute on function public.brief_video_repurpose_candidate(uuid,integer,public.post_platform)
 to authenticated;
select public.lock_down_definer_functions();
commit;

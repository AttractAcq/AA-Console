-- Read one code-video project's recorded state through the existing bot and
-- client grant boundary. This returns no private media URL or approval action.
insert into mcp_internal.mcp_bot_permissions
  (bot_id,permission_pattern,granted_by)
select 'bot_chief_of_staff','content.video_project_status',
  'video-v7:read-only-status'
where not exists(select 1 from mcp_internal.mcp_bot_permissions
  where bot_id='bot_chief_of_staff'
    and permission_pattern='content.video_project_status');

create function public.mcp_video_project_status_v1(
  p_bot_id text,p_client_id uuid,p_project_id uuid
) returns jsonb language plpgsql volatile security definer
set search_path=pg_catalog,mcp_internal,public set timezone='UTC' as $$
declare s public.video_project_status_v1%rowtype;
begin
  perform mcp_internal.require_service_role();
  perform mcp_internal.require_active_bot(p_bot_id);
  perform mcp_internal.require_bot_client_grant(p_bot_id,p_client_id);
  if p_bot_id not in ('bot_chief_of_staff','bot_production')
    or not mcp_internal.bot_has_permission(
      p_bot_id,'content.video_project_status') then
    raise exception using message='bot_forbidden',errcode='P0001';
  end if;
  if p_project_id is null then
    raise exception using message='invalid_request',errcode='P0001'; end if;
  select * into s from public.video_project_status_v1
    where id=p_project_id and client_id=p_client_id;
  if s.id is null then
    raise exception using message='video_project_not_found',errcode='P0001'; end if;
  return jsonb_build_object(
    'project_id',s.id,'client_id',s.client_id,'stage',s.stage,
    'stage_error',s.stage_error,'ir_version',s.ir_version,
    'cost_usd_estimate',s.cost_usd,
    'scenes',s.scene_count,'audio_scenes',s.audio_scene_count,
    'render_candidates',s.candidate_count,
    'accepted_candidates',s.accepted_candidate_count,
    'critic_loops',s.critic_loop_count,
    'asset_id',s.asset_id,'asset_review_status',s.asset_review_status,
    'human_approved_at',s.human_approved_at);
end $$;
revoke all on function public.mcp_video_project_status_v1(text,uuid,uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.mcp_video_project_status_v1(text,uuid,uuid)
  to service_role;
comment on function public.mcp_video_project_status_v1(text,uuid,uuid) is
  'Read-only client-scoped video progress for Chief of Staff and Production bots. Candidate and attachment rows do not imply human approval or provider publication.';

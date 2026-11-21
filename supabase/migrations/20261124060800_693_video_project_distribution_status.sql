-- Keep video production, approval and distribution as separate observations.
-- A local published row with an external reference is still not provider
-- read-back. Append columns to preserve the existing view contract.
create or replace view public.video_project_status_v1 with (security_invoker=true) as
select p.id, p.client_id, p.idea, p.audience, p.stage, p.stage_error,
  p.ir_version, p.source_snapshot, p.created_at, p.updated_at, p.cost_usd,
  (select count(*) from public.video_scenes s
    where s.project_id=p.id and s.client_id=p.client_id) as scene_count,
  (select count(*) from public.video_scenes s
    where s.project_id=p.id and s.client_id=p.client_id
      and s.audio_path is not null) as audio_scene_count,
  (select count(*) from public.video_project_render_candidates_v1 c
    where c.project_id=p.id and c.client_id=p.client_id
      and c.ir_version=p.ir_version) as candidate_count,
  (select count(*) from public.video_project_render_candidates_v1 c
    where c.project_id=p.id and c.client_id=p.client_id
      and c.ir_version=p.ir_version and c.verdict='accepted'
      and c.probe_result='pass') as accepted_candidate_count,
  jsonb_array_length(p.critic_reports) as critic_loop_count,
  attachment.asset_id,
  asset.review_status as asset_review_status,
  asset.human_approved_at,
  (select count(*) from public.scheduled_posts sp
    where sp.client_id=p.client_id and sp.asset_id=attachment.asset_id
      and sp.publication_status in ('scheduled','publishing'))
    as scheduled_post_count,
  (select count(*) from public.scheduled_posts sp
    where sp.client_id=p.client_id and sp.asset_id=attachment.asset_id
      and sp.publication_status='published' and sp.published_at is not null
      and (nullif(btrim(sp.external_id),'') is not null
        or nullif(btrim(sp.external_url),'') is not null))
    as recorded_external_post_count,
  (select max(sp.published_at) from public.scheduled_posts sp
    where sp.client_id=p.client_id and sp.asset_id=attachment.asset_id
      and sp.publication_status='published' and sp.published_at is not null
      and (nullif(btrim(sp.external_id),'') is not null
        or nullif(btrim(sp.external_url),'') is not null))
    as last_recorded_external_post_at,
  (select count(*) from public.scheduled_posts sp
    where sp.client_id=p.client_id and sp.asset_id=attachment.asset_id
      and sp.publication_status='published' and sp.published_at is not null
      and nullif(btrim(sp.external_id),'') is null
      and nullif(btrim(sp.external_url),'') is null)
    as unconfirmed_published_row_count
from public.video_projects p
left join public.video_project_attachments_v1 attachment
  on attachment.project_id=p.id and attachment.client_id=p.client_id
    and attachment.ir_version=p.ir_version
left join public.client_media_assets asset
  on asset.id=attachment.asset_id and asset.client_id=p.client_id;

comment on view public.video_project_status_v1 is
  'Tenant-scoped video production, human review and local post state. External post references are recorded claims, not provider read-back.';

create or replace function public.mcp_video_project_status_v1(
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
    'human_approved_at',s.human_approved_at,
    'scheduled_posts',s.scheduled_post_count,
    'recorded_external_posts',s.recorded_external_post_count,
    'last_recorded_external_post_at',s.last_recorded_external_post_at,
    'unconfirmed_published_rows',s.unconfirmed_published_row_count);
end $$;

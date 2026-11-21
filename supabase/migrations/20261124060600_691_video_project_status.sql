-- One tenant-scoped read of the current code-video production state. Counts
-- describe recorded source rows, not provider execution or publication.
create view public.video_project_status_v1 with (security_invoker=true) as
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
  asset.human_approved_at
from public.video_projects p
left join public.video_project_attachments_v1 attachment
  on attachment.project_id=p.id and attachment.client_id=p.client_id
    and attachment.ir_version=p.ir_version
left join public.client_media_assets asset
  on asset.id=attachment.asset_id and asset.client_id=p.client_id;

revoke all on public.video_project_status_v1 from public,anon,authenticated;
grant select on public.video_project_status_v1 to authenticated,service_role;
comment on view public.video_project_status_v1 is
  'Current video project, scene, candidate and exact asset-review state. Security invoker retains every underlying client read policy. No field claims provider publication.';

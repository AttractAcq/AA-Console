-- A production attempt belongs to the workflow job that made it, even after
-- a failed step is retried and workflow_steps.job_id points at the new job.
-- Only exact workflow metadata is used; a shared brief or a nearby timestamp
-- is not evidence that an asset fulfilled a particular demand item.
create view public.production_demand_v7 with (security_invoker = true) as
select r.client_id, r.id as run_id, 'daily'::text as demand_kind,
  i.id as demand_id, i.campaign_id, null::uuid as route_package_id,
  p.platform::text as destination, i.media_type::text as media_type,
  i.content_format::text as content_format, i.role as piece_key,
  i.asset_id as accepted_asset_id
from public.daily_package_items i
join public.daily_packages p on p.id = i.package_id
join public.workflow_runs r on r.id = p.run_id and r.client_id = p.client_id
union all
select r.client_id, r.id, 'campaign'::text,
  b.work_item_id, w.campaign_id, w.route_package_id,
  w.expected_output->>'platform', w.expected_output->>'media_type',
  w.expected_output->>'content_format', b.piece_key,
  a.record_id
from public.campaign_sweep_work_bindings_v7 b
join public.workflow_runs r on r.id = b.run_id
join public.delivery_work_items_v6 w on w.id = b.work_item_id
  and w.client_id = r.client_id
join public.workflow_steps s on s.run_id = b.run_id
  and s.step_key = b.final_step_key
left join public.workflow_artifacts a on a.step_id = s.id
  and a.artifact_kind = 'asset';

create view public.production_attempts_v7 with (security_invoker = true) as
with candidates as (
  select cr.id as attempt_id, cr.job_id, cr.asset_id,
    'creative_render'::text as attempt_kind, cr.status::text as attempt_status,
    cr.cost_usd, cr.created_at,
    (g.remake_feedback is not null) as revision_requested
  from public.creative_renders cr
  join public.creative_generations g on g.id = cr.generation_id
  union all
  select vc.id, vc.job_id, vc.asset_id, 'video_cut'::text,
    vc.verdict, null::numeric, vc.created_at, vc.attempt > 1
  from public.video_render_candidates vc
)
select d.client_id, d.run_id, d.demand_kind, d.demand_id, d.campaign_id,
  d.route_package_id, d.destination, d.media_type, d.content_format,
  d.piece_key, c.attempt_id, c.attempt_kind, c.attempt_status,
  c.job_id, c.asset_id, c.cost_usd, c.created_at,
  (c.revision_requested and (c.attempt_kind <> 'video_cut'
    or j.params ? 'v5_video_revision')) as revised,
  m.review_status::text as human_review_status,
  case when c.asset_id = d.accepted_asset_id then true else false end
    as accepted_workflow_output
from candidates c
join public.agent_jobs j on j.id = c.job_id
join public.workflow_runs r on r.id::text = j.params->>'v5_workflow_run_id'
  and r.client_id = j.client_id
join public.workflow_steps s on s.run_id = r.id
  and s.step_key = j.params->>'v5_step_key'
join public.production_demand_v7 d on d.run_id = r.id
  and s.step_key like d.piece_key || '\_%' escape '\'
left join public.client_media_assets m on m.id = c.asset_id
  and m.client_id = d.client_id;

create view public.production_demand_counts_v7 with (security_invoker = true) as
select d.client_id, d.run_id, d.demand_kind, d.demand_id, d.campaign_id,
  d.route_package_id, d.destination, d.media_type, d.content_format,
  d.piece_key, d.accepted_asset_id,
  count(a.attempt_id)::integer as attempts,
  count(a.attempt_id) filter (where a.asset_id is not null
    and a.attempt_status in ('done', 'accepted'))::integer as produced,
  count(a.attempt_id) filter (where a.attempt_status in ('failed', 'rejected')
    or a.human_review_status = 'rejected')::integer as rejected,
  count(a.attempt_id) filter (where a.revised)::integer as revised,
  count(distinct a.asset_id) filter (where a.accepted_workflow_output)::integer
    as workflow_accepted,
  count(distinct a.asset_id) filter (where a.human_review_status = 'approved')::integer
    as human_approved
from public.production_demand_v7 d
left join public.production_attempts_v7 a on a.demand_kind = d.demand_kind
  and a.demand_id = d.demand_id
group by d.client_id, d.run_id, d.demand_kind, d.demand_id, d.campaign_id,
  d.route_package_id, d.destination, d.media_type, d.content_format,
  d.piece_key, d.accepted_asset_id;

grant select on public.production_demand_v7,
  public.production_attempts_v7, public.production_demand_counts_v7
  to authenticated, service_role;

comment on view public.production_demand_counts_v7 is
  'Requested demand plus exact job-linked render/cut counts. Revised means explicit creative remake feedback or a video cut after staged revision feedback. Workflow accepted and human approved are separate. Human rejection may appear on more than one render for the same asset; do not sum this as distinct rejected assets.';

create index creative_renders_job_lineage_idx on public.creative_renders(job_id)
  where job_id is not null;
create index agent_jobs_workflow_run_lineage_idx on public.agent_jobs
  ((params->>'v5_workflow_run_id'))
  where params ? 'v5_workflow_run_id';

-- Record a terminal timestamp for new image renders. Existing terminal rows
-- remain unknown because updated_at may have changed after rendering.
alter table public.creative_renders add column finished_at timestamptz;

create function public.stamp_creative_render_finish_v8() returns trigger
language plpgsql set search_path=pg_catalog,public as $$
begin
  if tg_op='INSERT' then
    if new.finished_at is not null then
      raise exception 'Render finish time is database-owned.';
    end if;
    if new.status in ('done','failed') then
      new.finished_at:=clock_timestamp();
    end if;
  else
    if new.finished_at is distinct from old.finished_at then
      raise exception 'Render finish time cannot be rewritten.';
    end if;
    if old.finished_at is null and old.status not in ('done','failed')
      and new.status in ('done','failed') then
      new.finished_at:=clock_timestamp();
    end if;
  end if;
  return new;
end $$;
create trigger creative_render_finish_v8
  before insert or update of status,finished_at on public.creative_renders
  for each row execute function public.stamp_creative_render_finish_v8();
revoke all on function public.stamp_creative_render_finish_v8()
  from public,anon,authenticated;

create view public.production_attempt_timing_v8
with (security_invoker=true) as
select a.client_id,a.run_id,a.demand_kind,a.demand_id,a.campaign_id,
  a.route_package_id,a.destination,a.media_type,a.content_format,a.piece_key,
  a.attempt_id,a.attempt_kind,a.attempt_status,a.job_id,a.asset_id,a.cost_usd,
  a.created_at,a.revised,a.human_review_status,a.accepted_workflow_output,
  case when a.attempt_kind='human_delivery' then j.created_at
    else a.created_at end as started_at,
  case a.attempt_kind
    when 'creative_render' then cr.finished_at
    when 'video_cut' then vc.reviewed_at
    when 'human_delivery' then h.delivered_at
    else null end as finished_at,
  case when a.attempt_kind='creative_render' then 'render'::text
    when a.attempt_kind='video_cut' then 'candidate review'::text
    when a.attempt_kind='human_delivery' then 'assignment to delivery'::text
    else 'unknown'::text end as timing_basis,
  case when a.attempt_kind='creative_render' then cr.error
    when a.attempt_kind='video_cut' then vc.rejection_reason
    else null end as failure_reason
from public.production_attempts_v8 a
left join public.creative_renders cr on a.attempt_kind='creative_render'
  and cr.id=a.attempt_id and cr.client_id=a.client_id
left join public.video_render_candidates vc on a.attempt_kind='video_cut'
  and vc.id=a.attempt_id and vc.client_id=a.client_id
left join public.assignment_deliveries_v7 h on a.attempt_kind='human_delivery'
  and h.id=a.attempt_id and h.client_id=a.client_id
left join public.job_assignments j on j.id=h.assignment_id
  and j.client_id=a.client_id;

grant select on public.production_attempt_timing_v8 to authenticated,service_role;
comment on view public.production_attempt_timing_v8 is
  'Exact production attempts with separate render, candidate-review and assignment-to-delivery timing bases. Historical creative renders without a trustworthy finish time remain null.';

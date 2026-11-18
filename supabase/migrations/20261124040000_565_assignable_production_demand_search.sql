-- An operator may discover demand by the exact brief consumed by its run.
-- This is a read surface only; create_demand_assignment_v7 rechecks the
-- relationship transactionally before creating the human assignment.
create view public.assignable_production_demands_v7
with (security_invoker=true) as
select distinct d.client_id,d.run_id,d.demand_kind,d.demand_id,
  d.campaign_id,d.route_package_id,d.destination,d.media_type,
  d.content_format,d.piece_key,
  coalesce(s.resolved_input_id,s.input_id) as brief_id,
  r.created_at as requested_at
from public.production_demand_v7 d
join public.workflow_runs r on r.id=d.run_id and r.client_id=d.client_id
join public.workflow_steps s on s.run_id=d.run_id
  and s.step_key like d.piece_key || '\_%' escape '\'
  and s.input_table='client_briefs'
  and coalesce(s.resolved_input_id,s.input_id) is not null
join public.client_briefs b on b.id=coalesce(s.resolved_input_id,s.input_id)
  and b.client_id=d.client_id;

grant select on public.assignable_production_demands_v7
  to authenticated,service_role;
comment on view public.assignable_production_demands_v7 is
  'Client- and brief-filterable campaign/daily requests with exact workflow input evidence. Listing does not approve or bind an assignment.';

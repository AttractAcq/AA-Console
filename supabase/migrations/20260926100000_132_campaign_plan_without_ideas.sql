-- A campaign may be planned before its content ideas are written. The planner
-- still records the number of pieces needed; Generate campaign ideas can fill
-- those positions later.
alter table client_campaigns
  add column ideate_on_plan boolean not null default true;

create function save_campaign_plan_only(
  p_campaign_id uuid,
  p_client_id uuid,
  p_job_id uuid,
  p_plan jsonb
)
returns void language plpgsql security definer set search_path = public as $$
declare
  c client_campaigns%rowtype;
  expected integer;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Only the agent runtime may save a campaign plan.';
  end if;
  select * into c from client_campaigns
   where id = p_campaign_id and client_id = p_client_id for update;
  if not found then raise exception 'That campaign no longer exists.'; end if;
  if c.ideate_on_plan then
    raise exception 'This campaign requested content ideas with its plan.';
  end if;
  if not exists (
    select 1 from agent_jobs j where j.id = p_job_id
      and j.client_id = p_client_id and j.agent_key = 'campaign_plan'
      and j.input_table = 'client_campaigns' and j.input_id = p_campaign_id
  ) then raise exception 'Invalid campaign planning job.'; end if;
  if c.built_at is not null then return; end if;

  expected := coalesce(floor((p_plan->>'content_count')::numeric), 0);
  if expected < 0 or expected > 30 then
    raise exception 'The campaign content count must be between 0 and 30.';
  end if;
  if nullif(btrim(p_plan->>'objective'), '') is null
     or nullif(btrim(p_plan->>'audience'), '') is null
     or nullif(btrim(p_plan->>'core_message'), '') is null
     or nullif(btrim(p_plan->>'kpi_metric'), '') is null
     or jsonb_typeof(p_plan->'channels') is distinct from 'array'
     or jsonb_array_length(p_plan->'channels') = 0
     or (expected = 0
         and not coalesce((p_plan->>'needs_landing_page')::boolean, false)
         and not coalesce((p_plan->>'needs_sales_agent')::boolean, false)) then
    raise exception 'The campaign plan is incomplete.';
  end if;

  update client_campaigns set
    objective = nullif(btrim(p_plan->>'objective'), ''),
    audience = nullif(btrim(p_plan->>'audience'), ''),
    offer_summary = nullif(btrim(p_plan->>'offer_summary'), ''),
    core_message = nullif(btrim(p_plan->>'core_message'), ''),
    channels = array(select jsonb_array_elements_text(p_plan->'channels')),
    budget = nullif(p_plan->>'budget', '')::numeric,
    starts_on = nullif(p_plan->>'starts_on', '')::date,
    ends_on = nullif(p_plan->>'ends_on', '')::date,
    kpi_metric = nullif(btrim(p_plan->>'kpi_metric'), ''),
    kpi_target = nullif(p_plan->>'kpi_target', '')::numeric,
    content_count = expected,
    needs_landing_page = coalesce((p_plan->>'needs_landing_page')::boolean, false),
    needs_sales_agent = coalesce((p_plan->>'needs_sales_agent')::boolean, false),
    built_at = now(), job_id = p_job_id, updated_at = now()
   where id = c.id;
end;
$$;
revoke execute on function save_campaign_plan_only(uuid, uuid, uuid, jsonb)
  from public, anon, authenticated;
grant execute on function save_campaign_plan_only(uuid, uuid, uuid, jsonb) to service_role;

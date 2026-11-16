-- A deployment may be enabled or served only while the exact public-use
-- decision still applies to the current script.
begin;
create or replace function public.resolve_sales_deployment(p_public_id text)
returns table (
  deployment_id uuid, client_id uuid, sales_agent_id uuid, page_id uuid,
  allowed_origin text, widget_config jsonb, daily_message_limit integer,
  daily_cost_limit_usd numeric, greeting text, system_prompt text,
  guardrails text, booking_rule text, escalation_rule text,
  qualification jsonb, objections jsonb
)
language sql stable security definer
set search_path = pg_catalog, public as $$
  select d.id,d.client_id,d.sales_agent_id,d.page_id,d.allowed_origin,d.widget_config,
    d.daily_message_limit,d.daily_cost_limit_usd,
    a.greeting,a.system_prompt,a.guardrails,a.booking_rule,a.escalation_rule,
    a.qualification,a.objections
  from public.client_sales_agent_deployments d
  join public.client_sales_agents a on a.id = d.sales_agent_id
    and a.client_id = d.client_id
  join public.client_pages p on p.id = d.page_id and p.client_id = d.client_id
  where d.public_id = p_public_id and d.enabled
    and d.page_id = a.page_id
    and p.publish_status = 'published' and p.published_url is not null
    and d.allowed_origin = mcp_internal.origin_for_page(p.published_url)
    and a.status = 'live' and a.approved_at is not null
    and a.built_at is not null and a.archived_at is null
    and public.sales_agent_public_use_current_v6(a.id)
    and auth.role() = 'service_role';
$$;
revoke all on function public.resolve_sales_deployment(text)
  from public,anon,authenticated;
grant execute on function public.resolve_sales_deployment(text) to service_role;

create function public.guard_sales_agent_deployment_enable_v6()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public as $$
begin
  if new.enabled and (tg_op = 'INSERT' or not old.enabled or
    new.sales_agent_id is distinct from old.sales_agent_id or
    new.page_id is distinct from old.page_id or
    new.client_id is distinct from old.client_id or
    new.allowed_origin is distinct from old.allowed_origin) and
    (not exists (select 1 from public.client_sales_agents a
      where a.id = new.sales_agent_id and a.client_id = new.client_id
        and a.page_id = new.page_id)
    or not exists (select 1 from public.client_pages p
      where p.id = new.page_id and p.client_id = new.client_id
        and p.publish_status = 'published' and p.published_url is not null
        and new.allowed_origin = mcp_internal.origin_for_page(p.published_url))
    or not public.sales_agent_public_use_current_v6(new.sales_agent_id)) then
    raise exception 'The exact sales-agent public-use approval is unavailable.'
      using errcode = '23514';
  end if;
  return new;
end $$;
create trigger sales_agent_deployment_enable_guard_v6
  before insert or update of enabled,sales_agent_id,page_id,client_id,allowed_origin
    on public.client_sales_agent_deployments
  for each row execute function public.guard_sales_agent_deployment_enable_v6();
revoke all on function public.guard_sales_agent_deployment_enable_v6()
  from public,anon,authenticated,service_role;

insert into public.approval_class_coverage_versions_v6
  (class_id,revision,class_key,title,source_state,source_evidence,
    decision_state,decision_evidence,executor_state,executor_evidence,blocker)
values (25,2,'sales_agent_public_use','Sales agent public-use approval',
  'verified','340 exact script, page, client and consequence preview with request token',
  'verified','342 AAL2 source-owned approval/revocation and direct-signature guard',
  'blocked','343 exact decision check before deployment enable and every public resolve; legacy approvals remain identified',
  'Historical approved agents need an explicit review and a live test conversation with an observed intake receipt.');
select public.lock_down_definer_functions();
commit;

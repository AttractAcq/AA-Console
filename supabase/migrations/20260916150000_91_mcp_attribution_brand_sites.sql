-- Phase 16c: realize attribution funnel/content reads, brand profile read,
-- and scoped sites provision/publish authorize RPCs.
-- DO NOT APPLY TO PRODUCTION without Alex approval.
-- Design note: aa-mcp-gateway/docs/phase-16c-attribution-brand-sites.md.
--
-- Attribution reads wrap Console acquisition_funnel / top_content_by_revenue
-- maths without can_access_client. Empty data is zeros/null ratios or [].
-- Brand is read-only. Sites SQL only authorizes; GitHub stays on the runtime.
-- Every Bot RPC: require_active_bot + require_bot_client_grant.

begin;

-- ---------------------------------------------------------------------------
-- Attribution: conversion funnel (Console acquisition_funnel, spend ledger)
-- ---------------------------------------------------------------------------
create function mcp_internal.attribution_conversion_funnel(
  p_bot_id text,
  p_client_id uuid,
  p_days integer default 30
)
returns jsonb language plpgsql volatile security definer
set search_path=pg_catalog,mcp_internal,public set timezone='UTC' as $$
declare
  v_days integer;
  v_leads integer;
  v_conversations integer;
  v_appointments integer;
  v_sales integer;
  v_lost integer;
  v_pipeline numeric;
  v_sale numeric;
  v_cash numeric;
  v_spend numeric;
begin
  perform mcp_internal.require_active_bot(p_bot_id);
  perform mcp_internal.require_bot_client_grant(p_bot_id, p_client_id);
  if not mcp_internal.bot_has_permission(p_bot_id, 'attribution.get_conversion_funnel') then
    raise exception using message='bot_forbidden', errcode='P0001';
  end if;
  perform 1 from mcp_internal.mcp_bots where bot_id=p_bot_id and status='active' for share;
  if not found then raise exception using message='bot_not_active', errcode='P0001'; end if;
  v_days := coalesce(p_days, 30);
  if v_days < 1 or v_days > 3650 then
    raise exception using message='invalid_request', errcode='P0001';
  end if;

  select count(*)::int,
         count(*) filter (where stage in ('conversation','qualified_conversation','appointment','qualified_appointment','shown','sale','cash'))::int,
         count(*) filter (where stage in ('appointment','qualified_appointment','shown','sale','cash'))::int,
         count(*) filter (where stage in ('sale','cash'))::int,
         count(*) filter (where stage = 'lost')::int,
         coalesce(sum(opportunity_value), 0),
         coalesce(sum(sale_value), 0),
         coalesce(sum(cash_collected), 0)
    into v_leads, v_conversations, v_appointments, v_sales, v_lost, v_pipeline, v_sale, v_cash
  from public.client_leads l
  where l.client_id = p_client_id
    and l.created_at >= now() - make_interval(days => v_days);

  select coalesce(sum(s.amount), 0) into v_spend
  from public.client_marketing_spend s
  where s.client_id = p_client_id
    and s.spent_on >= (current_date - v_days);

  return jsonb_build_object(
    'client_id', p_client_id,
    'projection', 'acquisition_funnel_v1',
    'days', v_days,
    'funnel', jsonb_build_object(
      'leads', v_leads,
      'conversations', v_conversations,
      'appointments', v_appointments,
      'sales', v_sales,
      'lost', v_lost,
      'pipeline_value', v_pipeline,
      'sale_value', v_sale,
      'cash_collected', v_cash,
      'spend', v_spend,
      'lead_to_sale_pct', case when v_leads > 0 then round(100.0 * v_sales / v_leads, 1) end,
      'cost_per_lead', case when v_leads > 0 and v_spend > 0 then round(v_spend / v_leads, 2) end,
      'return_on_spend', case when v_spend > 0 then round(v_cash / v_spend, 2) end
    )
  );
end $$;
revoke all on function mcp_internal.attribution_conversion_funnel(text,uuid,integer) from public,anon,authenticated,service_role;

create function public.mcp_attribution_conversion_funnel(
  p_bot_id text, p_client_id uuid, p_days integer default 30
) returns jsonb language plpgsql volatile security definer
set search_path=pg_catalog,mcp_internal,public set timezone='UTC' as $$
begin
  perform mcp_internal.require_service_role();
  perform mcp_internal.require_active_bot(p_bot_id);
  perform mcp_internal.require_bot_client_grant(p_bot_id, p_client_id);
  return mcp_internal.attribution_conversion_funnel(p_bot_id, p_client_id, p_days);
end $$;
revoke all on function public.mcp_attribution_conversion_funnel(text,uuid,integer) from public,anon,authenticated;
grant execute on function public.mcp_attribution_conversion_funnel(text,uuid,integer) to service_role;

-- ---------------------------------------------------------------------------
-- Attribution: content performance (Console top_content_by_revenue)
-- ---------------------------------------------------------------------------
create function mcp_internal.attribution_content_performance(
  p_bot_id text,
  p_client_id uuid,
  p_limit integer default 10
)
returns jsonb language plpgsql volatile security definer
set search_path=pg_catalog,mcp_internal,public set timezone='UTC' as $$
declare
  v_limit integer;
  v_items jsonb;
begin
  perform mcp_internal.require_active_bot(p_bot_id);
  perform mcp_internal.require_bot_client_grant(p_bot_id, p_client_id);
  if not mcp_internal.bot_has_permission(p_bot_id, 'attribution.get_content_performance') then
    raise exception using message='bot_forbidden', errcode='P0001';
  end if;
  perform 1 from mcp_internal.mcp_bots where bot_id=p_bot_id and status='active' for share;
  if not found then raise exception using message='bot_not_active', errcode='P0001'; end if;
  v_limit := coalesce(p_limit, 10);
  if v_limit < 1 or v_limit > 100 then
    raise exception using message='invalid_request', errcode='P0001';
  end if;

  select coalesce(jsonb_agg(to_jsonb(x) order by x.cash_collected desc, x.sale_value desc, x.leads desc, x.asset_created_at desc), '[]'::jsonb)
    into v_items
  from (
    select a.id as asset_id,
           a.ref_number as asset_ref,
           a.title as asset_title,
           b.hook,
           i.title as idea_title,
           i.content_territory,
           coalesce(rev.leads, 0) as leads,
           coalesce(rev.sales, 0) as sales,
           coalesce(rev.sale_value, 0) as sale_value,
           coalesce(rev.cash_collected, 0) as cash_collected,
           coalesce(att.spend, 0) as spend,
           coalesce(att.impressions, 0) as impressions,
           a.created_at as asset_created_at
    from public.client_media_assets a
    left join public.client_briefs b on b.id = a.brief_id
    left join public.client_ideas i on i.id = b.source_idea_id
    left join lateral (
      select coalesce(sum(m.impressions), 0)::bigint as impressions,
             coalesce(sum(m.spend), 0)::numeric as spend
      from public.metrics_daily m
      join public.scheduled_posts sp on sp.id = m.post_id
      where sp.asset_id = a.id
    ) att on true
    left join lateral (
      select count(*)::int as leads,
             count(*) filter (where l.stage in ('sale','cash'))::int as sales,
             coalesce(sum(l.sale_value), 0)::numeric as sale_value,
             coalesce(sum(l.cash_collected), 0)::numeric as cash_collected
      from public.client_leads l
      where l.source_asset_id = a.id
         or l.source_post_id in (select sp.id from public.scheduled_posts sp where sp.asset_id = a.id)
    ) rev on true
    where a.client_id = p_client_id
    order by coalesce(rev.cash_collected, 0) desc, coalesce(rev.sale_value, 0) desc,
             coalesce(rev.leads, 0) desc, a.created_at desc
    limit v_limit
  ) x;

  return jsonb_build_object(
    'client_id', p_client_id,
    'projection', 'content_attribution_v1',
    'items', v_items
  );
end $$;
revoke all on function mcp_internal.attribution_content_performance(text,uuid,integer) from public,anon,authenticated,service_role;

create function public.mcp_attribution_content_performance(
  p_bot_id text, p_client_id uuid, p_limit integer default 10
) returns jsonb language plpgsql volatile security definer
set search_path=pg_catalog,mcp_internal,public set timezone='UTC' as $$
begin
  perform mcp_internal.require_service_role();
  perform mcp_internal.require_active_bot(p_bot_id);
  perform mcp_internal.require_bot_client_grant(p_bot_id, p_client_id);
  return mcp_internal.attribution_content_performance(p_bot_id, p_client_id, p_limit);
end $$;
revoke all on function public.mcp_attribution_content_performance(text,uuid,integer) from public,anon,authenticated;
grant execute on function public.mcp_attribution_content_performance(text,uuid,integer) to service_role;

-- ---------------------------------------------------------------------------
-- Brand profile (read-only). Missing row => found=false, not invented colours.
-- ---------------------------------------------------------------------------
create function mcp_internal.brand_get_profile(p_bot_id text, p_client_id uuid)
returns jsonb language plpgsql volatile security definer
set search_path=pg_catalog,mcp_internal,public set timezone='UTC' as $$
declare
  v_row public.client_brand_profiles%rowtype;
begin
  perform mcp_internal.require_active_bot(p_bot_id);
  perform mcp_internal.require_bot_client_grant(p_bot_id, p_client_id);
  if p_bot_id not in ('bot_marketing', 'bot_sales_ops', 'bot_production') then
    raise exception using message='bot_forbidden', errcode='P0001';
  end if;
  if not mcp_internal.bot_has_permission(p_bot_id, 'brand.get_profile') then
    raise exception using message='bot_forbidden', errcode='P0001';
  end if;
  perform 1 from mcp_internal.mcp_bots where bot_id=p_bot_id and status='active' for share;
  if not found then raise exception using message='bot_not_active', errcode='P0001'; end if;

  select * into v_row from public.client_brand_profiles where client_id = p_client_id;
  if not found then
    return jsonb_build_object('client_id', p_client_id, 'found', false, 'profile', null);
  end if;
  return jsonb_build_object(
    'client_id', p_client_id,
    'found', true,
    'profile', jsonb_build_object(
      'colour_primary', v_row.colour_primary,
      'colour_secondary', v_row.colour_secondary,
      'colour_accent', v_row.colour_accent,
      'colour_background', v_row.colour_background,
      'colour_text', v_row.colour_text,
      'font_heading', v_row.font_heading,
      'font_body', v_row.font_body,
      'imagery_style', v_row.imagery_style,
      'lighting', v_row.lighting,
      'mood', v_row.mood,
      'composition_notes', v_row.composition_notes,
      'never_do', v_row.never_do,
      'custom_css', v_row.custom_css,
      'updated_at', v_row.updated_at
    )
  );
end $$;
revoke all on function mcp_internal.brand_get_profile(text,uuid) from public,anon,authenticated,service_role;

create function public.mcp_brand_get_profile(p_bot_id text, p_client_id uuid)
returns jsonb language plpgsql volatile security definer
set search_path=pg_catalog,mcp_internal,public set timezone='UTC' as $$
begin
  perform mcp_internal.require_service_role();
  perform mcp_internal.require_active_bot(p_bot_id);
  perform mcp_internal.require_bot_client_grant(p_bot_id, p_client_id);
  return mcp_internal.brand_get_profile(p_bot_id, p_client_id);
end $$;
revoke all on function public.mcp_brand_get_profile(text,uuid) from public,anon,authenticated;
grant execute on function public.mcp_brand_get_profile(text,uuid) to service_role;

-- ---------------------------------------------------------------------------
-- Sites authorize only. GitHub App private key never enters SQL.
-- ---------------------------------------------------------------------------
create function mcp_internal.sites_authorize(
  p_bot_id text,
  p_client_id uuid,
  p_tool text,
  p_page_id uuid default null
)
returns jsonb language plpgsql volatile security definer
set search_path=pg_catalog,mcp_internal,public set timezone='UTC' as $$
declare
  v_owner uuid;
begin
  perform mcp_internal.require_active_bot(p_bot_id);
  perform mcp_internal.require_bot_client_grant(p_bot_id, p_client_id);
  if p_bot_id not in ('bot_marketing', 'bot_sales_ops') then
    raise exception using message='bot_forbidden', errcode='P0001';
  end if;
  if p_tool is null or p_tool not in ('sites.provision', 'sites.publish_page') then
    raise exception using message='invalid_request', errcode='P0001';
  end if;
  if not mcp_internal.bot_has_permission(p_bot_id, p_tool) then
    raise exception using message='bot_forbidden', errcode='P0001';
  end if;
  perform 1 from mcp_internal.mcp_bot_permissions
    where bot_id=p_bot_id and permission_pattern=p_tool for share;
  if not found then raise exception using message='bot_forbidden', errcode='P0001'; end if;
  perform 1 from mcp_internal.mcp_bots where bot_id=p_bot_id and status='active' for share;
  if not found then raise exception using message='bot_not_active', errcode='P0001'; end if;

  if p_tool = 'sites.publish_page' then
    if p_page_id is null then
      raise exception using message='invalid_request', errcode='P0001';
    end if;
    select client_id into v_owner from public.client_pages where id = p_page_id for share;
    if not found or v_owner is distinct from p_client_id then
      raise exception using message='page_not_found', errcode='P0001';
    end if;
    return jsonb_build_object('client_id', p_client_id, 'page_id', p_page_id, 'authorized', true);
  end if;

  return jsonb_build_object('client_id', p_client_id, 'authorized', true);
end $$;
revoke all on function mcp_internal.sites_authorize(text,uuid,text,uuid) from public,anon,authenticated,service_role;

create function public.mcp_sites_authorize(
  p_bot_id text, p_client_id uuid, p_tool text, p_page_id uuid default null
) returns jsonb language plpgsql volatile security definer
set search_path=pg_catalog,mcp_internal,public set timezone='UTC' as $$
begin
  perform mcp_internal.require_service_role();
  perform mcp_internal.require_active_bot(p_bot_id);
  perform mcp_internal.require_bot_client_grant(p_bot_id, p_client_id);
  return mcp_internal.sites_authorize(p_bot_id, p_client_id, p_tool, p_page_id);
end $$;
revoke all on function public.mcp_sites_authorize(text,uuid,text,uuid) from public,anon,authenticated;
grant execute on function public.mcp_sites_authorize(text,uuid,text,uuid) to service_role;

-- Keep every prior CoS prohibition; add Gate 16c brand/sites ownership.
create or replace function mcp_internal.assert_cos_prohibitions()
returns void
language plpgsql
set search_path = mcp_internal, public
as $$
begin
  if exists (
    select 1 from mcp_internal.mcp_bot_permissions p
    where p.bot_id = 'bot_production'
      and (
        p.permission_pattern like 'economics%'
        or p.permission_pattern like 'finance%'
        or p.permission_pattern like 'security%'
        or p.permission_pattern like '%deploy%'
        or p.permission_pattern like 'conversion%'
        or mcp_internal.permission_matches(p.permission_pattern, 'economics.get_costs')
        or mcp_internal.permission_matches(p.permission_pattern, 'security.get_system_status')
        or mcp_internal.permission_matches(p.permission_pattern, 'sales_agents.deploy')
        or mcp_internal.permission_matches(p.permission_pattern, 'conversion.list_pages')
      )
  ) then
    raise exception 'CoS: bot_production must not have finance, security, deploy or conversion grants';
  end if;
  if exists (
    select 1 from mcp_internal.mcp_bot_permissions p
    where p.bot_id = 'bot_finance'
      and (
        p.permission_pattern = 'content.*'
        or (
          p.permission_pattern like 'content.%'
          and p.permission_pattern !~ '^content\.(get|list|search)'
        )
      )
  ) then
    raise exception 'CoS: bot_finance must not have content write grants';
  end if;
  if exists (
    select 1 from mcp_internal.mcp_bot_permissions p
    where p.bot_id = 'bot_security_devops'
      and (
        p.permission_pattern like 'economics%'
        or p.permission_pattern like 'finance%'
        or p.permission_pattern = 'finance_periods'
        or p.permission_pattern = 'attribution.get_revenue_attribution'
        or mcp_internal.permission_matches(p.permission_pattern, 'economics.get_costs')
        or mcp_internal.permission_matches(p.permission_pattern, 'attribution.get_revenue_attribution')
      )
  ) then
    raise exception 'CoS: bot_security_devops must not have client financials or finance_periods grants';
  end if;
  if exists (
    select 1 from mcp_internal.mcp_bot_permissions p
    where p.bot_id <> 'bot_sales_ops'
      and (p.permission_pattern like 'pipeline.%' or p.permission_pattern like 'sales_agents.%')
  ) then
    raise exception 'Phase 11: pipeline.*/sales_agents.* must not be granted outside bot_sales_ops';
  end if;
  if exists (
    select 1 from mcp_internal.mcp_bot_permissions p
    where p.bot_id = 'bot_sales_ops'
      and (
        p.permission_pattern in ('pipeline.record_sale', 'sales_agents.deploy',
          'proof.search', 'proof.get', 'proof.*')
        or p.permission_pattern = 'pipeline.*'
        or p.permission_pattern = 'sales_agents.*'
      )
  ) then
    raise exception 'Phase 11b: bot_sales_ops must not hold record_sale/deploy/proof.* or a domain wildcard';
  end if;
  if exists (
    select 1 from mcp_internal.mcp_bot_permissions p
    where p.bot_id = 'bot_finance'
      and (
        p.permission_pattern = 'economics.*'
        or p.permission_pattern like 'finance.%'
        or p.permission_pattern like '%payment%'
        or p.permission_pattern like '%stripe%'
        or p.permission_pattern like '%xero%'
        or p.permission_pattern like '%bank%'
        or p.permission_pattern = 'pipeline.record_sale'
      )
  ) then
    raise exception 'Phase 13: bot_finance must not hold economics.* wildcard or money-write/payment grants';
  end if;
  if exists (
    select 1 from mcp_internal.mcp_bot_permissions p
    where p.bot_id <> 'bot_finance'
      and p.permission_pattern like 'economics%'
  ) then
    raise exception 'Phase 13: economics.* must not be granted outside bot_finance';
  end if;
  if exists (
    select 1 from mcp_internal.mcp_bot_permissions p
    where p.permission_pattern = 'engineering.*'
  ) then
    raise exception 'Phase 14: engineering.* wildcard is forbidden';
  end if;
  if exists (
    select 1 from mcp_internal.mcp_bot_permissions p
    where p.bot_id <> 'bot_engineering'
      and p.permission_pattern in ('engineering.create_issue', 'engineering.get_issue')
  ) then
    raise exception 'Phase 14: issue tools must not be granted outside bot_engineering';
  end if;
  if exists (
    select 1 from mcp_internal.mcp_bot_permissions p
    where p.bot_id = 'bot_engineering'
      and (
        p.permission_pattern like 'railway%'
        or p.permission_pattern like 'secret%'
        or p.permission_pattern like 'infra%'
        or p.permission_pattern like 'sites%'
        or p.permission_pattern in ('sales_agents.deploy', 'deploy')
        or p.permission_pattern like '%.deploy'
        or p.permission_pattern like 'deploy.%'
        or p.permission_pattern like 'finance%'
        or p.permission_pattern like 'economics%'
      )
  ) then
    raise exception 'Phase 14: bot_engineering must not hold deploy, secrets, infra, sites or finance grants';
  end if;
  if exists (
    select 1 from mcp_internal.mcp_bot_permissions p
    where p.permission_pattern = 'security.*'
  ) then
    raise exception 'Phase 15: security.* wildcard is forbidden';
  end if;
  if exists (
    select 1 from mcp_internal.mcp_bot_permissions p
    where p.bot_id <> 'bot_security_devops'
      and (
        p.permission_pattern like 'security.%'
        or p.permission_pattern = 'security.*'
      )
  ) then
    raise exception 'Phase 15: security tools must not be granted outside bot_security_devops';
  end if;
  if exists (
    select 1 from mcp_internal.mcp_bot_permissions p
    where p.bot_id = 'bot_security_devops'
      and (
        p.permission_pattern like 'railway%'
        or p.permission_pattern like 'secret%'
        or p.permission_pattern like 'infra%'
        or p.permission_pattern like '%destroy%'
        or p.permission_pattern like '%rotate%'
        or p.permission_pattern in ('sales_agents.deploy', 'deploy')
        or p.permission_pattern like '%.deploy'
        or p.permission_pattern like 'deploy.%'
        or p.permission_pattern like '%global%'
        or p.permission_pattern = '*'
      )
  ) then
    raise exception 'Phase 15: bot_security_devops must not hold destroy, secrets, infra, deploy or global grants';
  end if;
  if exists (
    select 1 from mcp_internal.mcp_bot_permissions p
    where p.permission_pattern = 'conversion.*'
  ) then
    raise exception 'Phase 16: conversion.* wildcard is forbidden';
  end if;
  if exists (
    select 1 from mcp_internal.mcp_bot_permissions p
    where p.bot_id <> 'bot_marketing'
      and (
        p.permission_pattern like 'conversion.%'
        or p.permission_pattern = 'conversion.*'
      )
  ) then
    raise exception 'Phase 16: conversion tools must not be granted outside bot_marketing';
  end if;
  if exists (
    select 1 from mcp_internal.mcp_bot_permissions p
    where p.bot_id <> 'bot_production'
      and p.permission_pattern like 'proof.%'
  ) then
    raise exception 'Phase 16b: proof.* must not be granted outside bot_production';
  end if;
  if exists (
    select 1 from mcp_internal.mcp_bot_permissions p
    where p.permission_pattern in ('sites.*', 'brand.*')
  ) then
    raise exception 'Phase 16c: sites.* / brand.* wildcards are forbidden';
  end if;
  if exists (
    select 1 from mcp_internal.mcp_bot_permissions p
    where p.permission_pattern in ('sites.provision', 'sites.publish_page')
      and p.bot_id not in ('bot_marketing', 'bot_sales_ops')
  ) then
    raise exception 'Phase 16c: sites tools must not be granted outside bot_marketing/bot_sales_ops';
  end if;
  if exists (
    select 1 from mcp_internal.mcp_bot_permissions p
    where p.permission_pattern = 'brand.get_profile'
      and p.bot_id not in ('bot_marketing', 'bot_sales_ops', 'bot_production')
  ) then
    raise exception 'Phase 16c: brand.get_profile must not be granted outside Marketing/Sales Ops/Production';
  end if;
end
$$;
revoke all on function mcp_internal.assert_cos_prohibitions() from public, anon, authenticated;
grant execute on function mcp_internal.assert_cos_prohibitions() to service_role;

-- Additive only. Includes #48's Marketing 40 names so this migration can assert
-- the post-#48+#46 ceiling of 45 even on a Gate-9-only fixture; after #48 those
-- rows already exist and the insert is a no-op. Same for #47's Sales Ops 25.
insert into mcp_internal.mcp_bot_permissions(bot_id, permission_pattern, granted_by)
select v.bot_id, v.name, v.granted_by
from (values
  -- Phase 16 (#48) Marketing 40
  ('bot_marketing', 'campaign.list', 'phase-16c:post-48-ceiling'),
  ('bot_marketing', 'campaign.get', 'phase-16c:post-48-ceiling'),
  ('bot_marketing', 'campaign.get_status', 'phase-16c:post-48-ceiling'),
  ('bot_marketing', 'campaign.get_readiness', 'phase-16c:post-48-ceiling'),
  ('bot_marketing', 'content.list_ideas', 'phase-16c:post-48-ceiling'),
  ('bot_marketing', 'content.get_idea', 'phase-16c:post-48-ceiling'),
  ('bot_marketing', 'content.get_brief', 'phase-16c:post-48-ceiling'),
  ('bot_marketing', 'content.get_production_status', 'phase-16c:post-48-ceiling'),
  ('bot_marketing', 'attribution.get_campaign_performance', 'phase-16c:post-48-ceiling'),
  ('bot_marketing', 'delivery.get_client', 'phase-16c:post-48-ceiling'),
  ('bot_marketing', 'delivery.get_status', 'phase-16c:post-48-ceiling'),
  ('bot_marketing', 'delivery.get_client_health', 'phase-16c:post-48-ceiling'),
  ('bot_marketing', 'workflow.get_pending_approvals', 'phase-16c:post-48-ceiling'),
  ('bot_marketing', 'workflow.get_activity', 'phase-16c:post-48-ceiling'),
  ('bot_marketing', 'workflow.list_tasks', 'phase-16c:post-48-ceiling'),
  ('bot_marketing', 'workflow.get_task', 'phase-16c:post-48-ceiling'),
  ('bot_marketing', 'conversion.list_pages', 'phase-16c:post-48-ceiling'),
  ('bot_marketing', 'conversion.get_page', 'phase-16c:post-48-ceiling'),
  ('bot_marketing', 'conversion.get_performance', 'phase-16c:post-48-ceiling'),
  ('bot_marketing', 'content.generate_brief', 'phase-16c:post-48-ceiling'),
  ('bot_marketing', 'content.request_revision', 'phase-16c:post-48-ceiling'),
  ('bot_marketing', 'content.request_approval', 'phase-16c:post-48-ceiling'),
  ('bot_marketing', 'content.create_repurpose_plan', 'phase-16c:post-48-ceiling'),
  ('bot_marketing', 'workflow.create_task', 'phase-16c:post-48-ceiling'),
  ('bot_marketing', 'workflow.assign_task', 'phase-16c:post-48-ceiling'),
  ('bot_marketing', 'workflow.complete_task', 'phase-16c:post-48-ceiling'),
  ('bot_marketing', 'workflow.create_approval', 'phase-16c:post-48-ceiling'),
  ('bot_marketing', 'conversion.create_page', 'phase-16c:post-48-ceiling'),
  ('bot_marketing', 'conversion.generate_structure', 'phase-16c:post-48-ceiling'),
  ('bot_marketing', 'conversion.generate_copy', 'phase-16c:post-48-ceiling'),
  ('bot_marketing', 'conversion.request_approval', 'phase-16c:post-48-ceiling'),
  ('bot_marketing', 'conversion.audit_page', 'phase-16c:post-48-ceiling'),
  ('bot_marketing', 'conversion.revise_page', 'phase-16c:post-48-ceiling'),
  ('bot_marketing', 'conversion.revert_page', 'phase-16c:post-48-ceiling'),
  ('bot_marketing', 'campaign.create', 'phase-16c:post-48-ceiling'),
  ('bot_marketing', 'campaign.update', 'phase-16c:post-48-ceiling'),
  ('bot_marketing', 'campaign.request_approval', 'phase-16c:post-48-ceiling'),
  ('bot_marketing', 'campaign.plan', 'phase-16c:post-48-ceiling'),
  ('bot_marketing', 'campaign.provision', 'phase-16c:post-48-ceiling'),
  ('bot_marketing', 'campaign.launch', 'phase-16c:post-48-ceiling'),
  -- Phase 16c five
  ('bot_marketing', 'attribution.get_conversion_funnel', 'phase-16c:attribution-brand-sites'),
  ('bot_marketing', 'attribution.get_content_performance', 'phase-16c:attribution-brand-sites'),
  ('bot_marketing', 'brand.get_profile', 'phase-16c:attribution-brand-sites'),
  ('bot_marketing', 'sites.provision', 'phase-16c:attribution-brand-sites'),
  ('bot_marketing', 'sites.publish_page', 'phase-16c:attribution-brand-sites'),
  -- Phase 16b (#47) Sales Ops three — never overwrite; insert if missing
  ('bot_sales_ops', 'sales_agents.attach_to_page', 'phase-16c:keep-47-attach-enable-build'),
  ('bot_sales_ops', 'sales_agents.set_deployment_enabled', 'phase-16c:keep-47-attach-enable-build'),
  ('bot_sales_ops', 'sales_agents.build', 'phase-16c:keep-47-attach-enable-build'),
  -- Phase 16c Sales Ops three
  ('bot_sales_ops', 'brand.get_profile', 'phase-16c:attribution-brand-sites'),
  ('bot_sales_ops', 'sites.provision', 'phase-16c:attribution-brand-sites'),
  ('bot_sales_ops', 'sites.publish_page', 'phase-16c:attribution-brand-sites'),
  ('bot_production', 'brand.get_profile', 'phase-16c:attribution-brand-sites')
) as v(bot_id, name, granted_by)
where not exists (
  select 1 from mcp_internal.mcp_bot_permissions p
  where p.bot_id = v.bot_id and p.permission_pattern = v.name
);

do $$
declare n integer;
begin
  perform mcp_internal.assert_cos_prohibitions();
  select count(*)::int into n from mcp_internal.mcp_bot_permissions where bot_id='bot_marketing';
  if n <> 45 then
    raise exception 'Phase 16c: bot_marketing must have exactly 45 permission rows after #48+#46, found %', n;
  end if;
  select count(*)::int into n from mcp_internal.mcp_bot_permissions where bot_id='bot_sales_ops';
  if n <> 28 then
    raise exception 'Phase 16c: bot_sales_ops must have exactly 28 permission rows after #47+#46, found %', n;
  end if;
  if not exists (
    select 1 from mcp_internal.mcp_bot_permissions
    where bot_id='bot_sales_ops' and permission_pattern='sales_agents.attach_to_page'
  ) or not exists (
    select 1 from mcp_internal.mcp_bot_permissions
    where bot_id='bot_sales_ops' and permission_pattern='sales_agents.set_deployment_enabled'
  ) or not exists (
    select 1 from mcp_internal.mcp_bot_permissions
    where bot_id='bot_sales_ops' and permission_pattern='sales_agents.build'
  ) then
    raise exception 'Phase 16c: bot_sales_ops must retain #47 attach/enable/build grants';
  end if;
  if not exists (
    select 1 from mcp_internal.mcp_bot_permissions
    where bot_id='bot_production' and permission_pattern='brand.get_profile'
  ) then
    raise exception 'Phase 16c: bot_production missing brand.get_profile';
  end if;
  if exists (
    select 1 from mcp_internal.mcp_bot_permissions
    where bot_id='bot_engineering' and permission_pattern like 'sites%'
  ) then
    raise exception 'Phase 16c: bot_engineering must not hold sites grants';
  end if;
  if not exists (
    select 1 from mcp_internal.mcp_bot_permissions
    where bot_id='bot_distribution' and permission_pattern='attribution.get_content_performance'
  ) then
    raise exception 'Phase 16c: bot_distribution must retain attribution.get_content_performance';
  end if;
end $$;

commit;

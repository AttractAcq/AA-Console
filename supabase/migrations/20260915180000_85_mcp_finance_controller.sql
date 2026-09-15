-- Phase 13: Finance Controller MCP. Read-only Client Economics OS + revenue
-- attribution for bot_finance. DO NOT APPLY TO PRODUCTION without Alex approval.
-- Design note: aa-mcp-gateway/docs/phase-13-finance-controller.md.
--
-- Exact 14-tool allowlist: five named economics reads, attribution.get_revenue_attribution,
-- and the existing eight workflow tools. Replaces the seeded economics.* wildcard.
-- No bank/Stripe/Xero/payments, no token mint, no client grants, no money writes.
-- Every Bot RPC: require_active_bot + require_bot_client_grant; never can_access_client.
-- Inlines cohort maths from migration 79 rather than calling client_economics(),
-- which still uses can_access_client for human Console paths.

begin;

create function mcp_internal.require_finance_permission(p_bot_id text, p_client_id uuid, p_tool text)
returns void language plpgsql volatile security definer
set search_path=pg_catalog,mcp_internal,public set timezone='UTC' as $$
begin
  perform mcp_internal.require_active_bot(p_bot_id);
  perform mcp_internal.require_bot_client_grant(p_bot_id, p_client_id);
  if p_bot_id is distinct from 'bot_finance' or p_tool not in (
    'economics.get_client_economics','economics.get_campaign_economics',
    'economics.get_costs','economics.get_revenue','economics.get_roi'
  ) then
    raise exception using message='bot_forbidden', errcode='P0001';
  end if;
  perform 1 from mcp_internal.mcp_bots where bot_id=p_bot_id and status='active' for share;
  if not found then raise exception using message='bot_not_active', errcode='P0001'; end if;
  perform 1 from mcp_internal.mcp_bot_permissions
    where bot_id=p_bot_id and permission_pattern=p_tool for share;
  if not found then raise exception using message='bot_forbidden', errcode='P0001'; end if;
end $$;
revoke all on function mcp_internal.require_finance_permission(text,uuid,text) from public,anon,authenticated,service_role;

-- Cohort window: start inclusive, end exclusive. Same maths as public.client_economics
-- (migration 79) without can_access_client. Does not read finance_entries, client_billing,
-- contract_payments or campaigns.total_spend.
create function mcp_internal.cohort_economics(p_client_id uuid, p_start date, p_end date)
returns jsonb language plpgsql volatile security definer
set search_path=pg_catalog,mcp_internal,public set timezone='UTC' as $$
declare
  v_spend numeric; v_cur text; v_mixed boolean;
  v_leads integer; v_qual integer; v_appts integer; v_custs integer;
  v_rev numeric; v_cash numeric;
begin
  select coalesce(sum(s.amount), 0),
         case when count(distinct s.currency) = 1 then min(s.currency) end,
         count(distinct s.currency) > 1
    into v_spend, v_cur, v_mixed
  from public.client_marketing_spend s
  where s.client_id = p_client_id and s.spent_on >= p_start and s.spent_on < p_end;

  select count(*)::int,
         count(*) filter (where p.furthest_rank >= 3)::int,
         count(*) filter (where p.furthest_rank >= 4)::int,
         count(*) filter (where p.furthest_rank >= 7)::int,
         coalesce(sum(p.sale_value), 0),
         coalesce(sum(p.cash_collected), 0)
    into v_leads, v_qual, v_appts, v_custs, v_rev, v_cash
  from (
    select l.client_id,
           coalesce(l.sale_value, 0) as sale_value,
           coalesce(l.cash_collected, 0) as cash_collected,
           greatest(
             public.lead_stage_rank(l.stage),
             coalesce((
               select max(public.lead_stage_rank(e.to_stage))
               from public.lead_events e
               where e.lead_id = l.id and e.kind = 'stage_change' and e.to_stage is not null
             ), 0)
           ) as furthest_rank
    from public.client_leads l
    where l.client_id = p_client_id
      and l.created_at >= p_start::timestamptz
      and l.created_at < p_end::timestamptz
  ) p;

  return jsonb_build_object(
    'spend', v_spend,
    'leads', v_leads,
    'qualified_leads', v_qual,
    'appointments', v_appts,
    'customers', v_custs,
    'revenue', v_rev,
    'cash_collected', v_cash,
    'cpl', case when v_mixed then null when v_leads > 0 and v_spend > 0 then round(v_spend / v_leads, 2) end,
    'cpql', case when v_mixed then null when v_qual > 0 and v_spend > 0 then round(v_spend / v_qual, 2) end,
    'cpa', case when v_mixed then null when v_appts > 0 and v_spend > 0 then round(v_spend / v_appts, 2) end,
    'cac', case when v_mixed then null when v_custs > 0 and v_spend > 0 then round(v_spend / v_custs, 2) end,
    'roas', case when v_mixed then null when v_spend > 0 then round(v_rev / v_spend, 2) end,
    'cash_roas', case when v_mixed then null when v_spend > 0 then round(v_cash / v_spend, 2) end,
    'revenue_per_lead', case when v_leads > 0 then round(v_rev / v_leads, 2) end,
    'avg_customer_value', case when v_custs > 0 then round(v_rev / v_custs, 2) end,
    'currency', to_jsonb(v_cur),
    'mixed_currency', v_mixed
  );
end $$;
revoke all on function mcp_internal.cohort_economics(uuid,date,date) from public,anon,authenticated,service_role;

create function mcp_internal.cohort_economics_by_campaign(p_client_id uuid, p_start date, p_end date, p_campaign_id uuid, p_limit integer)
returns jsonb language plpgsql volatile security definer
set search_path=pg_catalog,mcp_internal,public set timezone='UTC' as $$
declare items jsonb;
begin
  select coalesce(jsonb_agg(to_jsonb(x) order by x.spend desc, x.campaign_ref),'[]') into items from (
    select coalesce(s.k, l.k) as campaign_id,
           coalesce(c.campaign_ref, '(unattributed)') as campaign_ref,
           coalesce(s.spend, 0) as spend,
           coalesce(l.leads, 0) as leads,
           coalesce(l.customers, 0) as customers,
           coalesce(l.revenue, 0) as revenue,
           coalesce(l.cash, 0) as cash_collected,
           case when coalesce(l.leads,0) > 0 and coalesce(s.spend,0) > 0
                  then round(s.spend / l.leads, 2) end as cpl,
           case when coalesce(l.customers,0) > 0 and coalesce(s.spend,0) > 0
                  then round(s.spend / l.customers, 2) end as cac,
           case when coalesce(s.spend,0) > 0 then round(coalesce(l.revenue,0) / s.spend, 2) end as roas
    from (
      select sp.campaign_id as k, sum(sp.amount) as spend
      from public.client_marketing_spend sp
      where sp.client_id = p_client_id and sp.spent_on >= p_start and sp.spent_on < p_end
        and (p_campaign_id is null or sp.campaign_id is not distinct from p_campaign_id)
      group by 1
    ) s
    full outer join (
      select lp.source_campaign_id as k,
             count(*)::int as leads,
             count(*) filter (where lp.furthest_rank >= 7)::int as customers,
             sum(lp.sale_value) as revenue,
             sum(lp.cash_collected) as cash
      from (
        select l.source_campaign_id,
               coalesce(l.sale_value, 0) as sale_value,
               coalesce(l.cash_collected, 0) as cash_collected,
               greatest(
                 public.lead_stage_rank(l.stage),
                 coalesce((
                   select max(public.lead_stage_rank(e.to_stage))
                   from public.lead_events e
                   where e.lead_id = l.id and e.kind = 'stage_change' and e.to_stage is not null
                 ), 0)
               ) as furthest_rank
        from public.client_leads l
        where l.client_id = p_client_id
          and l.created_at >= p_start::timestamptz
          and l.created_at < p_end::timestamptz
          and (p_campaign_id is null or l.source_campaign_id is not distinct from p_campaign_id)
      ) lp
      group by 1
    -- Equality matches migration 79. NULL campaign keys stay unattributed
    -- on each side rather than merging; IS NOT DISTINCT FROM is not a
    -- merge/hash join condition in the isolation PGlite fixture.
    ) l on l.k = s.k
    left join public.campaigns c on c.id = coalesce(s.k, l.k)
    order by coalesce(s.spend, 0) desc, coalesce(c.campaign_ref, '(unattributed)')
    limit p_limit
  ) x;
  return items;
end $$;
revoke all on function mcp_internal.cohort_economics_by_campaign(uuid,date,date,uuid,integer) from public,anon,authenticated,service_role;

create function mcp_internal.economics_read(
  p_bot_id text, p_client_id uuid, p_action text,
  p_campaign_id uuid default null,
  p_start_date date default (current_date - 29),
  p_end_date date default (current_date + 1),
  p_limit integer default 25
)
returns jsonb language plpgsql volatile security definer
set search_path=pg_catalog,mcp_internal,public set timezone='UTC' as $$
declare
  v_tool text;
  v_totals jsonb;
  v_campaigns jsonb;
  v_owner uuid;
  v_start date;
  v_end date;
  v_limit integer;
begin
  v_tool := 'economics.' || p_action;
  perform mcp_internal.require_active_bot(p_bot_id);
  perform mcp_internal.require_bot_client_grant(p_bot_id, p_client_id);
  if p_bot_id is distinct from 'bot_finance' then
    raise exception using message='bot_forbidden', errcode='P0001';
  end if;
  perform mcp_internal.require_finance_permission(p_bot_id, p_client_id, v_tool);
  v_start := coalesce(p_start_date, current_date - 29);
  v_end := coalesce(p_end_date, current_date + 1);
  v_limit := coalesce(p_limit, 25);
  if p_action is null or p_action not in (
       'get_client_economics','get_campaign_economics','get_costs','get_revenue','get_roi'
     )
     or v_limit not between 1 and 100
     or v_end <= v_start
     or (v_end - v_start) > 366
     or (p_action <> 'get_campaign_economics' and p_campaign_id is not null)
  then
    raise exception using message='invalid_request', errcode='P0001';
  end if;
  if p_campaign_id is not null then
    select client_id into v_owner from public.campaigns where id=p_campaign_id for share;
    if not found or v_owner is distinct from p_client_id then
      raise exception using message='campaign_not_found', errcode='P0001';
    end if;
  end if;
  if p_action = 'get_campaign_economics' then
    v_campaigns := mcp_internal.cohort_economics_by_campaign(p_client_id, v_start, v_end, p_campaign_id, v_limit);
    return jsonb_build_object(
      'client_id', p_client_id,
      'projection', 'acquisition_cohort_economics_v1',
      'start_date', v_start,
      'end_date', v_end,
      'exclusive_end', true,
      'campaigns', v_campaigns
    );
  end if;
  v_totals := mcp_internal.cohort_economics(p_client_id, v_start, v_end);
  return jsonb_build_object(
    'client_id', p_client_id,
    'projection', 'acquisition_cohort_economics_v1',
    'start_date', v_start,
    'end_date', v_end,
    'exclusive_end', true,
    'economics', case p_action
      when 'get_costs' then jsonb_build_object(
        'spend', v_totals->'spend',
        'leads', v_totals->'leads',
        'qualified_leads', v_totals->'qualified_leads',
        'appointments', v_totals->'appointments',
        'customers', v_totals->'customers',
        'cpl', v_totals->'cpl',
        'cpql', v_totals->'cpql',
        'cpa', v_totals->'cpa',
        'cac', v_totals->'cac',
        'currency', v_totals->'currency',
        'mixed_currency', v_totals->'mixed_currency'
      )
      when 'get_revenue' then jsonb_build_object(
        'revenue', v_totals->'revenue',
        'cash_collected', v_totals->'cash_collected',
        'leads', v_totals->'leads',
        'customers', v_totals->'customers',
        'revenue_per_lead', v_totals->'revenue_per_lead',
        'avg_customer_value', v_totals->'avg_customer_value',
        'currency', v_totals->'currency',
        'mixed_currency', v_totals->'mixed_currency'
      )
      when 'get_roi' then jsonb_build_object(
        'spend', v_totals->'spend',
        'revenue', v_totals->'revenue',
        'cash_collected', v_totals->'cash_collected',
        'roas', v_totals->'roas',
        'cash_roas', v_totals->'cash_roas',
        'currency', v_totals->'currency',
        'mixed_currency', v_totals->'mixed_currency'
      )
      else v_totals
    end
  );
end $$;
revoke all on function mcp_internal.economics_read(text,uuid,text,uuid,date,date,integer) from public,anon,authenticated,service_role;

create function mcp_internal.attribution_revenue(
  p_bot_id text, p_client_id uuid,
  p_campaign_id uuid default null,
  p_start_date date default (current_date - 29),
  p_end_date date default (current_date + 1),
  p_limit integer default 25
)
returns jsonb language plpgsql volatile security definer
set search_path=pg_catalog,mcp_internal,public set timezone='UTC' as $$
declare
  v_start date;
  v_end date;
  v_limit integer;
  v_owner uuid;
  v_campaigns jsonb;
begin
  perform mcp_internal.require_active_bot(p_bot_id);
  perform mcp_internal.require_bot_client_grant(p_bot_id, p_client_id);
  if not mcp_internal.bot_has_permission(p_bot_id, 'attribution.get_revenue_attribution') then
    raise exception using message='bot_forbidden', errcode='P0001';
  end if;
  perform 1 from mcp_internal.mcp_bots where bot_id=p_bot_id and status='active' for share;
  if not found then raise exception using message='bot_not_active', errcode='P0001'; end if;
  v_start := coalesce(p_start_date, current_date - 29);
  v_end := coalesce(p_end_date, current_date + 1);
  v_limit := coalesce(p_limit, 25);
  if v_limit not between 1 and 100 or v_end <= v_start or (v_end - v_start) > 366 then
    raise exception using message='invalid_request', errcode='P0001';
  end if;
  if p_campaign_id is not null then
    select client_id into v_owner from public.campaigns where id=p_campaign_id for share;
    if not found or v_owner is distinct from p_client_id then
      raise exception using message='campaign_not_found', errcode='P0001';
    end if;
  end if;
  v_campaigns := mcp_internal.cohort_economics_by_campaign(p_client_id, v_start, v_end, p_campaign_id, v_limit);
  return jsonb_build_object(
    'client_id', p_client_id,
    'projection', 'acquisition_cohort_revenue_attribution_v1',
    'start_date', v_start,
    'end_date', v_end,
    'exclusive_end', true,
    'campaigns', v_campaigns
  );
end $$;
revoke all on function mcp_internal.attribution_revenue(text,uuid,uuid,date,date,integer) from public,anon,authenticated,service_role;

create function public.mcp_economics_read(
  p_bot_id text, p_client_id uuid, p_action text,
  p_campaign_id uuid default null,
  p_start_date date default (current_date - 29),
  p_end_date date default (current_date + 1),
  p_limit integer default 25
) returns jsonb language plpgsql volatile security definer
set search_path=pg_catalog,mcp_internal,public set timezone='UTC' as $$
begin
  perform mcp_internal.require_service_role();
  perform mcp_internal.require_active_bot(p_bot_id);
  perform mcp_internal.require_bot_client_grant(p_bot_id, p_client_id);
  return mcp_internal.economics_read(p_bot_id, p_client_id, p_action, p_campaign_id, p_start_date, p_end_date, p_limit);
end $$;
revoke all on function public.mcp_economics_read(text,uuid,text,uuid,date,date,integer) from public,anon,authenticated;
grant execute on function public.mcp_economics_read(text,uuid,text,uuid,date,date,integer) to service_role;

create function public.mcp_attribution_revenue(
  p_bot_id text, p_client_id uuid,
  p_campaign_id uuid default null,
  p_start_date date default (current_date - 29),
  p_end_date date default (current_date + 1),
  p_limit integer default 25
) returns jsonb language plpgsql volatile security definer
set search_path=pg_catalog,mcp_internal,public set timezone='UTC' as $$
begin
  perform mcp_internal.require_service_role();
  perform mcp_internal.require_active_bot(p_bot_id);
  perform mcp_internal.require_bot_client_grant(p_bot_id, p_client_id);
  return mcp_internal.attribution_revenue(p_bot_id, p_client_id, p_campaign_id, p_start_date, p_end_date, p_limit);
end $$;
revoke all on function public.mcp_attribution_revenue(text,uuid,uuid,date,date,integer) from public,anon,authenticated;
grant execute on function public.mcp_attribution_revenue(text,uuid,uuid,date,date,integer) to service_role;

-- Keep every existing CoS prohibition; add Gate 13 exact-allowlist / no-money-write guards.
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
        or mcp_internal.permission_matches(p.permission_pattern, 'economics.get_costs')
        or mcp_internal.permission_matches(p.permission_pattern, 'security.get_system_status')
        or mcp_internal.permission_matches(p.permission_pattern, 'sales_agents.deploy')
      )
  ) then
    raise exception 'CoS: bot_production must not have finance, security, or deploy grants';
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
end;
$$;
revoke all on function mcp_internal.assert_cos_prohibitions() from public, anon, authenticated;
grant execute on function mcp_internal.assert_cos_prohibitions() to service_role;

delete from mcp_internal.mcp_bot_permissions where bot_id='bot_finance';
insert into mcp_internal.mcp_bot_permissions(bot_id,permission_pattern,granted_by) values
('bot_finance','economics.get_client_economics','phase-13-locked'),
('bot_finance','economics.get_campaign_economics','phase-13-locked'),
('bot_finance','economics.get_costs','phase-13-locked'),
('bot_finance','economics.get_revenue','phase-13-locked'),
('bot_finance','economics.get_roi','phase-13-locked'),
('bot_finance','attribution.get_revenue_attribution','phase-13-locked'),
('bot_finance','workflow.create_task','phase-13-locked'),
('bot_finance','workflow.assign_task','phase-13-locked'),
('bot_finance','workflow.get_task','phase-13-locked'),
('bot_finance','workflow.list_tasks','phase-13-locked'),
('bot_finance','workflow.complete_task','phase-13-locked'),
('bot_finance','workflow.create_approval','phase-13-locked'),
('bot_finance','workflow.get_pending_approvals','phase-13-locked'),
('bot_finance','workflow.get_activity','phase-13-locked');

do $$
declare n integer;
begin
  perform mcp_internal.assert_cos_prohibitions();
  select count(*)::int into n from mcp_internal.mcp_bot_permissions where bot_id='bot_finance';
  if n <> 14 then
    raise exception 'Phase 13: bot_finance must have exactly 14 permission rows, found %', n;
  end if;
  if exists (select 1 from mcp_internal.mcp_bot_permissions where bot_id='bot_finance' and permission_pattern='economics.*') then
    raise exception 'Phase 13: economics.* wildcard remains on bot_finance';
  end if;
  if not exists (select 1 from mcp_internal.mcp_bot_permissions where bot_id='bot_finance' and permission_pattern='economics.get_client_economics') then
    raise exception 'Phase 13: economics.get_client_economics missing after replace';
  end if;
  if not exists (select 1 from mcp_internal.mcp_bot_permissions where bot_id='bot_finance' and permission_pattern='attribution.get_revenue_attribution') then
    raise exception 'Phase 13: attribution.get_revenue_attribution missing after replace';
  end if;
end $$;

commit;

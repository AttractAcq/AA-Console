-- Use the same tenant-guarded historical cohort source as public Economics.
-- The archive guard remains until every revenue and action consumer agrees.
begin;
create or replace function mcp_internal.cohort_economics(p_client_id uuid, p_start date, p_end date)
returns jsonb language plpgsql volatile security definer
set search_path=pg_catalog,mcp_internal,public set timezone='UTC' as $$
declare
  v_spend numeric; v_cur text; v_mixed boolean;
  v_leads integer; v_qual integer; v_appts integer; v_custs integer;
  v_rev numeric; v_cash numeric;
  v_sale_missing integer; v_sale_currencies integer; v_sale_currency text;
  v_cash_missing integer; v_cash_currencies integer; v_cash_currency text;
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
         count(*) filter (where p.sale_evidence)::int,
         coalesce(sum(p.sale_value), 0),
         coalesce(sum(p.cash_collected), 0),
         count(*) filter (where p.sale_value>0 and p.sale_currency is null)::int,
         count(distinct p.sale_currency) filter (where p.sale_value>0)::int,
         min(p.sale_currency) filter (where p.sale_value>0),
         count(*) filter (where p.cash_collected>0 and p.cash_currency is null)::int,
         count(distinct p.cash_currency) filter (where p.cash_collected>0)::int,
         min(p.cash_currency) filter (where p.cash_collected>0)
    into v_leads, v_qual, v_appts, v_custs, v_rev, v_cash,
         v_sale_missing,v_sale_currencies,v_sale_currency,
         v_cash_missing,v_cash_currencies,v_cash_currency
  from public.reporting_lead_progress_v10(p_client_id) p
  where p.created_at >= p_start::timestamptz
    and p.created_at < p_end::timestamptz;

  return jsonb_build_object(
    'spend', case when v_mixed then null else v_spend end,
    'leads', v_leads,
    'qualified_leads', v_qual,
    'appointments', v_appts,
    'customers', v_custs,
    'revenue', case when v_rev=0 then 0 when v_sale_missing=0 and v_sale_currencies=1 then v_rev end,
    'cash_collected', case when v_cash=0 then 0 when v_cash_missing=0 and v_cash_currencies=1 then v_cash end,
    'cpl', case when v_mixed then null when v_leads > 0 and v_spend > 0 then round(v_spend / v_leads, 2) end,
    'cpql', case when v_mixed then null when v_qual > 0 and v_spend > 0 then round(v_spend / v_qual, 2) end,
    'cpa', case when v_mixed then null when v_appts > 0 and v_spend > 0 then round(v_spend / v_appts, 2) end,
    'cac', case when v_mixed then null when v_custs > 0 and v_spend > 0 then round(v_spend / v_custs, 2) end,
    'roas', case when not v_mixed and v_spend>0 and v_rev>0
                       and v_sale_missing=0 and v_sale_currencies=1 and v_sale_currency=v_cur
                  then round(v_rev / v_spend, 2) end,
    'cash_roas', case when not v_mixed and v_spend>0 and v_cash>0
                            and v_cash_missing=0 and v_cash_currencies=1 and v_cash_currency=v_cur
                       then round(v_cash / v_spend, 2) end,
    'revenue_per_lead', case when v_leads>0 and v_rev>0 and v_sale_missing=0 and v_sale_currencies=1
                               then round(v_rev / v_leads, 2) end,
    'avg_customer_value', case when v_custs>0 and v_rev>0 and v_sale_missing=0 and v_sale_currencies=1
                                 then round(v_rev / v_custs, 2) end,
    'sale_currency', case when v_sale_missing=0 and v_sale_currencies=1 then v_sale_currency end,
    'cash_currency', case when v_cash_missing=0 and v_cash_currencies=1 then v_cash_currency end,
    'unverified_sale_leads', v_sale_missing,
    'unverified_cash_leads', v_cash_missing,
    'currency', to_jsonb(v_cur),
    'mixed_currency', v_mixed
  );
end $$;
revoke all on function mcp_internal.cohort_economics(uuid,date,date) from public,anon,authenticated,service_role;

create or replace function mcp_internal.cohort_economics_by_campaign(p_client_id uuid, p_start date, p_end date, p_campaign_id uuid, p_limit integer)
returns jsonb language plpgsql volatile security definer
set search_path=pg_catalog,mcp_internal,public set timezone='UTC' as $$
declare items jsonb;
begin
  select coalesce(jsonb_agg(to_jsonb(x) order by x.spend desc, x.campaign_ref),'[]') into items from (
    select coalesce(s.k, l.k) as campaign_id,
           coalesce(c.campaign_ref, '(unattributed)') as campaign_ref,
           case when s.currency_count>1 then null else coalesce(s.spend, 0) end as spend,
           coalesce(l.leads, 0) as leads,
           coalesce(l.customers, 0) as customers,
           case when coalesce(l.revenue,0)=0 then 0
                when l.sale_missing=0 and l.sale_currency_count=1 then l.revenue end as revenue,
           case when coalesce(l.cash,0)=0 then 0
                when l.cash_missing=0 and l.cash_currency_count=1 then l.cash end as cash_collected,
           case when l.sale_missing=0 and l.sale_currency_count=1 then l.sale_currency end as sale_currency,
           case when l.cash_missing=0 and l.cash_currency_count=1 then l.cash_currency end as cash_currency,
           coalesce(l.sale_missing,0) as unverified_sale_leads,
           coalesce(l.cash_missing,0) as unverified_cash_leads,
           case when s.currency_count=1 and coalesce(l.leads,0) > 0 and coalesce(s.spend,0) > 0
                  then round(s.spend / l.leads, 2) end as cpl,
           case when s.currency_count=1 and coalesce(l.customers,0) > 0 and coalesce(s.spend,0) > 0
                  then round(s.spend / l.customers, 2) end as cac,
           case when s.currency_count=1 and coalesce(s.spend,0)>0
                     and coalesce(l.revenue,0)>0 and l.sale_missing=0
                     and l.sale_currency_count=1 and l.sale_currency=s.currency
                  then round(l.revenue / s.spend, 2) end as roas
    from (
      select sp.campaign_id as k, sum(sp.amount) as spend,
             count(distinct sp.currency) as currency_count,
             min(sp.currency) as currency
      from public.client_marketing_spend sp
      where sp.client_id = p_client_id and sp.spent_on >= p_start and sp.spent_on < p_end
        and (p_campaign_id is null or sp.campaign_id is not distinct from p_campaign_id)
      group by 1
    ) s
    full outer join (
      select lp.source_campaign_id as k,
             count(*)::int as leads,
             count(*) filter (where lp.sale_evidence)::int as customers,
             sum(lp.sale_value) as revenue,
             sum(lp.cash_collected) as cash,
             count(*) filter (where lp.sale_value>0 and lp.sale_currency is null) as sale_missing,
             count(distinct lp.sale_currency) filter (where lp.sale_value>0) as sale_currency_count,
             min(lp.sale_currency) filter (where lp.sale_value>0) as sale_currency,
             count(*) filter (where lp.cash_collected>0 and lp.cash_currency is null) as cash_missing,
             count(distinct lp.cash_currency) filter (where lp.cash_collected>0) as cash_currency_count,
             min(lp.cash_currency) filter (where lp.cash_collected>0) as cash_currency
      from public.reporting_lead_progress_v10(p_client_id) lp
      where lp.created_at >= p_start::timestamptz
        and lp.created_at < p_end::timestamptz
        and (p_campaign_id is null or lp.source_campaign_id is not distinct from p_campaign_id)
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
select public.lock_down_definer_functions();
commit;

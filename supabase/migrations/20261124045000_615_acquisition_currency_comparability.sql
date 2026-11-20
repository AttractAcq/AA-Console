-- Preserve the sale/probe/tenant contract from migration 599 while refusing
-- monetary totals and return ratios across missing or mixed lead currencies.
-- The existing function signatures remain unchanged for client callers.
create or replace function acquisition_funnel(p_client_id uuid, p_days integer default 30)
returns table (
  leads integer,
  conversations integer,
  appointments integer,
  sales integer,
  lost integer,
  pipeline_value numeric,
  sale_value numeric,
  cash_collected numeric,
  spend numeric,
  lead_to_sale_pct numeric,
  cost_per_lead numeric,
  return_on_spend numeric,
  profile_visits integer, followers integer, qualified integer
)
language sql
stable
security definer
set search_path = public
as $$
  with window_leads as (
    select * from client_leads l
    where l.client_id = p_client_id
      and not coalesce(l.is_probe,false)
      and l.created_at >= now() - make_interval(days => greatest(1, least(coalesce(p_days, 30), 3650)))
  ),
  spend as (
    -- Canonical ledger, not metrics_daily. Same window as the leads above.
    select coalesce(sum(s.amount), 0)::numeric as total,
           count(distinct s.currency)::int as currency_count,
           min(s.currency) as currency
    from client_marketing_spend s
    where s.client_id = p_client_id
      and s.spent_on >= (current_date - greatest(1, least(coalesce(p_days, 30), 3650)))
  ),
  counted as (
    select count(*)::int as leads,
           count(*) filter (where stage in ('conversation','qualified_conversation','appointment','qualified_appointment','shown','sale','cash'))::int as conversations,
           count(*) filter (where stage in ('appointment','qualified_appointment','shown','sale','cash'))::int as appointments,
           count(*) filter (where wl.stage in ('sale','cash') or coalesce(wl.sale_value,0)>0 or coalesce(wl.cash_collected,0)>0 or exists (select 1 from public.lead_events sale_event where sale_event.lead_id=wl.id and sale_event.client_id=wl.client_id and sale_event.kind='stage_change' and sale_event.to_stage in ('sale','cash')))::int as sales,
           count(*) filter (where stage = 'lost')::int as lost,
           coalesce(sum(opportunity_value), 0)::numeric as pipeline_value,
           coalesce(sum(sale_value), 0)::numeric as sale_value,
           coalesce(sum(cash_collected), 0)::numeric as cash_collected,
           count(*) filter (where coalesce(sale_value,0)>0 and sale_currency is null)::int as sale_unverified,
           count(distinct sale_currency) filter (where coalesce(sale_value,0)>0)::int as sale_currencies,
           min(sale_currency) filter (where coalesce(sale_value,0)>0) as sale_currency,
           count(*) filter (where coalesce(cash_collected,0)>0 and cash_currency is null)::int as cash_unverified,
           count(distinct cash_currency) filter (where coalesce(cash_collected,0)>0)::int as cash_currencies,
           min(cash_currency) filter (where coalesce(cash_collected,0)>0) as cash_currency,
           count(*) filter (where lead_stage_rank(stage) >= 1)::int as profile_visits,
           count(*) filter (where lead_stage_rank(stage) >= 2)::int as followers,
           count(*) filter (where lead_stage_rank(stage) >= 3)::int as qualified
    from window_leads wl
  )
  select c.leads, c.conversations, c.appointments, c.sales, c.lost,
         c.pipeline_value,
         case when c.sale_value=0 then 0
              when c.sale_unverified=0 and c.sale_currencies=1 then c.sale_value end,
         case when c.cash_collected=0 then 0
              when c.cash_unverified=0 and c.cash_currencies=1 then c.cash_collected end,
         s.total,
         case when c.leads > 0 then round(100.0 * c.sales / c.leads, 1) end,
         case when c.leads > 0 and s.total > 0 and s.currency_count=1
              then round(s.total / c.leads, 2) end,
         case when s.total>0 and s.currency_count=1 and c.cash_collected>0
                   and c.cash_unverified=0 and c.cash_currencies=1
                   and c.cash_currency=s.currency
              then round(c.cash_collected / s.total, 2) end,
         c.profile_visits, c.followers, c.qualified
  from counted c cross join spend s
  where may_manage_client_leads(p_client_id);
$$;

revoke execute on function acquisition_funnel(uuid, integer) from public, anon;
grant execute on function acquisition_funnel(uuid, integer) to authenticated, service_role;


create or replace function mcp_internal.attribution_conversion_funnel(
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
  v_spend_currencies integer;
  v_spend_currency text;
  v_sale_unverified integer;
  v_sale_currencies integer;
  v_sale_currency text;
  v_cash_unverified integer;
  v_cash_currencies integer;
  v_cash_currency text;
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
         count(*) filter (where l.stage in ('sale','cash') or coalesce(l.sale_value,0)>0 or coalesce(l.cash_collected,0)>0 or exists (select 1 from public.lead_events sale_event where sale_event.lead_id=l.id and sale_event.client_id=l.client_id and sale_event.kind='stage_change' and sale_event.to_stage in ('sale','cash')))::int,
         count(*) filter (where stage = 'lost')::int,
         coalesce(sum(opportunity_value), 0),
         coalesce(sum(sale_value), 0),
         coalesce(sum(cash_collected), 0),
         count(*) filter (where coalesce(sale_value,0)>0 and sale_currency is null)::int,
         count(distinct sale_currency) filter (where coalesce(sale_value,0)>0)::int,
         min(sale_currency) filter (where coalesce(sale_value,0)>0),
         count(*) filter (where coalesce(cash_collected,0)>0 and cash_currency is null)::int,
         count(distinct cash_currency) filter (where coalesce(cash_collected,0)>0)::int,
         min(cash_currency) filter (where coalesce(cash_collected,0)>0)
    into v_leads, v_conversations, v_appointments, v_sales, v_lost, v_pipeline, v_sale, v_cash,
         v_sale_unverified, v_sale_currencies, v_sale_currency,
         v_cash_unverified, v_cash_currencies, v_cash_currency
  from public.client_leads l
  where l.client_id = p_client_id
    and not coalesce(l.is_probe,false)
    and l.created_at >= now() - make_interval(days => v_days);

  select coalesce(sum(s.amount), 0), count(distinct s.currency)::int, min(s.currency)
    into v_spend, v_spend_currencies, v_spend_currency
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
      'sale_value', case when v_sale=0 then 0
                         when v_sale_unverified=0 and v_sale_currencies=1 then v_sale end,
      'sale_currency', case when v_sale_unverified=0 and v_sale_currencies=1 then v_sale_currency end,
      'sale_currency_unverified_leads', v_sale_unverified,
      'cash_collected', case when v_cash=0 then 0
                            when v_cash_unverified=0 and v_cash_currencies=1 then v_cash end,
      'cash_currency', case when v_cash_unverified=0 and v_cash_currencies=1 then v_cash_currency end,
      'cash_currency_unverified_leads', v_cash_unverified,
      'spend', v_spend,
      'spend_currency', case when v_spend_currencies=1 then v_spend_currency end,
      'lead_to_sale_pct', case when v_leads > 0 then round(100.0 * v_sales / v_leads, 1) end,
      'cost_per_lead', case when v_leads>0 and v_spend>0 and v_spend_currencies=1
                                 then round(v_spend / v_leads, 2) end,
      'return_on_spend', case when v_spend>0 and v_spend_currencies=1 and v_cash>0
                                  and v_cash_unverified=0 and v_cash_currencies=1
                                  and v_cash_currency=v_spend_currency
                                then round(v_cash / v_spend, 2) end
    )
  );
end $$;
revoke all on function mcp_internal.attribution_conversion_funnel(text,uuid,integer) from public,anon,authenticated,service_role;


-- Keep MCP conversion and cash totals aligned with the Console when a
-- finished lead moves from the operating pipeline into Archive.
begin;
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
  v_opportunity_unverified integer;
  v_opportunity_currencies integer;
  v_opportunity_currency text;
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
         count(*) filter (where l.stage in ('conversation','qualified_conversation','appointment','qualified_appointment','shown','sale','cash'))::int,
         count(*) filter (where l.stage in ('appointment','qualified_appointment','shown','sale','cash'))::int,
         count(*) filter (where p.sale_evidence)::int,
         count(*) filter (where l.stage = 'lost')::int,
         coalesce(sum(l.opportunity_value), 0),
         count(*) filter (where coalesce(l.opportunity_value,0)>0 and l.opportunity_currency is null)::int,
         count(distinct l.opportunity_currency) filter (where coalesce(l.opportunity_value,0)>0)::int,
         min(l.opportunity_currency) filter (where coalesce(l.opportunity_value,0)>0),
         coalesce(sum(l.sale_value), 0),
         coalesce(sum(l.cash_collected), 0),
         count(*) filter (where coalesce(l.sale_value,0)>0 and l.sale_currency is null)::int,
         count(distinct l.sale_currency) filter (where coalesce(l.sale_value,0)>0)::int,
         min(l.sale_currency) filter (where coalesce(l.sale_value,0)>0),
         count(*) filter (where coalesce(l.cash_collected,0)>0 and l.cash_currency is null)::int,
         count(distinct l.cash_currency) filter (where coalesce(l.cash_collected,0)>0)::int,
         min(l.cash_currency) filter (where coalesce(l.cash_collected,0)>0)
    into v_leads, v_conversations, v_appointments, v_sales, v_lost, v_pipeline,
         v_opportunity_unverified,v_opportunity_currencies,v_opportunity_currency,v_sale,v_cash,
         v_sale_unverified, v_sale_currencies, v_sale_currency,
         v_cash_unverified, v_cash_currencies, v_cash_currency
  from public.reporting_lead_rows_v10(p_client_id) l
  join public.reporting_lead_progress_v10(p_client_id) p
    on p.lead_id=l.id and p.client_id=l.client_id
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
      'pipeline_value', case when v_pipeline=0 then 0
                             when v_opportunity_unverified=0 and v_opportunity_currencies=1
                             then v_pipeline end,
      'opportunity_currency', case when v_opportunity_unverified=0 and v_opportunity_currencies=1
                                    then v_opportunity_currency end,
      'opportunity_currency_unverified_leads', v_opportunity_unverified,
      'sale_value', case when v_sale=0 then 0
                         when v_sale_unverified=0 and v_sale_currencies=1 then v_sale end,
      'sale_currency', case when v_sale_unverified=0 and v_sale_currencies=1 then v_sale_currency end,
      'sale_currency_unverified_leads', v_sale_unverified,
      'cash_collected', case when v_cash=0 then 0
                            when v_cash_unverified=0 and v_cash_currencies=1 then v_cash end,
      'cash_currency', case when v_cash_unverified=0 and v_cash_currencies=1 then v_cash_currency end,
      'cash_currency_unverified_leads', v_cash_unverified,
      'spend', case when v_spend_currencies>1 then null else v_spend end,
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
select public.lock_down_definer_functions();
commit;

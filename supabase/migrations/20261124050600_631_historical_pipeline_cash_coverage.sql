-- Keep pipeline stages and its existing cash total active-only, while
-- exposing a separately labelled historical cash total that survives Archive.
begin;
create or replace function mcp_internal.get_pipeline_summary(
  p_bot_id text, p_client_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = mcp_internal, public
as $$
declare
  v_by_stage jsonb;
  v_totals record;
  v_history record;
  v_stalled integer;
begin
  perform mcp_internal.require_active_bot(p_bot_id);
  perform mcp_internal.require_bot_client_grant(p_bot_id, p_client_id);
  select coalesce(jsonb_agg(jsonb_build_object(
      'stage', x.stage, 'count', x.n,
      'opportunity_value', case when x.value=0 then 0
                                 when x.unverified=0 and x.currency_count=1 then x.value end,
      'opportunity_currency', case when x.unverified=0 and x.currency_count=1 then x.currency end,
      'opportunity_currency_unverified_leads', x.unverified
    ) order by x.stage), '[]'::jsonb)
    into v_by_stage
    from (
      select l.stage::text as stage, count(*) as n,
             coalesce(sum(l.opportunity_value), 0) as value,
             count(*) filter (where coalesce(l.opportunity_value,0)>0 and l.opportunity_currency is null) as unverified,
             count(distinct l.opportunity_currency) filter (where coalesce(l.opportunity_value,0)>0) as currency_count,
             min(l.opportunity_currency) filter (where coalesce(l.opportunity_value,0)>0) as currency
        from client_leads l
       where l.client_id = p_client_id and not coalesce(l.is_probe,false)
       group by l.stage
    ) x;
  select count(*) as total_leads,
         coalesce(sum(opportunity_value), 0) as total_opportunity_value,
         count(*) filter (where coalesce(opportunity_value,0)>0 and opportunity_currency is null) as opportunity_unverified,
         count(distinct opportunity_currency) filter (where coalesce(opportunity_value,0)>0) as opportunity_currency_count,
         min(opportunity_currency) filter (where coalesce(opportunity_value,0)>0) as opportunity_currency,
         coalesce(sum(cash_collected), 0) as total_cash_collected,
         count(*) filter (where coalesce(cash_collected,0)>0 and cash_currency is null) as cash_unverified,
         count(distinct cash_currency) filter (where coalesce(cash_collected,0)>0) as cash_currency_count,
         min(cash_currency) filter (where coalesce(cash_collected,0)>0) as cash_currency
    into v_totals
    from client_leads
   where client_id = p_client_id and not coalesce(is_probe,false);
  -- The operating pipeline remains active-only. Historical collected cash
  -- includes archived snapshots without changing the existing pipeline keys.
  select coalesce(sum(l.cash_collected),0) as cash_collected,
         count(*) filter (where coalesce(l.cash_collected,0)>0
           and l.cash_currency is null) as cash_unverified,
         count(distinct l.cash_currency)
           filter (where coalesce(l.cash_collected,0)>0) as cash_currency_count,
         min(l.cash_currency)
           filter (where coalesce(l.cash_collected,0)>0) as cash_currency
    into v_history
    from public.reporting_lead_rows_v10(p_client_id) l
   where not coalesce(l.is_probe,false);
  select count(*) into v_stalled
    from public.stalled_leads(p_client_id, 7);
  return jsonb_build_object(
    'client_id', p_client_id,
    'by_stage', v_by_stage,
    'total_leads', v_totals.total_leads,
    'total_opportunity_value', case when v_totals.total_opportunity_value=0 then 0
                                    when v_totals.opportunity_unverified=0 and v_totals.opportunity_currency_count=1
                                    then v_totals.total_opportunity_value end,
    'opportunity_currency', case when v_totals.opportunity_unverified=0 and v_totals.opportunity_currency_count=1
                                   then v_totals.opportunity_currency end,
    'opportunity_currency_unverified_leads', v_totals.opportunity_unverified,
    'total_cash_collected', case when v_totals.total_cash_collected=0 then 0
                                 when v_totals.cash_unverified=0 and v_totals.cash_currency_count=1
                                 then v_totals.total_cash_collected end,
    'cash_currency', case when v_totals.cash_unverified=0 and v_totals.cash_currency_count=1
                            then v_totals.cash_currency end,
    'cash_currency_unverified_leads', v_totals.cash_unverified,
    'cash_scope', 'active_pipeline',
    'historical_cash_collected', case when v_history.cash_collected=0 then 0
      when v_history.cash_unverified=0 and v_history.cash_currency_count=1
      then v_history.cash_collected end,
    'historical_cash_currency', case when v_history.cash_unverified=0
      and v_history.cash_currency_count=1 then v_history.cash_currency end,
    'historical_cash_currency_unverified_leads', v_history.cash_unverified,
    'historical_cash_scope', 'all_recorded_leads',
    'stalled_count', v_stalled
  );
end;
$$;
select public.lock_down_definer_functions();
commit;

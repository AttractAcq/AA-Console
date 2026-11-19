-- Count archived lead snapshots in the existing client funnel and money
-- breakdown. The cash-positive archive guard remains until every report and
-- operational consumer has been migrated and tested.
begin;
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
    select * from public.reporting_lead_rows_v10(p_client_id) l
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
           count(*) filter (where wl.stage in ('sale','cash') or coalesce(wl.sale_value,0)>0 or coalesce(wl.cash_collected,0)>0 or exists (select 1 from public.lead_events sale_event where sale_event.lead_id=wl.id and sale_event.client_id=wl.client_id and sale_event.kind='stage_change' and sale_event.to_stage in ('sale','cash')) or exists (select 1 from public.archived_leads archived_event where archived_event.id=wl.id and archived_event.client_id=wl.client_id and (archived_event.events @> '[{"kind":"stage_change","to_stage":"sale"}]'::jsonb or archived_event.events @> '[{"kind":"stage_change","to_stage":"cash"}]'::jsonb)))::int as sales,
           count(*) filter (where stage = 'lost')::int as lost,
           coalesce(sum(opportunity_value), 0)::numeric as pipeline_value,
           count(*) filter (where coalesce(opportunity_value,0)>0 and opportunity_currency is null)::int as opportunity_unverified,
           count(distinct opportunity_currency) filter (where coalesce(opportunity_value,0)>0)::int as opportunity_currencies,
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
         case when c.pipeline_value=0 then 0
              when c.opportunity_unverified=0 and c.opportunity_currencies=1
              then c.pipeline_value end,
         case when c.sale_value=0 then 0
              when c.sale_unverified=0 and c.sale_currencies=1 then c.sale_value end,
         case when c.cash_collected=0 then 0
              when c.cash_unverified=0 and c.cash_currencies=1 then c.cash_collected end,
         case when s.currency_count>1 then null else s.total end,
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

create or replace function public.client_money_currency_breakdown(
  p_client_id uuid, p_since date, p_until date
)
returns table (
  kind text,
  currency text,
  record_count integer,
  amount numeric
)
language plpgsql stable security definer set search_path = 'public' as $$
begin
  if not public.may_manage_client_leads(p_client_id) then
    raise exception 'Not permitted for this client';
  end if;
  if p_since is null or p_until is null or p_until <= p_since then
    raise exception 'The end of the window must come after its start.';
  end if;
  return query
  with money as (
    select 'opportunity'::text as money_kind, l.opportunity_currency as money_currency,
           l.opportunity_value as money_amount
    from public.reporting_lead_rows_v10(p_client_id) l
    where l.client_id=p_client_id and not coalesce(l.is_probe,false)
      and l.created_at>=p_since::timestamptz and l.created_at<p_until::timestamptz
      and l.opportunity_value>0
    union all
    select 'sale', l.sale_currency, l.sale_value
    from public.reporting_lead_rows_v10(p_client_id) l
    where l.client_id=p_client_id and not coalesce(l.is_probe,false)
      and l.created_at>=p_since::timestamptz and l.created_at<p_until::timestamptz
      and l.sale_value>0
    union all
    select 'cash', l.cash_currency, l.cash_collected
    from public.reporting_lead_rows_v10(p_client_id) l
    where l.client_id=p_client_id and not coalesce(l.is_probe,false)
      and l.created_at>=p_since::timestamptz and l.created_at<p_until::timestamptz
      and l.cash_collected>0
    union all
    select 'spend', s.currency, s.amount
    from public.client_marketing_spend s
    where s.client_id=p_client_id and s.spent_on>=p_since and s.spent_on<p_until
      and s.amount>0
  )
  select m.money_kind,m.money_currency,count(*)::integer,sum(m.money_amount)::numeric
  from money m
  group by m.money_kind,m.money_currency
  order by m.money_kind,m.money_currency nulls last;
end;
$$;
revoke execute on function public.client_money_currency_breakdown(uuid,date,date) from public,anon;
grant execute on function public.client_money_currency_breakdown(uuid,date,date) to authenticated,service_role;
select public.lock_down_definer_functions();
commit;

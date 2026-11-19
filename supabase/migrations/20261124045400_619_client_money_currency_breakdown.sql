-- Explain incomplete Economics money without converting or merging currencies.
-- The cohort uses live non-probe leads acquired in [since, until); spend uses
-- ledger dates in the same half-open window. Archived leads need a separate
-- historical-cohort contract before they can be included in every Economics read.
create function public.client_money_currency_breakdown(
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
    from public.client_leads l
    where l.client_id=p_client_id and not coalesce(l.is_probe,false)
      and l.created_at>=p_since::timestamptz and l.created_at<p_until::timestamptz
      and l.opportunity_value>0
    union all
    select 'sale', l.sale_currency, l.sale_value
    from public.client_leads l
    where l.client_id=p_client_id and not coalesce(l.is_probe,false)
      and l.created_at>=p_since::timestamptz and l.created_at<p_until::timestamptz
      and l.sale_value>0
    union all
    select 'cash', l.cash_currency, l.cash_collected
    from public.client_leads l
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

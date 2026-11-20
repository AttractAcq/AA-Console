-- Do not let service or direct table writes bypass the Sales OS currency pair.
-- Existing currency-free money is retained. An unrelated edit of that row is
-- allowed, but changing its amount requires an explicit current currency.
create function public.guard_lead_money_currency_v8()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  sale_changed boolean;
  cash_changed boolean;
  archived_match boolean := false;
begin
  if tg_op = 'INSERT' then
    sale_changed := true;
    cash_changed := true;
    -- recover_lead restores archived bytes, including historically unknown
    -- currencies. Authorize that narrow case only while its archive snapshot
    -- is present and its financial values match the snapshot exactly.
    select exists (
      select 1 from public.archived_leads a
      where a.id=new.id and a.client_id=new.client_id
        and (a.lead->>'sale_value')::numeric is not distinct from new.sale_value
        and (a.lead->>'cash_collected')::numeric is not distinct from new.cash_collected
        and a.lead->>'sale_currency' is not distinct from new.sale_currency
        and a.lead->>'cash_currency' is not distinct from new.cash_currency
    ) into archived_match;
  else
    sale_changed := new.sale_value is distinct from old.sale_value
      or new.sale_currency is distinct from old.sale_currency;
    cash_changed := new.cash_collected is distinct from old.cash_collected
      or new.cash_currency is distinct from old.cash_currency;
  end if;
  if not archived_match and sale_changed
     and coalesce(new.sale_value,0)>0 and new.sale_currency is null then
    raise exception 'Sale currency is required for a positive sale value.'
      using errcode='23514';
  end if;
  if not archived_match and cash_changed
     and coalesce(new.cash_collected,0)>0 and new.cash_currency is null then
    raise exception 'Cash currency is required for positive collected cash.'
      using errcode='23514';
  end if;
  return new;
end;
$$;
revoke execute on function public.guard_lead_money_currency_v8() from public, anon, authenticated;

create trigger client_leads_money_currency_guard_v8
before insert or update of sale_value,sale_currency,cash_collected,cash_currency
on public.client_leads for each row
execute function public.guard_lead_money_currency_v8();

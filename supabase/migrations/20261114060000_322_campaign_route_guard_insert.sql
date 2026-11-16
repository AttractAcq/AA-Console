-- Migration 302 replaced the shared route guard while an INSERT trigger from
-- 204 still called it. Referencing OLD on INSERT rejects new campaigns. Keep
-- the route immutability and exact-approval launch hold on their proper edges.
create or replace function public.guard_campaign_acquisition_route()
returns trigger language plpgsql
set search_path = pg_catalog, public as $$
begin
  if tg_op = 'UPDATE' and (
    old.acquisition_mode is distinct from new.acquisition_mode
    or old.paid_platform is distinct from new.paid_platform
    or old.runs_organic is distinct from new.runs_organic
    or old.runs_paid is distinct from new.runs_paid
    or old.cloned_from_campaign_id is distinct from new.cloned_from_campaign_id
  ) then
    raise exception 'Campaign route and lineage are immutable. Clone this campaign into a new route.';
  end if;
  if new.acquisition_mode <> 'legacy' and new.status = 'live'
     and (tg_op = 'INSERT' or old.status is distinct from 'live') then
    raise exception 'V6 campaign launch requires exact-version human approval. The approval executor is not connected yet.';
  end if;
  return new;
end $$;

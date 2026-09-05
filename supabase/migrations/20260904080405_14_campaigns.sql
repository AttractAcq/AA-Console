-- ============================================================
-- AA Console · 14 · Campaigns (Operations → Campaigns)
-- Two tables in the UI, one table here separated by status.
-- ============================================================

create type campaign_status as enum ('active','past');

create table campaigns (
  id                 uuid primary key default gen_random_uuid(),
  campaign_ref       text not null,
  client_id          uuid references clients(id) on delete set null,
  target_role        text not null,
  daily_spend        numeric(12,2) not null default 0,
  total_spend        numeric(14,2) not null default 0,
  objective_achieved text,
  status             campaign_status not null default 'active',
  started_on         date not null default current_date,
  ended_on           date,
  created_by         uuid references profiles(id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (campaign_ref)
);
create trigger campaigns_set_updated_at before update on campaigns
  for each row execute function set_updated_at();
create index campaigns_status_idx on campaigns (status, started_on desc);
create index campaigns_client_idx on campaigns (client_id);

-- Closing a campaign stamps the end date; reopening clears it.
create or replace function sync_campaign_end_date()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.status = 'past' and new.ended_on is null then
    new.ended_on := current_date;
  elsif new.status = 'active' then
    new.ended_on := null;
  end if;
  return new;
end;
$$;
create trigger campaigns_sync_end before insert or update on campaigns
  for each row execute function sync_campaign_end_date();

-- The two header figures on the Campaigns tab.
create view campaign_totals as
select
  count(*) filter (where status = 'active')                              as active_campaigns,
  coalesce(sum(daily_spend) filter (where status = 'active'), 0)         as current_daily_spend,
  coalesce(sum(total_spend), 0)                                          as lifetime_spend
from campaigns;

alter table campaigns enable row level security;

create policy campaigns_admin_all on campaigns
  for all to authenticated using (is_admin()) with check (is_admin());
create policy campaigns_scoped_read on campaigns
  for select to authenticated
  using (client_id is null or can_access_client(client_id));

-- Dev-stage open read, matching migration 12.
create policy dev_open_read on campaigns
  for select to authenticated using (true);

alter view campaign_totals set (security_invoker = on);;

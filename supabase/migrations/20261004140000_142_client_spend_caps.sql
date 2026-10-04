-- A monthly ceiling on what a client's agents may spend.
--
-- Agent spend to date is $82, against $5.26 in the 7 September audit, and
-- nothing anywhere enforces a limit. Master AI has had daily and
-- per-conversation ceilings since migration 52, but those bound one chat;
-- every agent job is unbounded. That was survivable while a person pressed
-- every button. The engine will not press them one at a time.
--
-- Off unless switched on, per client, the same way the metrics ingest toggle
-- is. No row means no cap and the behaviour nothing changes — a guard that
-- silently started refusing work would be worse than the gap it closes.
--
-- Counted against jobs, not against successes. A job that called a model and
-- then failed still cost money, and a cap that ignored failures would be
-- loosest exactly when something is looping.

create table client_engine_budgets (
  client_id  uuid not null references clients(id) on delete cascade,
  month      date not null,
  cap_usd    numeric not null check (cap_usd >= 0),
  note       text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (client_id, month),
  -- The month is the first of it, so a cap cannot be set for the 14th and
  -- then quietly miss everything spent on the 13th.
  constraint client_engine_budgets_month_start check (month = date_trunc('month', month)::date)
);

comment on table client_engine_budgets is
  'Monthly agent-spend ceiling per client. No row means no cap. Zero is a legitimate value and means stop, which is why the check is >= 0 rather than > 0.';

alter table client_engine_budgets enable row level security;
create policy client_engine_budgets_admin on client_engine_budgets
  for all to authenticated using (is_admin()) with check (is_admin());
create policy client_engine_budgets_client_read on client_engine_budgets
  for select to authenticated using (is_client_user(client_id));
grant select on client_engine_budgets to authenticated;

create trigger client_engine_budgets_set_updated_at
  before update on client_engine_budgets
  for each row execute function set_updated_at();

-- What this client's agents have spent in a month.
--
-- Every job, whatever its status. service_role reads it because the runtime
-- asks before it starts work; a person reads their own clients.
create or replace function agent_spend_for_client(p_client_id uuid, p_month date default null)
returns numeric
language sql
stable
security definer
set search_path to 'public'
as $$
  select coalesce(sum(j.cost_usd), 0)::numeric
  from agent_jobs j
  where j.client_id = p_client_id
    and j.created_at >= date_trunc('month', coalesce(p_month, current_date))
    and j.created_at <  date_trunc('month', coalesce(p_month, current_date)) + interval '1 month'
    and (auth.role() = 'service_role' or can_access_client(p_client_id));
$$;

revoke execute on function agent_spend_for_client(uuid, date) from public, anon;
grant  execute on function agent_spend_for_client(uuid, date) to authenticated, service_role;

-- Cap, spent and what is left, in one read.
--
-- capped is false when there is no row, and the runtime checks that rather
-- than treating a null cap as zero. Those are opposite instructions.
create or replace function client_budget_state(p_client_id uuid, p_month date default null)
returns table (capped boolean, cap_usd numeric, spent_usd numeric, remaining_usd numeric)
language sql
stable
security definer
set search_path to 'public'
as $$
  with m as (select date_trunc('month', coalesce(p_month, current_date))::date as month),
  b as (
    select e.cap_usd from client_engine_budgets e, m
    where e.client_id = p_client_id and e.month = m.month
  ),
  s as (select agent_spend_for_client(p_client_id, (select month from m)) as spent)
  select
    (select count(*) from b) > 0,
    (select cap_usd from b),
    (select spent from s),
    case when (select count(*) from b) > 0
         then (select cap_usd from b) - (select spent from s) end
  where auth.role() = 'service_role' or can_access_client(p_client_id);
$$;

revoke execute on function client_budget_state(uuid, date) from public, anon;
grant  execute on function client_budget_state(uuid, date) to authenticated, service_role;

comment on function client_budget_state(uuid, date) is
  'Cap, spend and remainder for a client in a month. capped is false when no cap is set, which is not the same as a cap of zero.';

-- B006. Reserve paid widget capacity atomically before calling the model.
-- Migration 280 admits public requests by caller and deployment; this ledger
-- separately protects each deployment's daily message and dollar ceilings.
create table public.sales_runtime_daily_budgets (
  deployment_id uuid not null references public.client_sales_agent_deployments(id) on delete cascade,
  budget_day date not null,
  messages integer not null default 0 check (messages >= 0),
  committed_usd numeric(12,6) not null default 0 check (committed_usd >= 0),
  held_usd numeric(12,6) not null default 0 check (held_usd >= 0),
  generation bigint not null default 0,
  primary key (deployment_id, budget_day)
);
create table public.sales_runtime_reservations (
  id uuid primary key default gen_random_uuid(),
  deployment_id uuid not null,
  budget_day date not null,
  state text not null check (state in ('reserved','settled','cancelled','uncertain')),
  reserved_usd numeric(12,6) not null check (reserved_usd > 0),
  actual_usd numeric(12,6),
  conversation_id uuid,
  reserved_at timestamptz not null default now(),
  settled_at timestamptz,
  foreign key (deployment_id, budget_day)
    references public.sales_runtime_daily_budgets(deployment_id, budget_day) on delete cascade
);
create index sales_runtime_reservations_pending_idx
  on public.sales_runtime_reservations (reserved_at)
  where state in ('reserved','uncertain');
alter table public.sales_runtime_requests add column reservation_id uuid
  unique references public.sales_runtime_reservations(id) on delete set null;
alter table public.sales_runtime_daily_budgets enable row level security;
alter table public.sales_runtime_reservations enable row level security;
revoke all on public.sales_runtime_daily_budgets, public.sales_runtime_reservations
  from public, anon, authenticated;
grant select on public.sales_runtime_daily_budgets, public.sales_runtime_reservations
  to service_role;

create function public.reserve_sales_runtime_v6(
  p_deployment_id uuid, p_reserved_usd numeric
) returns table (allowed boolean, reason text, reservation_id uuid)
language plpgsql volatile security definer
set search_path = pg_catalog, public
as $$
declare
  v_deployment public.client_sales_agent_deployments%rowtype;
  v_day date := (clock_timestamp() at time zone 'UTC')::date;
  v_legacy_count integer;
  v_legacy_cost numeric;
  v_id uuid;
begin
  if auth.role() <> 'service_role' then raise exception 'service_role only'; end if;
  if p_reserved_usd is null or p_reserved_usd < 0.000001 or p_reserved_usd > 100 then
    raise exception 'Invalid sales runtime reserve amount';
  end if;
  select * into v_deployment from public.client_sales_agent_deployments
   where id = p_deployment_id for update;
  if not found or not v_deployment.enabled or not exists (
    select 1 from public.client_sales_agents a where a.id = v_deployment.sales_agent_id
      and a.status = 'live' and a.approved_at is not null and a.built_at is not null
  ) then
    return query select false, 'deployment_unavailable'::text, null::uuid;
    return;
  end if;

  -- Count only pre-281 request rows. New requests link to their reservation,
  -- so their cost is never double-counted while the old audit trail remains.
  select count(*)::integer, coalesce(sum(r.cost_usd), 0)
    into v_legacy_count, v_legacy_cost
  from public.sales_runtime_requests r
  where r.deployment_id = p_deployment_id and r.outcome = 'ok'
    and r.reservation_id is null
    and r.occurred_at >= (v_day::timestamp at time zone 'UTC')
    and r.occurred_at < ((v_day + 1)::timestamp at time zone 'UTC');

  -- A conflicting UPDATE, even of generation alone, forces repeatable-read
  -- callers with stale snapshots to serialize or fail closed. A plain row
  -- lock followed by a SUM can miss concurrent rows at that isolation level.
  insert into public.sales_runtime_daily_budgets
    (deployment_id, budget_day, messages, committed_usd)
  values (p_deployment_id, v_day, v_legacy_count, v_legacy_cost)
  on conflict (deployment_id, budget_day) do update
    set generation = sales_runtime_daily_budgets.generation + 1;

  update public.sales_runtime_daily_budgets b
     set messages = b.messages + 1,
         held_usd = b.held_usd + p_reserved_usd
   where b.deployment_id = p_deployment_id and b.budget_day = v_day
     and b.messages < v_deployment.daily_message_limit
     and b.committed_usd + b.held_usd + p_reserved_usd
         <= v_deployment.daily_cost_limit_usd;
  if not found then
    return query select false, 'daily_ceiling'::text, null::uuid;
    return;
  end if;
  insert into public.sales_runtime_reservations
    (deployment_id, budget_day, state, reserved_usd)
  values (p_deployment_id, v_day, 'reserved', p_reserved_usd)
  returning id into v_id;
  return query select true, 'ok'::text, v_id;
end;
$$;
revoke all on function public.reserve_sales_runtime_v6(uuid,numeric) from public, anon, authenticated;
grant execute on function public.reserve_sales_runtime_v6(uuid,numeric) to service_role;

create function public.settle_sales_runtime_v6(
  p_reservation_id uuid, p_actual_usd numeric, p_conversation_id uuid default null
) returns boolean
language plpgsql volatile security definer
set search_path = pg_catalog, public
as $$
declare
  v_deployment_id uuid;
  v_row public.sales_runtime_reservations%rowtype;
  v_overrun boolean;
begin
  if auth.role() <> 'service_role' then raise exception 'service_role only'; end if;
  if p_actual_usd is null or p_actual_usd < 0 or p_actual_usd > 100 then
    raise exception 'Invalid sales runtime actual cost';
  end if;
  -- Reserve takes deployment then budget. Settle can disable the deployment
  -- on an overrun, so it must take that same deployment row before locking
  -- the reservation and budget. Read the immutable FK first, lock its parent,
  -- then re-read the reservation under lock; this avoids a reverse-order
  -- deadlock with a concurrent reserve.
  select deployment_id into v_deployment_id
    from public.sales_runtime_reservations where id = p_reservation_id;
  if not found then raise exception 'Unknown sales runtime reservation'; end if;
  perform 1 from public.client_sales_agent_deployments
   where id = v_deployment_id for update;
  if not found then raise exception 'Sales runtime deployment no longer exists'; end if;
  select * into v_row from public.sales_runtime_reservations
   where id = p_reservation_id for update;
  if not found then raise exception 'Unknown sales runtime reservation'; end if;
  if v_row.state = 'settled' then
    if v_row.actual_usd <> p_actual_usd
       or v_row.conversation_id is distinct from p_conversation_id then
      raise exception 'Conflicting sales runtime settlement';
    end if;
    return v_row.actual_usd > v_row.reserved_usd;
  end if;
  if v_row.state not in ('reserved','uncertain') then
    raise exception 'Sales runtime reservation cannot be settled';
  end if;
  update public.sales_runtime_daily_budgets
     set held_usd = held_usd - v_row.reserved_usd,
         committed_usd = committed_usd + p_actual_usd,
         generation = generation + 1
   where deployment_id = v_row.deployment_id and budget_day = v_row.budget_day;
  update public.sales_runtime_reservations
     set state='settled', actual_usd=p_actual_usd,
         conversation_id=p_conversation_id, settled_at=clock_timestamp()
   where id=v_row.id;
  v_overrun := p_actual_usd > v_row.reserved_usd;
  if v_overrun then
    -- The model returned a cost above the conservative reserve. Stop the
    -- deployment so no further calls can compound a pricing-model error.
    update public.client_sales_agent_deployments set enabled=false, disabled_at=clock_timestamp()
     where id=v_row.deployment_id;
  end if;
  return v_overrun;
end;
$$;
revoke all on function public.settle_sales_runtime_v6(uuid,numeric,uuid) from public, anon, authenticated;
grant execute on function public.settle_sales_runtime_v6(uuid,numeric,uuid) to service_role;

create function public.cancel_sales_runtime_reservation_v6(p_reservation_id uuid)
returns boolean language plpgsql volatile security definer
set search_path = pg_catalog, public
as $$
declare v_row public.sales_runtime_reservations%rowtype;
begin
  if auth.role() <> 'service_role' then raise exception 'service_role only'; end if;
  select * into v_row from public.sales_runtime_reservations
   where id=p_reservation_id for update;
  if not found then raise exception 'Unknown sales runtime reservation'; end if;
  if v_row.state = 'cancelled' then return true; end if;
  if v_row.state <> 'reserved' then return false; end if;
  update public.sales_runtime_daily_budgets
     set messages=messages-1, held_usd=held_usd-v_row.reserved_usd,
         generation=generation+1
   where deployment_id=v_row.deployment_id and budget_day=v_row.budget_day;
  update public.sales_runtime_reservations
     set state='cancelled', settled_at=clock_timestamp() where id=v_row.id;
  return true;
end;
$$;
revoke all on function public.cancel_sales_runtime_reservation_v6(uuid) from public, anon, authenticated;
grant execute on function public.cancel_sales_runtime_reservation_v6(uuid) to service_role;

create function public.mark_sales_runtime_uncertain_v6(p_reservation_id uuid)
returns boolean language plpgsql volatile security definer
set search_path = pg_catalog, public
as $$
declare v_state text;
begin
  if auth.role() <> 'service_role' then raise exception 'service_role only'; end if;
  select state into v_state from public.sales_runtime_reservations
   where id=p_reservation_id for update;
  if not found then raise exception 'Unknown sales runtime reservation'; end if;
  if v_state = 'uncertain' then return true; end if;
  if v_state <> 'reserved' then return false; end if;
  update public.sales_runtime_reservations set state='uncertain' where id=p_reservation_id;
  return true;
end;
$$;
revoke all on function public.mark_sales_runtime_uncertain_v6(uuid) from public, anon, authenticated;
grant execute on function public.mark_sales_runtime_uncertain_v6(uuid) to service_role;

-- A crashed runtime cannot silently release possible provider spend. The
-- reserve remains charged to that UTC day until reconciled against provider
-- usage; the next day starts a fresh daily budget. Operators can see the
-- uncertain count without reading visitor data.
create view public.sales_runtime_budget_status_v6 as
select b.deployment_id, b.budget_day, b.messages, b.committed_usd, b.held_usd,
       count(r.id) filter (where r.state='uncertain')::integer as uncertain_count
from public.sales_runtime_daily_budgets b
left join public.sales_runtime_reservations r
  on r.deployment_id=b.deployment_id and r.budget_day=b.budget_day
group by b.deployment_id,b.budget_day,b.messages,b.committed_usd,b.held_usd;
revoke all on public.sales_runtime_budget_status_v6 from public, anon, authenticated;
grant select on public.sales_runtime_budget_status_v6 to service_role;

-- The earlier read-then-count allowance is non-atomic. After the new runtime
-- is deployed, no caller may use it as an alternative paid-compute gate.
revoke execute on function public.sales_runtime_allow(uuid,text,integer)
  from service_role;

select cron.schedule('mark-stale-sales-runtime-reservations', '*/5 * * * *',
  $cron$ update public.sales_runtime_reservations set state='uncertain'
    where state='reserved' and reserved_at < now()-interval '10 minutes'; $cron$);

begin;

-- Enrollment is an operator action after rollout. No clients are enrolled by migration.
create schema agent_budget_private;
revoke all on schema agent_budget_private from public, anon, authenticated, service_role;
create table agent_budget_private.caps (
  client_id uuid not null references public.clients(id),
  month date not null check (extract(day from month)=1),
  ceiling_usd numeric(12,6) not null check (ceiling_usd >= 0 and ceiling_usd < 'Infinity'),
  reservation_revision bigint not null default 0,
  primary key (client_id,month)
);
create table agent_budget_private.reservations (
  job_id uuid not null,
  attempt integer not null,
  turn integer not null check (turn>=0),
  client_id uuid not null,
  month date not null,
  lease_owner text not null,
  reserved_usd numeric(12,6) not null check (reserved_usd>0),
  actual_usd numeric(12,6) check (actual_usd>=0 and actual_usd <= reserved_usd),
  primary key(job_id,attempt,turn),
  foreign key(client_id,month) references agent_budget_private.caps(client_id,month)
);
create index on agent_budget_private.reservations(client_id,month);
revoke all on all tables in schema agent_budget_private from public, anon, authenticated, service_role;

-- Historical job totals do not prove what each retry cost. Only enroll a month
-- before any unmetered-by-this-ledger attempt, including an overlapping lease.
create function agent_budget_private.enroll() returns trigger
language plpgsql set search_path = pg_catalog as $$
begin
  perform pg_advisory_xact_lock(hashtextextended(new.client_id::text,703));
  if exists(select 1 from public.agent_jobs j where j.client_id=new.client_id
    and not j.hard_budget_required and (j.status in ('claimed','running') or
      (j.attempts>0 and greatest(j.created_at,j.started_at,j.completed_at) >=
       (new.month::timestamp at time zone 'UTC')))) then
    raise exception 'Reconcile existing worker attempts before hard-budget enrollment';
  end if;
  return new;
end $$;
alter table public.agent_jobs add column hard_budget_required boolean not null default false,
  add column hard_budget_retry_usd numeric(12,6);
create trigger verify_enrollment before insert on agent_budget_private.caps
for each row execute function agent_budget_private.enroll();

-- A claim carries authoritative opt-in even when budget reads later fail.
-- An old worker cannot enter running for an enrolled client without a reservation.
create function agent_budget_private.guard_claim() returns trigger
language plpgsql security definer set search_path = pg_catalog as $$
begin
  if new.status='claimed' then new.hard_budget_retry_usd := null; end if;
  if new.client_id is null then return new; end if;
  perform pg_advisory_xact_lock(hashtextextended(new.client_id::text,703));
  new.hard_budget_required := exists(select 1 from agent_budget_private.caps c where c.client_id=new.client_id);
  if new.hard_budget_required and new.status='running' and not exists(
    select 1 from agent_budget_private.reservations r where r.job_id=new.id
     and r.client_id=new.client_id and r.attempt=new.attempts and r.turn=0 and r.actual_usd is null
     and r.lease_owner=new.lease_owner) then
    raise exception 'Running this client requires a hard-budget reservation';
  end if;
  return new;
end $$;
create trigger guard_hard_budget_claim before insert or update of status on public.agent_jobs
for each row when (new.status in ('claimed','running')) execute function agent_budget_private.guard_claim();

-- Turn zero reserves the first call before running. Immediately before sending,
-- replace it with turn one. Further turns and queue retries each reserve anew.
create function public.reserve_agent_budget_turn(p_job_id uuid,p_attempt integer,p_owner text,
  p_turn integer,p_usd numeric) returns void
language plpgsql security definer set search_path=pg_catalog as $$
declare
  j public.agent_jobs;
  m date := date_trunc('month',clock_timestamp() at time zone 'UTC')::date;
  cap numeric; booked numeric;
begin
  if auth.role() is distinct from 'service_role' then raise insufficient_privilege; end if;
  select * into strict j from public.agent_jobs where id=p_job_id for update;
  if not j.hard_budget_required or j.attempts is distinct from p_attempt
    or p_owner is null or j.lease_owner is distinct from p_owner or j.lease_until is null
    or j.lease_until<=clock_timestamp() or p_turn is null or p_turn<0
    or j.status::text <> (case when p_turn=0 then 'claimed' else 'running' end)
    or p_usd is null or not (p_usd>0 and p_usd<=100000) or p_usd<>round(p_usd,6) then
    raise exception 'Invalid hard-budget reservation or stale job lease';
  end if;
  select least(c.ceiling_usd,b.cap_usd) into strict cap
    from agent_budget_private.caps c join public.client_engine_budgets b using(client_id,month)
    where c.client_id=j.client_id and c.month=m for update of c,b;
  -- A write conflict also serializes callers using repeatable-read snapshots.
  update agent_budget_private.caps set reservation_revision=reservation_revision+1
    where client_id=j.client_id and month=m;
  if p_turn=1 then
    update agent_budget_private.reservations set actual_usd=0
      where job_id=j.id and attempt=p_attempt and turn=0 and lease_owner=p_owner
        and actual_usd is null and month=m;
    if not found then raise exception 'First call has no current dispatch reservation'; end if;
  end if;
  select coalesce(sum(coalesce(actual_usd,reserved_usd)),0) into booked
    from agent_budget_private.reservations where client_id=j.client_id and month=m;
  if booked+p_usd>cap then
    raise exception 'Hard cap: call requires USD %, available USD %',p_usd,greatest(0,cap-booked);
  end if;
  insert into agent_budget_private.reservations(job_id,attempt,turn,client_id,month,lease_owner,reserved_usd)
    values(j.id,p_attempt,p_turn,j.client_id,m,p_owner,p_usd);
end $$;

create function public.settle_agent_budget_turn(p_job_id uuid,p_attempt integer,p_owner text,
  p_turn integer,p_usd numeric) returns void
language plpgsql security definer set search_path=pg_catalog as $$
begin
  if auth.role() is distinct from 'service_role' then raise insufficient_privilege; end if;
  if p_usd is null or p_usd<0 or p_usd<>round(p_usd,6) or (p_turn=0 and p_usd<>0) then
    raise exception 'Invalid hard-budget settlement';
  end if;
  update agent_budget_private.reservations set actual_usd=p_usd
    where job_id=p_job_id and attempt=p_attempt and lease_owner=p_owner and turn=p_turn
      and (actual_usd is null or actual_usd=p_usd) and p_usd<=reserved_usd;
  if not found then raise exception 'Unknown reservation or conflicting settlement'; end if;
end $$;
revoke all on all functions in schema agent_budget_private from public,anon,authenticated,service_role;
revoke all on function public.reserve_agent_budget_turn(uuid,integer,text,integer,numeric),
  public.settle_agent_budget_turn(uuid,integer,text,integer,numeric) from public,anon,authenticated;
grant execute on function public.reserve_agent_budget_turn(uuid,integer,text,integer,numeric),
  public.settle_agent_budget_turn(uuid,integer,text,integer,numeric) to service_role;

-- The account read preserves posted spend separately from the money still
-- reserved by unfinished or ambiguous calls.
create or replace function public.client_budget_state(p_client_id uuid,p_month date default null)
returns table(capped boolean,cap_usd numeric,spent_usd numeric,remaining_usd numeric)
language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare
  budget_month date := date_trunc('month',coalesce(p_month,(now() at time zone 'UTC')::date))::date;
  effective numeric;
begin
  if auth.role() is distinct from 'service_role' and not coalesce(public.can_access_client(p_client_id),false) then return; end if;
  if exists(select 1 from agent_budget_private.caps c where c.client_id=p_client_id) then
    select least(c.ceiling_usd,b.cap_usd) into effective from agent_budget_private.caps c
      join public.client_engine_budgets b using(client_id,month)
      where c.client_id=p_client_id and c.month=budget_month;
    effective := coalesce(effective,0);
    return query select true,effective,coalesce(sum(r.actual_usd),0),
      greatest(0,effective-coalesce(sum(coalesce(r.actual_usd,r.reserved_usd)),0))
      from agent_budget_private.reservations r where r.client_id=p_client_id and r.month=budget_month;
    return;
  end if;
  return query
  with m as (select date_trunc('month', coalesce(p_month, current_date))::date as month),
  b as (
    select e.cap_usd from client_engine_budgets e, m
    where e.client_id = p_client_id and e.month = m.month
  ),
  s as (select agent_spend_for_client(p_client_id, (select month from m)) as spent)
  select
    (select count(*) from b) > 0,
    (select b.cap_usd from b),
    (select spent from s),
    case when (select count(*) from b) > 0
         then (select b.cap_usd from b) - (select spent from s) end
  where auth.role() = 'service_role' or can_access_client(p_client_id);
end $$;

create or replace function public.resume_paused_jobs()
returns integer
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  r record;
  v_state record;
  v_count integer := 0;
begin
  if coalesce(auth.role(), '') not in ('service_role', '') then
    raise exception 'Held jobs are resumed by the runtime.' using errcode = 'P0001';
  end if;

  for r in
    select j.id, j.client_id, j.agent_key, j.hard_budget_required, j.hard_budget_retry_usd
      from agent_jobs j
      join agents a on a.agent_key = j.agent_key
     where j.status = 'paused'
       and a.paused = false
       and a.archived_at is null
     order by j.created_at
  loop
    -- The cap, as the database computes it, for the month it is now. A job
    -- held in March is free in April without anybody raising anything.
    if r.client_id is not null then
      select * into v_state from client_budget_state(r.client_id);
      if r.hard_budget_required and r.hard_budget_retry_usd is not null and (r.hard_budget_retry_usd<0 or v_state.capped is distinct from true
         or coalesce(v_state.remaining_usd,0)<r.hard_budget_retry_usd) then
        continue;
      end if;
      if v_state.capped is true
         and v_state.cap_usd is not null
         and coalesce(v_state.spent_usd, 0) >= v_state.cap_usd then
        continue;
      end if;
    end if;

    update agent_jobs
       set status = 'queued',
           error = null,
           run_after = null
     where id = r.id and status = 'paused';
    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;
commit;

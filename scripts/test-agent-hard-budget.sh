#!/usr/bin/env bash
set -euo pipefail
# Only accepts a loopback port. Two independent sessions race for the same USD 10.
port=${1:?local PostgreSQL port required}
[[ "$port" =~ ^[0-9]+$ ]] && (( port >= 20002 && port <= 62002 )) || exit 2
db=aa_budget_test_${RANDOM}_${RANDOM}
export PGHOST=127.0.0.1 PGPORT="$port" PGUSER=postgres PGPASSWORD=postgres
pg() { psql -XqAt -v ON_ERROR_STOP=1 -d "$db" "$@"; }
psql -XqAt -v ON_ERROR_STOP=1 -d postgres -c "create database $db"
trap 'psql -XqAt -d postgres -c "drop database $db with (force)" >/dev/null' EXIT
cd "$(dirname "$0")/.."
pg <<'SQL'
create schema auth;
create function auth.role() returns text language sql stable as $$select current_setting('role')$$;
create function public.can_access_client(uuid) returns boolean language sql as $$select false$$;
create function public.agent_spend_for_client(uuid,date) returns numeric language sql as $$select 0::numeric$$;
create table public.clients(id uuid primary key);
create table public.agents(agent_key text,paused boolean,archived_at timestamptz);
insert into public.agents values('icp',false,null);
create table public.client_engine_budgets(client_id uuid,month date,cap_usd numeric,primary key(client_id,month));
create table public.agent_jobs(id uuid primary key,client_id uuid,attempts integer,status text,
 agent_key text default 'icp',error text,run_after timestamptz,lease_until timestamptz,lease_owner text,created_at timestamptz default now(),started_at timestamptz,completed_at timestamptz);
SQL
pg -f supabase/migrations/20261124061800_703_worker_hard_budget.sql
pg <<'SQL'
insert into clients values ('00000000-0000-0000-0000-000000000001'),('00000000-0000-0000-0000-000000000002');
insert into client_engine_budgets select id,date_trunc('month',now() at time zone 'UTC')::date,10 from clients;
insert into agent_budget_private.caps(client_id,month,ceiling_usd)
 select client_id,month,10 from client_engine_budgets where client_id::text like '%1';
insert into agent_jobs(id,client_id,attempts,status,lease_owner,lease_until)
 select ('10000000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid,'00000000-0000-0000-0000-000000000001',1,'claimed','worker-'||n,now()+interval '1 hour' from generate_series(1,2)n;
insert into agent_jobs(id,client_id,attempts,status,lease_owner,lease_until)
 values('10000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000002',1,'claimed','legacy',now()+interval '1 hour');
update agent_jobs set status='running' where lease_owner='legacy';
do $$begin
 if exists(select 1 from agent_jobs where lease_owner='legacy' and hard_budget_required)
 or exists(select 1 from agent_jobs where lease_owner<>'legacy' and not hard_budget_required) then raise exception 'claim scoping'; end if;
 begin
   update agent_jobs set status='running' where lease_owner='worker-1';
   raise exception 'unguarded legacy runner';
 exception when raise_exception then
   if sqlerrm <> 'Running this client requires a hard-budget reservation' then raise; end if;
 end;
 if has_function_privilege('authenticated','public.reserve_agent_budget_turn(uuid,integer,text,integer,numeric)','execute')
 or has_table_privilege('service_role','agent_budget_private.reservations','update') then raise exception 'unexpected grants'; end if;
end$$;
SQL
id1=10000000-0000-0000-0000-000000000001
id2=10000000-0000-0000-0000-000000000002
# Session B must observe session A's committed reservation after waiting.
PGAPPNAME=hard_budget_holder pg -c "begin; set local role service_role; select public.reserve_agent_budget_turn('$id1',1,'worker-1',0,7); select pg_sleep(2); commit" >/dev/null &
holder=$!
sleeping=false
for ((i=0;i<100;i++)); do
  if [[ $(pg -c "select count(*) from pg_stat_activity where application_name='hard_budget_holder' and wait_event='PgSleep'") == 1 ]]; then sleeping=true; break; fi
  sleep 0.05
done
[[ $sleeping == true ]]
reject() {
  local error
  if error=$(pg -c "set role service_role; $1" 2>&1); then
    echo 'Expected reservation rejection' >&2; exit 1
  fi
  [[ "$error" == *"$2"* ]] || { echo "$error" >&2; exit 1; }
}
reserve() { pg -c "set role service_role; select public.reserve_agent_budget_turn('$id1',$1,'worker-1',$2,$3)" >/dev/null; }
settle() { pg -c "set role service_role; select public.settle_agent_budget_turn('$id1',$1,'worker-1',$2,$3)" >/dev/null; }
reject "select public.reserve_agent_budget_turn('$id2',1,'worker-2',0,7)" 'available USD 3'
wait "$holder"
pg -c "update agent_jobs set status='running' where id='$id1'"
reserve 1 1 7
reject "select public.reserve_agent_budget_turn('$id1',1,'worker-1',1,7)" 'no current dispatch reservation'
[[ $(pg -c "set role service_role; select remaining_usd=3 and spent_usd=0 from public.client_budget_state('00000000-0000-0000-0000-000000000001')") == t ]]
pg -c "update agent_jobs set status='paused',hard_budget_retry_usd=7 where id='$id2'"
[[ $(pg -c "set role service_role; select public.resume_paused_jobs()") == 0 ]]
settle 1 1 0.25
[[ $(pg -c "set role service_role; select public.resume_paused_jobs()") == 1 ]]
settle 1 1 0.25
reject "select public.settle_agent_budget_turn('$id1',1,'worker-1',1,0)" 'conflicting settlement'
reserve 1 2 7
# Simulate unknown provider outcome and a queue retry. The earlier turn stays charged.
pg -c "update agent_jobs set status='claimed',attempts=2 where id='$id1'"
reject "select public.reserve_agent_budget_turn('$id1',2,'worker-1',0,7)" 'available USD 2.75'
reject "select public.reserve_agent_budget_turn('$id1',1,'worker-1',0,1)" 'stale job lease'
pg -c "delete from client_engine_budgets where client_id::text like '%1'"
reject "select public.reserve_agent_budget_turn('$id1',2,'worker-1',0,1)" 'no rows'
[[ $(pg -c "set role service_role; select capped and cap_usd=0 and remaining_usd=0 from public.client_budget_state('00000000-0000-0000-0000-000000000001')") == t ]]
[[ $(pg -c "set role authenticated; select count(*) from public.client_budget_state('00000000-0000-0000-0000-000000000001')") == 0 ]]
[[ $(pg -c "set role service_role; select capped and cap_usd=10 and remaining_usd=10 from public.client_budget_state('00000000-0000-0000-0000-000000000002')") == t ]]
echo 'PASS isolated PostgreSQL concurrent reservations, usage settlement, unknown-outcome retry, missing cap, legacy worker and tenant scoping.'

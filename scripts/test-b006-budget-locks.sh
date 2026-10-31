#!/usr/bin/env bash
set -euo pipefail

# Exercise migration 281 against two real PostgreSQL connections in a separate
# disposable database on schema replay's local server. No linked project or
# production URL is accepted. The fixture has only the tables the migration
# needs, so this tests the migration's lock order without client seed data.
port="${1:-}"
if [[ ! "$port" =~ ^[0-9]+$ ]] || (( port < 20002 || port > 62002 )); then
  echo 'Expected an isolated local PostgreSQL port.' >&2
  exit 1
fi
repository_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repository_dir"
test_dir="$(mktemp -d "${TMPDIR:-/tmp}/aa-b006-lock.XXXXXX")"
test_db="aa_b006_lock_${RANDOM}_${RANDOM}"
a_pid=''
b_pid=''
psql_root() {
  PGPASSWORD=postgres psql -X -qAt -v ON_ERROR_STOP=1 \
    -h 127.0.0.1 -p "$port" -U postgres -d postgres "$@"
}
psql_test() {
  PGPASSWORD=postgres psql -X -qAt -v ON_ERROR_STOP=1 \
    -h 127.0.0.1 -p "$port" -U postgres -d "$test_db" "$@"
}
cleanup() {
  [[ -z "$a_pid" ]] || kill "$a_pid" 2>/dev/null || true
  [[ -z "$b_pid" ]] || kill "$b_pid" 2>/dev/null || true
  psql_root -c "drop database if exists $test_db with (force)" >/dev/null 2>&1 || true
  rm -rf "$test_dir"
}
trap cleanup EXIT

psql_root -c "create database $test_db" >/dev/null
psql_test <<'SQL' >/dev/null
create schema auth;
create schema cron;
create function auth.role() returns text language sql stable as
  $$ select current_setting('test.role', true) $$;
create function cron.schedule(text,text,text) returns bigint language sql as
  $$ select 1::bigint $$;
create table public.client_sales_agents (
  id uuid primary key, status text, approved_at timestamptz, built_at timestamptz
);
create table public.client_sales_agent_deployments (
  id uuid primary key, client_id uuid,
  sales_agent_id uuid references public.client_sales_agents(id),
  enabled boolean, daily_message_limit integer, daily_cost_limit_usd numeric,
  disabled_at timestamptz
);
create table public.sales_runtime_requests (
  id uuid primary key default gen_random_uuid(), deployment_id uuid,
  outcome text, cost_usd numeric, occurred_at timestamptz default now()
);
create function public.sales_runtime_allow(uuid,text,integer)
  returns boolean language sql as $$ select true $$;
insert into public.client_sales_agents
  values ('22222222-2222-4222-8222-222222222222','live',now(),now());
insert into public.client_sales_agent_deployments
  values ('11111111-1111-4111-8111-111111111111',null,
          '22222222-2222-4222-8222-222222222222',true,3,1.00,null);
SQL
psql_test -f supabase/migrations/20261101010000_284_sales_runtime_budget_reservations.sql \
  >"$test_dir/migration.log"
reservation_id="$(psql_test -c "set test.role='service_role'; select reservation_id from public.reserve_sales_runtime_v6('11111111-1111-4111-8111-111111111111',0.2)")"
if [[ ! "$reservation_id" =~ ^[0-9a-f-]{36}$ ]]; then
  echo 'Could not seed the disposable sales reservation.' >&2
  exit 1
fi

# Connection A holds deployment, then asks reserve for the budget. Connection
# B starts settlement while A holds it. The old settlement took reservation
# and budget first, then waited for deployment; A and B deadlocked. The fixed
# settlement waits for deployment before touching either child row.
psql_test >"$test_dir/a.log" 2>&1 <<'SQL' &
set test.role='service_role';
set lock_timeout='12s';
begin;
select id from public.client_sales_agent_deployments
 where id='11111111-1111-4111-8111-111111111111' for update;
\echo A_LOCKED_DEPLOYMENT
select pg_sleep(8);
select allowed from public.reserve_sales_runtime_v6(
  '11111111-1111-4111-8111-111111111111',0.1);
commit;
SQL
a_pid=$!
for _ in $(seq 1 50); do
  if grep -q 'A_LOCKED_DEPLOYMENT' "$test_dir/a.log"; then break; fi
  sleep 0.1
done
if ! grep -q 'A_LOCKED_DEPLOYMENT' "$test_dir/a.log"; then
  echo 'First PostgreSQL connection did not lock deployment.' >&2
  exit 1
fi

psql_test >"$test_dir/b.log" 2>&1 <<SQL &
set test.role='service_role';
set lock_timeout='12s';
begin;
select public.settle_sales_runtime_v6('$reservation_id',0.3,null);
commit;
SQL
b_pid=$!
blocked='f'
for _ in $(seq 1 60); do
  blocked="$(psql_test -c "select exists(select 1 from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid() and query like '%settle_sales_runtime_v6%' and wait_event_type='Lock')")"
  if [[ "$blocked" == 't' ]]; then break; fi
  sleep 0.1
done
if [[ "$blocked" != 't' ]]; then
  echo 'Settlement did not reach the contested deployment lock.' >&2
  exit 1
fi
if ! wait "$a_pid"; then
  echo 'Concurrent reservation failed; possible lock-order deadlock.' >&2
  tail -10 "$test_dir/a.log" >&2
  exit 1
fi
a_pid=''
if ! wait "$b_pid"; then
  echo 'Concurrent overrun settlement failed; possible lock-order deadlock.' >&2
  tail -10 "$test_dir/b.log" >&2
  exit 1
fi
b_pid=''
result="$(psql_test -c "select (not d.enabled and b.messages=2 and b.committed_usd=0.3 and b.held_usd=0.1) from public.client_sales_agent_deployments d join public.sales_runtime_daily_budgets b on b.deployment_id=d.id where d.id='11111111-1111-4111-8111-111111111111'")"
if [[ "$result" != 't' ]]; then
  echo 'Concurrent settlement did not preserve budget or disable the overrun.' >&2
  exit 1
fi
echo 'Two-connection sales budget lock-order regression passed.'

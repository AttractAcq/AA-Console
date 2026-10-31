-- B006. Bounded, IP-free public perimeter counters for the admin inventory.
-- The runtime may read this after authenticating an admin; an authenticated
-- database admin may also call it directly. Other users cannot inspect spend.
create function public.public_perimeter_status_v6(
  p_limit integer default 100,
  p_after_deployment_id uuid default null
) returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, public
as $$
declare
  v_today date := (now() at time zone 'UTC')::date;
  v_quota jsonb;
  v_budgets jsonb;
  v_last uuid;
  v_more boolean;
  v_uncertain bigint;
begin
  if auth.role() <> 'service_role'
     and not (auth.role() = 'authenticated' and coalesce(public.is_admin(), false)) then
    raise exception 'Admin only';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 200 then
    raise exception 'Invalid public perimeter page size';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'route', q.route, 'bucketKind', q.bucket_kind,
    'activeBuckets', q.active_buckets, 'countedAttempts', q.attempts
  ) order by q.route, q.bucket_kind), '[]'::jsonb)
    into v_quota
  from (
    select route, bucket_kind, sum(active_buckets)::bigint as active_buckets,
           sum(attempts)::bigint as attempts
      from public.public_route_quota_metrics_v6
     group by route, bucket_kind
  ) q;

  with page as (
    select b.deployment_id, b.messages, b.committed_usd,
           b.held_usd, b.uncertain_count
      from public.sales_runtime_budget_status_v6 b
     where b.budget_day = v_today
       and (p_after_deployment_id is null or b.deployment_id > p_after_deployment_id)
     order by b.deployment_id
     limit p_limit
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'deploymentId', p.deployment_id, 'messages', p.messages,
    'committedUsd', p.committed_usd, 'heldUsd', p.held_usd,
    'uncertainCount', p.uncertain_count
  ) order by p.deployment_id), '[]'::jsonb)
    into v_budgets
  from page p;

  if jsonb_array_length(v_budgets) > 0 then
    v_last := (v_budgets -> (jsonb_array_length(v_budgets) - 1)
               ->> 'deploymentId')::uuid;
  end if;

  select exists (
    select 1 from public.sales_runtime_daily_budgets b
     where b.budget_day = v_today and b.deployment_id > v_last
  ) into v_more;
  select count(*) into v_uncertain
    from public.sales_runtime_reservations where state = 'uncertain';

  return jsonb_build_object(
    'asOf', now(), 'budgetDay', v_today,
    'quotaLastHour', v_quota, 'budgetsToday', v_budgets,
    'unresolvedUncertain', v_uncertain,
    'nextDeploymentCursor', case when v_more then v_last else null end
  );
end;
$$;
revoke all on function public.public_perimeter_status_v6(integer,uuid)
  from public, anon, authenticated;
grant execute on function public.public_perimeter_status_v6(integer,uuid)
  to authenticated, service_role;

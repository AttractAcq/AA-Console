-- B006. One atomic admission ledger for every public database-backed route.
-- Static widget JavaScript and proof-portal HTML are served without DB work.
-- The runtime supplies only salted/digested handles; no raw IPs,
-- tokens, contact details or request bodies.
create table public.public_route_quota_buckets (
  route text not null,
  bucket_kind text not null check (bucket_kind in ('ip', 'subject')),
  subject_hash text not null check (subject_hash ~ '^[a-f0-9]{64}$'),
  window_start timestamptz not null,
  attempts integer not null check (attempts between 1 and 121),
  expires_at timestamptz not null,
  primary key (route, bucket_kind, subject_hash, window_start)
);
create index public_route_quota_expiry_idx on public.public_route_quota_buckets (expires_at);
alter table public.public_route_quota_buckets enable row level security;
revoke all on public.public_route_quota_buckets from public, anon, authenticated;

create function public.admit_public_route_v6(
  p_route text,
  p_ip_hash text,
  p_subject_hash text
) returns boolean
language plpgsql volatile security definer
set search_path = pg_catalog, public
as $$
declare
  v_ip_limit integer;
  v_subject_limit integer;
  v_window timestamptz := date_trunc('minute', clock_timestamp());
  v_bucket record;
  v_attempts integer;
begin
  if auth.role() <> 'service_role' then
    raise exception 'service_role only';
  end if;
  if p_ip_hash !~ '^[a-f0-9]{64}$' or p_subject_hash !~ '^[a-f0-9]{64}$'
     or p_ip_hash is null or p_subject_hash is null then
    raise exception 'Invalid public quota handle';
  end if;

  case p_route
    when 'lead_submit' then v_ip_limit := 30; v_subject_limit := 10;
    when 'proof_config' then v_ip_limit := 30; v_subject_limit := 15;
    when 'proof_submit' then v_ip_limit := 15; v_subject_limit := 15;
    when 'sales_config' then v_ip_limit := 30; v_subject_limit := 120;
    when 'sales_message' then v_ip_limit := 12; v_subject_limit := 120;
    when 'booking_slots' then v_ip_limit := 30; v_subject_limit := 120;
    when 'booking_submit' then v_ip_limit := 10; v_subject_limit := 60;
    else raise exception 'Unknown public quota route';
  end case;

  -- The global IP row is always locked first, then route IP, then subject.
  -- ON CONFLICT takes the row lock and increments within this transaction,
  -- so two replicas cannot both admit the last slot. A refused attempt still
  -- consumes its already-visited caller bucket; that bounds token rotation.
  for v_bucket in
    select * from (values
      (1, 'global'::text, 'ip'::text, p_ip_hash, 60),
      (2, p_route, 'ip'::text, p_ip_hash, v_ip_limit),
      (3, p_route, 'subject'::text, p_subject_hash, v_subject_limit)
    ) as buckets(ord, route, kind, hash, max_attempts)
    order by ord
  loop
    insert into public.public_route_quota_buckets
      (route, bucket_kind, subject_hash, window_start, attempts, expires_at)
    values (v_bucket.route, v_bucket.kind, v_bucket.hash,
            v_window, 1, v_window + interval '2 hours')
    on conflict (route, bucket_kind, subject_hash, window_start)
    do update set attempts = least(public_route_quota_buckets.attempts + 1,
                                   v_bucket.max_attempts + 1)
    returning attempts into v_attempts;
    if v_attempts > v_bucket.max_attempts then
      return false;
    end if;
  end loop;
  return true;
end;
$$;
revoke all on function public.admit_public_route_v6(text,text,text) from public, anon, authenticated;
grant execute on function public.admit_public_route_v6(text,text,text) to service_role;

-- Hash-free operator counters. The route labels are a closed SQL allowlist.
create view public.public_route_quota_metrics_v6 as
select route, bucket_kind, window_start,
       count(*)::integer as active_buckets,
       sum(attempts)::bigint as attempts
from public.public_route_quota_buckets
where window_start >= now() - interval '1 hour'
group by route, bucket_kind, window_start;
revoke all on public.public_route_quota_metrics_v6 from public, anon, authenticated;
grant select on public.public_route_quota_metrics_v6 to service_role;

-- pg_cron is installed by migration 34. Keep only two hours of transient
-- liveness data; a rotating-invalid-token attack cannot grow this forever.
select cron.schedule('prune-public-route-quota', '17 * * * *',
  $cron$ delete from public.public_route_quota_buckets where expires_at < now(); $cron$);

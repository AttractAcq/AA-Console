-- One definition of what the numbers are.
--
-- The reporting panels and the commentary agent must never disagree: a
-- chart saying one thing while the write-up says another is worse than
-- having neither. So the aggregation rules live here, once, and both read
-- this rather than each doing their own arithmetic.
--
-- The rules, and why:
--   paid rows are daily        -> sum across the window
--   post rows are cumulative   -> take the latest snapshot per post; summing
--                                 would count the same impressions once per
--                                 day pulled
--   daily reach counts people  -> report the best single day, never a sum,
--                                 which would double-count anyone who saw
--                                 the account twice
--
-- SECURITY INVOKER on purpose: RLS on metrics_daily then applies to a
-- signed-in caller, and the runtime's service role bypasses it as usual.
-- No explicit permission check to drift out of step with the policies.

create or replace function metrics_period_summary(
  p_client_id uuid,
  p_since date,
  p_until date
)
returns jsonb
language sql
stable
security invoker
set search_path to 'public'
as $$
with scoped as (
  select * from metrics_daily
   where client_id = p_client_id
     and metric_date between p_since and p_until
),
paid as (
  select * from scoped where surface = 'paid' and basis = 'daily'
),
paid_totals as (
  select coalesce(sum(spend), 0)::numeric        as spend,
         coalesce(sum(impressions), 0)::bigint   as impressions,
         coalesce(sum(clicks), 0)::bigint        as clicks,
         coalesce(sum(conversions), 0)::bigint   as conversions,
         count(distinct metric_date)::int        as days_covered,
         max(currency)                           as currency
    from paid
),
paid_campaigns as (
  select p.external_id,
         c.campaign_ref,
         c.target_role,
         p.campaign_id is not null                as mapped,
         coalesce(sum(p.spend), 0)::numeric       as spend,
         coalesce(sum(p.impressions), 0)::bigint  as impressions,
         coalesce(sum(p.clicks), 0)::bigint       as clicks,
         coalesce(sum(p.conversions), 0)::bigint  as conversions,
         count(distinct p.metric_date)::int       as days_active
    from paid p
    left join campaigns c on c.id = p.campaign_id
   group by p.external_id, c.campaign_ref, c.target_role, (p.campaign_id is not null)
),
account_rows as (
  select * from scoped where surface = 'organic' and entity_type = 'account'
),
account_totals as (
  select coalesce(sum(impressions), 0)::bigint  as impressions,
         coalesce(max(reach), 0)::bigint        as best_day_reach,
         coalesce(sum(engagements), 0)::bigint  as engagements,
         count(distinct metric_date)::int       as days_covered
    from account_rows
),
-- distinct on gives the latest snapshot per post, which is the only
-- meaningful value for a cumulative series
post_latest as (
  select distinct on (external_id)
         external_id, post_id, metric_date, impressions, reach, engagements
    from scoped
   where surface = 'organic' and entity_type = 'post'
   order by external_id, metric_date desc
),
posts as (
  select pl.external_id,
         sp.ref_number,
         sp.media_type,
         pl.post_id is not null as mapped,
         pl.metric_date         as as_at,
         pl.impressions, pl.reach, pl.engagements
    from post_latest pl
    left join scheduled_posts sp on sp.id = pl.post_id
)
select jsonb_build_object(
  'window', jsonb_build_object('since', p_since, 'until', p_until),
  'paid', (select to_jsonb(paid_totals) from paid_totals),
  'paid_campaigns', coalesce(
    (select jsonb_agg(to_jsonb(pc) order by pc.spend desc) from paid_campaigns pc), '[]'::jsonb),
  'organic_account', (select to_jsonb(account_totals) from account_totals),
  'organic_posts', coalesce(
    (select jsonb_agg(to_jsonb(p) order by p.impressions desc nulls last) from posts p), '[]'::jsonb),
  'unmapped_rows', (
    select count(*)::int from scoped
     where entity_type <> 'account' and campaign_id is null and post_id is null),
  'total_rows', (select count(*)::int from scoped)
);
$$;

grant execute on function metrics_period_summary(uuid, date, date) to authenticated, service_role;

comment on function metrics_period_summary(uuid, date, date) is
  'The single definition of period aggregates. Paid sums, cumulative post rows take the latest snapshot, reach reports the best day rather than a sum. Read by both the reporting panels and the commentary agent so they cannot disagree.';;

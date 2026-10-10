-- A figure nobody could fetch is not a figure of zero.
--
-- Every organic ingest on production failed on 6 October with the Instagram
-- account endpoint's own answer:
--
--   (#100) metric[0] must be one of the following values: reach,
--   follower_count, website_clicks, profile_views, online_followers,
--   accounts_engaged, total_interactions, ...
--
-- metric[0] was `views`. The media endpoint accepts it and the account
-- endpoint does not, and asking for it failed the whole call -- so reach and
-- interactions were lost along with it. The runtime now asks the account
-- endpoint only for what it accepts.
--
-- Which leaves account impressions unobtainable per day. The 2024
-- replacement needs metric_type=total_value and returns a period total
-- rather than a daily series, and this table holds daily rows.
--
-- So metrics_daily will carry organic account rows with a null impressions
-- column, and `coalesce(sum(impressions), 0)` turns that into a confident 0.
-- A panel reading "Impressions: 0 — summed across the period" beside a real
-- reach figure says the account was seen by people and shown to nobody,
-- which is not a thing that can happen. The commentary agent is handed the
-- same 0 and told every figure in the summary is usable.
--
-- sum() over all-null is null, which is the true answer: not measured. Both
-- readers are changed to say so. The other totals keep their coalesce,
-- because a window with no paid rows at all genuinely did spend nothing.

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
  -- No coalesce on impressions, and that is the whole point of this
  -- migration: the account endpoint cannot give a daily impressions series,
  -- so null here means "not measured" and 0 would mean "measured as none".
  select sum(impressions)::bigint               as impressions,
         count(impressions)::int                as impression_days,
         coalesce(max(reach), 0)::bigint        as best_day_reach,
         coalesce(sum(engagements), 0)::bigint  as engagements,
         count(distinct metric_date)::int       as days_covered
    from account_rows
),
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
  'The single definition of period aggregates. Paid sums, cumulative post rows take the latest snapshot, reach reports the best day rather than a sum. organic_account.impressions is null when no day carried one -- the Instagram account endpoint has no daily impressions series -- and impression_days says how many did. Read by both the reporting panels and the commentary agent so they cannot disagree.';

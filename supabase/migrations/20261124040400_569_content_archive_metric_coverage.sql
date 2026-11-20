-- Expose underlying provider-row coverage per asset. The attribution view
-- separately uses the latest cumulative snapshot per source and withholds
-- spend when a paid daily row lacks comparable currency evidence.
create view public.content_archive_metric_coverage_v8
with (security_invoker = on)
as
select
  a.client_id,
  a.id as asset_id,
  count(distinct sp.id) as linked_posts,
  count(m.id) as metric_rows,
  count(distinct m.post_id) as posts_with_metrics,
  count(m.id) filter (where m.basis = 'cumulative') as cumulative_rows,
  count(m.impressions) as impression_rows,
  count(m.reach) as reach_rows,
  count(m.clicks) as click_rows,
  count(m.spend) filter (where m.surface='paid' and m.basis='daily') as spend_rows,
  count(distinct nullif(btrim(m.currency), '')) filter (where m.surface='paid' and m.basis='daily' and m.spend is not null) as currency_count,
  count(m.id) filter (where m.surface='paid' and m.basis='daily' and m.spend is not null and nullif(btrim(m.currency), '') is null) as missing_currency_rows,
  max(nullif(btrim(m.currency), '')) filter (where m.surface='paid' and m.basis='daily' and m.spend is not null) as currency,
  min(m.metric_date) as first_metric_date,
  max(m.metric_date) as last_metric_date,
  max(m.fetched_at) as last_fetched_at
from public.client_media_assets a
left join public.scheduled_posts sp
  on sp.asset_id = a.id and sp.client_id = a.client_id
left join public.metrics_daily m
  on m.post_id = sp.id and m.client_id = a.client_id
group by a.client_id, a.id;

comment on view public.content_archive_metric_coverage_v8 is
  'Per-asset linked-post and ingested-metric coverage for Archive reporting. Row presence and freshness do not prove complete provider coverage.';
grant select on public.content_archive_metric_coverage_v8 to authenticated;

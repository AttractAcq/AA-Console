-- A human-reported external ID can be matched to ingested Meta campaign
-- metrics. This is a data match, not a provider identity or activation proof.
create index metrics_daily_paid_campaign_external_v7 on public.metrics_daily
  (client_id,external_id,metric_date desc)
  where surface='paid' and entity_type='campaign';

create view public.paid_operator_metric_match_v7 with (security_invoker=true) as
select b.id as bundle_id,b.client_id,b.campaign_id,b.platform,b.version,
  e.id as reported_event_id,e.external_campaign_id,e.external_ad_id,
  e.reference as reported_reference,e.recorded_at as reported_at,
  case when e.id is null then 'no_external_id_reported'
    when b.platform<>'meta' then 'provider_ingest_unavailable'
    when count(m.id)=0 then 'no_matching_metric_rows'
    else 'metric_rows_match_reported_id' end as match_state,
  count(distinct m.metric_date)::integer as days_with_rows,
  max(m.metric_date) as latest_metric_date,
  max(m.fetched_at) as latest_fetched_at,
  sum(m.spend) as recorded_spend,
  sum(m.impressions) as recorded_impressions,
  sum(m.clicks) as recorded_clicks,
  sum(m.conversions) as recorded_conversions,
  case when count(distinct m.currency)=1
    then max(m.currency) else null end as currency,
  count(distinct m.currency)::integer as currencies_seen
from public.paid_operator_bundles_v7 b
left join lateral (
  select ev.* from public.paid_operator_events_v7 ev
  where ev.bundle_id=b.id and ev.client_id=b.client_id
    and ev.event='external_ids_reported'
  order by ev.recorded_at desc,ev.id desc limit 1
) e on true
left join public.metrics_daily m
  on b.platform='meta' and m.client_id=b.client_id
    and m.surface='paid' and m.entity_type='campaign' and m.basis='daily'
    and m.external_id=e.external_campaign_id
group by b.id,b.client_id,b.campaign_id,b.platform,b.version,
  e.id,e.external_campaign_id,e.external_ad_id,e.reference,e.recorded_at;
revoke all on public.paid_operator_metric_match_v7 from public,anon,authenticated;
grant select on public.paid_operator_metric_match_v7 to authenticated,service_role;
comment on view public.paid_operator_metric_match_v7 is
  'Client-scoped match of a reported Meta campaign ID to metrics_daily rows. Rows can be administratively written and do not prove a live provider account read-back.';

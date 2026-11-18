-- Reconcile the new paid-route operator packet with a recorded read of the
-- configured Google customer. A human-reported ID is never provider evidence.
create view public.paid_google_operator_account_match_v7 with (security_invoker=true) as
select b.id as bundle_id,b.client_id,b.campaign_id,b.platform,b.version,
  e.id as reported_event_id,e.external_campaign_id,e.external_ad_id,
  e.reference as reported_reference,e.recorded_at as reported_at,
  i.google_ads_customer_id as configured_customer_id,
  r.id as read_run_id,r.provider_request_id,r.from_date,r.through_date,
  r.fetched_at as latest_fetched_at,
  c.name as observed_campaign_name,c.status as observed_campaign_status,
  case when e.id is null then 'no_external_id_reported'
    when ic.integration_count>1 then 'multiple_google_accounts_configured'
    when i.google_ads_customer_id is null then 'no_google_account_configured'
    when r.id is null then 'no_current_account_read'
    when c.external_campaign_id is null then 'reported_id_not_observed'
    when not c.metrics_observed then 'provider_campaign_observed_metrics_unknown'
    else 'metric_rows_match_reported_id' end as match_state,
  case when c.metrics_observed then 1 else null::integer end as days_with_rows,
  case when c.metrics_observed then r.through_date else null::date end as latest_metric_date,
  case when c.metrics_observed then c.cost_micros::numeric/1000000 else null::numeric end as recorded_spend,
  case when c.metrics_observed then c.impressions::numeric else null::numeric end as recorded_impressions,
  case when c.metrics_observed then c.clicks::numeric else null::numeric end as recorded_clicks,
  case when c.metrics_observed then c.conversions else null::numeric end as recorded_conversions,
  case when c.metrics_observed then r.currency else null::text end as currency,
  case when c.metrics_observed then 1 else null::integer end as currencies_seen
from public.paid_operator_bundles_v7 b
left join lateral (
  select ev.* from public.paid_operator_events_v7 ev
  where ev.bundle_id=b.id and ev.client_id=b.client_id
    and ev.event='external_ids_reported'
  order by ev.recorded_at desc,ev.id desc limit 1
) e on true
left join lateral (
  select count(*)::integer as integration_count,min(ci.id::text)::uuid as integration_id
  from public.client_integrations ci
  where ci.client_id=b.client_id and ci.provider='google_ads'
) ic on true
left join public.client_integrations i
  on i.id=ic.integration_id and ic.integration_count=1
left join lateral (
  select run.* from public.google_ads_read_runs_v7 run
  where run.client_id=b.client_id and run.integration_id=i.id
    and run.customer_id=i.google_ads_customer_id
    and run.credential_secret_id=i.credential_secret_id
  order by run.fetched_at desc,run.id desc limit 1
) r on true
left join public.google_ads_campaign_reads_v7 c
  on c.run_id=r.id and c.client_id=b.client_id
    and c.external_campaign_id=e.external_campaign_id
where b.platform='google';
revoke all on public.paid_google_operator_account_match_v7
  from public,anon,authenticated;
grant select on public.paid_google_operator_account_match_v7
  to authenticated,service_role;
comment on view public.paid_google_operator_account_match_v7 is
  'Matches a paid Google operator-reported campaign ID only against the latest read of the single currently configured customer and credential. Missing insight rows remain unknown; a stored read is not proof of ad activation or causation.';

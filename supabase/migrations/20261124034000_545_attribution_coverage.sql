-- The funnel's zero totals are observations of recorded rows, not proof that
-- provider spend or lead sources are complete. Expose coverage separately.
create function public.acquisition_coverage_v8(p_client_id uuid,p_days integer default 30)
returns table(
  lead_rows integer,sourced_leads integer,consented_leads integer,
  spend_rows integer,spend_currencies integer,spend_currency text,
  latest_spend_date date,paid_metric_days integer,latest_paid_metric_date date,
  latest_meta_read_at timestamptz,latest_google_read_at timestamptz
)
language plpgsql stable security definer
set search_path=pg_catalog,public as $$
declare v_days integer:=greatest(1,least(coalesce(p_days,30),3650));
begin
  if public.may_manage_client_leads(p_client_id) is not true then
    raise exception 'Not permitted for this client.' using errcode='42501'; end if;
  return query
  with lead_coverage as (
    select count(*)::integer as total,
      count(*) filter(where nullif(btrim(l.source_channel),'') is not null
        or nullif(btrim(l.source),'') is not null
        or l.source_page_id is not null or l.source_asset_id is not null
        or l.source_post_id is not null or l.source_campaign_id is not null
        or l.source_client_campaign_id is not null or l.source_click_id is not null
        or l.source_utm is not null)::integer as sourced,
      count(*) filter(where l.consent_given_at is not null
        and nullif(btrim(l.consent_wording),'') is not null)::integer as consented
    from public.client_leads l where l.client_id=p_client_id
      and l.created_at>=now()-make_interval(days=>v_days)
  ), spend_coverage as (
    select count(*)::integer as total,count(distinct s.currency)::integer as currencies,
      case when count(distinct s.currency)=1 then min(s.currency) end as currency,
      max(s.spent_on) as latest
    from public.client_marketing_spend s where s.client_id=p_client_id
      and s.spent_on>=current_date-v_days
  ), metric_coverage as (
    select count(distinct m.metric_date)::integer as days,max(m.metric_date) as latest
    from public.metrics_daily m where m.client_id=p_client_id
      and m.surface='paid' and m.basis='daily'
      and m.metric_date>=current_date-v_days
  ), meta_current as (
    select max(r.fetched_at) as fetched_at
    from public.meta_ads_read_runs_v7 r
    join public.client_integrations i on i.id=r.integration_id
      and i.client_id=r.client_id and i.provider='meta'
      and i.ad_account_id=r.account_id
      and i.credential_secret_id=r.credential_secret_id
    where r.client_id=p_client_id
  ), google_current as (
    select max(r.fetched_at) as fetched_at
    from public.google_ads_read_runs_v7 r
    join public.client_integrations i on i.id=r.integration_id
      and i.client_id=r.client_id and i.provider='google_ads'
      and i.google_ads_customer_id=r.customer_id
      and i.credential_secret_id=r.credential_secret_id
    where r.client_id=p_client_id
  )
  select l.total,l.sourced,l.consented,s.total,s.currencies,s.currency,s.latest,
    m.days,m.latest,meta.fetched_at,google.fetched_at
  from lead_coverage l cross join spend_coverage s cross join metric_coverage m
    cross join meta_current meta cross join google_current google;
end $$;
revoke all on function public.acquisition_coverage_v8(uuid,integer) from public,anon,authenticated;
grant execute on function public.acquisition_coverage_v8(uuid,integer) to authenticated,service_role;
comment on function public.acquisition_coverage_v8(uuid,integer) is
  'Recorded lead-source, consent, spend and metric coverage plus freshness of current-account provider reads. Does not certify completeness or action execution.';
select public.lock_down_definer_functions();

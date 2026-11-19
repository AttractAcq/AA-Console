-- Keep the old journey signature and the Dashboard's coverage counters
-- consistent with archived-aware reporting. Operating pipeline/action reads
-- remain active-only. Cash-positive archive is still held.
begin;

-- v9 originally called v8. Move its active-row input to a private helper
-- before redirecting v8 to v10, otherwise the compatibility path recurses.
create function public.lead_journey_active_v11(
  p_client_id uuid,p_days integer default 30,p_limit integer default 50)
returns table(
  lead_id uuid,lead_created_at timestamptz,lead_stage text,
  source_channel text,campaign_id uuid,campaign_name text,
  campaign_mode text,opportunity_ids uuid[],offer_version_id uuid,
  asset_id uuid,asset_title text,page_id uuid,page_title text,
  sales_agent_id uuid,sale_value numeric,cash_collected numeric,
  outcome_events integer)
language plpgsql stable security definer
set search_path=pg_catalog,public as $$
declare v_days integer:=greatest(1,least(coalesce(p_days,30),3650));
  v_limit integer:=greatest(1,least(coalesce(p_limit,50),100));
begin
  if public.may_manage_client_leads(p_client_id) is not true then
    raise exception 'Not permitted for this client.' using errcode='42501';
  end if;
  return query
  select l.id,l.created_at,l.stage::text,nullif(btrim(l.source_channel),''),
    c.id,c.name,c.acquisition_mode::text,
    coalesce(opp.ids,array[]::uuid[]),c.offer_version_id,
    a.id,a.title,p.id,p.title,sa.id,
    l.sale_value,l.cash_collected,coalesce(events.total,0)
  from public.client_leads l
  left join public.client_campaigns c on c.id=l.source_client_campaign_id
    and c.client_id=l.client_id
  left join lateral (
    select array_agg(distinct ol.opportunity_id) as ids
    from public.opportunity_links ol where ol.client_id=l.client_id
      and ol.campaign_id=c.id and ol.role='campaign'
  ) opp on true
  left join public.scheduled_posts sp on sp.id=l.source_post_id
    and sp.client_id=l.client_id
  left join public.client_media_assets a
    on a.id=coalesce(l.source_asset_id,sp.asset_id) and a.client_id=l.client_id
  left join public.client_pages p on p.id=l.source_page_id and p.client_id=l.client_id
  left join public.client_sales_agents sa on sa.id=l.source_sales_agent_id
    and sa.client_id=l.client_id
  left join lateral (
    select count(*)::integer as total from public.lead_events e
    where e.lead_id=l.id and e.client_id=l.client_id and e.kind='outcome'
  ) events on true
  where l.client_id=p_client_id and not coalesce(l.is_probe,false)
    and l.created_at>=now()-make_interval(days=>v_days)
  order by l.created_at desc,l.id
  limit v_limit;
end $$;
revoke all on function public.lead_journey_active_v11(uuid,integer,integer)
  from public,anon,authenticated,service_role;

create or replace function public.lead_journey_trace_v9(
  p_client_id uuid,p_days integer default 30,p_limit integer default 50)
returns table(
  lead_id uuid,lead_created_at timestamptz,lead_stage text,
  source_channel text,campaign_id uuid,campaign_name text,
  campaign_mode text,opportunity_ids uuid[],offer_version_id uuid,
  asset_id uuid,asset_title text,page_id uuid,page_title text,
  sales_agent_id uuid,sale_value numeric,cash_collected numeric,
  outcome_events integer,route_package_ids uuid[],
  capture_submissions integer,unknown_route_submissions integer)
language plpgsql stable security definer
set search_path=pg_catalog,public as $$
begin
  return query
  select j.lead_id,j.lead_created_at,j.lead_stage,j.source_channel,
    j.campaign_id,j.campaign_name,j.campaign_mode,j.opportunity_ids,
    j.offer_version_id,j.asset_id,j.asset_title,j.page_id,j.page_title,
    j.sales_agent_id,j.sale_value,j.cash_collected,j.outcome_events,
    coalesce(s.route_ids,array[]::uuid[]),coalesce(s.total,0),coalesce(s.unknown,0)
  from public.lead_journey_active_v11(p_client_id,p_days,p_limit) j
  left join lateral (
    select array_agg(distinct s0.route_package_id)
      filter (where s0.route_package_id is not null) route_ids,
      count(*)::integer total,
      count(*) filter (where s0.route_package_id is null)::integer unknown
    from public.lead_submissions s0
    where s0.client_id=p_client_id and s0.lead_id=j.lead_id
      and s0.status='promoted'
  ) s on true;
end $$;
revoke all on function public.lead_journey_trace_v9(uuid,integer,integer)
  from public,anon,authenticated,service_role;
grant execute on function public.lead_journey_trace_v9(uuid,integer,integer)
  to authenticated,service_role;

create or replace function public.lead_journey_trace_v8(
  p_client_id uuid,p_days integer default 30,p_limit integer default 50)
returns table(
  lead_id uuid,lead_created_at timestamptz,lead_stage text,
  source_channel text,campaign_id uuid,campaign_name text,
  campaign_mode text,opportunity_ids uuid[],offer_version_id uuid,
  asset_id uuid,asset_title text,page_id uuid,page_title text,
  sales_agent_id uuid,sale_value numeric,cash_collected numeric,
  outcome_events integer)
language sql stable security definer
set search_path=pg_catalog,public as $$
  select j.lead_id,j.lead_created_at,j.lead_stage,j.source_channel,
    j.campaign_id,j.campaign_name,j.campaign_mode,j.opportunity_ids,
    j.offer_version_id,j.asset_id,j.asset_title,j.page_id,j.page_title,
    j.sales_agent_id,j.sale_value,j.cash_collected,j.outcome_events
  from public.lead_journey_trace_v10(p_client_id,p_days,p_limit) j;
$$;
revoke all on function public.lead_journey_trace_v8(uuid,integer,integer)
  from public,anon,authenticated,service_role;
grant execute on function public.lead_journey_trace_v8(uuid,integer,integer)
  to authenticated,service_role;
comment on function public.lead_journey_trace_v8(uuid,integer,integer) is
  'Legacy journey signature over current and archived non-probe leads. Use v10 for route and archive coverage.';

create or replace function public.acquisition_coverage_v8(
  p_client_id uuid,p_days integer default 30)
returns table(
  lead_rows integer,sourced_leads integer,consented_leads integer,
  spend_rows integer,spend_currencies integer,spend_currency text,
  latest_spend_date date,paid_metric_days integer,latest_paid_metric_date date,
  latest_meta_read_at timestamptz,latest_google_read_at timestamptz)
language plpgsql stable security definer
set search_path=pg_catalog,public as $$
declare v_days integer:=greatest(1,least(coalesce(p_days,30),3650));
begin
  if public.may_manage_client_leads(p_client_id) is not true then
    raise exception 'Not permitted for this client.' using errcode='42501';
  end if;
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
    from public.reporting_lead_rows_v10(p_client_id) l
    where not coalesce(l.is_probe,false)
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
revoke all on function public.acquisition_coverage_v8(uuid,integer)
  from public,anon,authenticated,service_role;
grant execute on function public.acquisition_coverage_v8(uuid,integer)
  to authenticated,service_role;
comment on function public.acquisition_coverage_v8(uuid,integer) is
  'Non-probe source and consent coverage across current and archived recorded leads, with spend and provider-read freshness. Does not certify completeness or execution.';

select public.lock_down_definer_functions();
commit;

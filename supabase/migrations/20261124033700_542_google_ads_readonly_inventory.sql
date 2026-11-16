-- Google Ads observations have their own identity. metrics_daily has no
-- provider dimension and cannot safely distinguish Meta from Google IDs.
create table public.google_ads_read_runs_v7 (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete restrict,
  integration_id uuid not null references public.client_integrations(id) on delete restrict,
  credential_secret_id uuid not null,
  job_id uuid not null references public.agent_jobs(id) on delete restrict unique,
  customer_id text not null check(customer_id ~ '^[0-9]{10}$'),
  currency text not null check(currency ~ '^[A-Z]{3}$'),
  from_date date not null,
  through_date date not null,
  provider_request_id text not null check(length(btrim(provider_request_id)) between 1 and 200),
  fetched_at timestamptz not null default now(),
  check(from_date<=through_date and through_date<=current_date),
  unique(id,client_id)
);
create index google_ads_read_runs_client_v7 on public.google_ads_read_runs_v7
  (client_id,fetched_at desc);
alter table public.google_ads_read_runs_v7 enable row level security;
create policy google_ads_read_runs_client_v7 on public.google_ads_read_runs_v7
  for select to authenticated using(public.can_access_client(client_id));
revoke all on public.google_ads_read_runs_v7 from public,anon,authenticated;
grant select on public.google_ads_read_runs_v7 to authenticated;
grant all on public.google_ads_read_runs_v7 to service_role;
create trigger google_ads_read_runs_immutable_v7 before update or delete
  on public.google_ads_read_runs_v7 for each row
  execute function public.reject_approval_ledger_mutation_v6();

create table public.google_ads_campaign_reads_v7 (
  run_id uuid not null,
  client_id uuid not null,
  external_campaign_id text not null check(external_campaign_id ~ '^[0-9]+$'),
  name text not null check(length(btrim(name)) between 1 and 500),
  status text not null check(length(btrim(status)) between 1 and 80),
  channel text not null check(length(btrim(channel)) between 1 and 80),
  impressions bigint not null check(impressions>=0),
  clicks bigint not null check(clicks>=0),
  cost_micros bigint not null check(cost_micros>=0),
  conversions numeric(22,10) not null check(conversions>=0),
  primary key(run_id,external_campaign_id),
  foreign key(run_id,client_id) references public.google_ads_read_runs_v7(id,client_id)
    on delete restrict
);
create index google_ads_campaign_reads_client_v7 on public.google_ads_campaign_reads_v7
  (client_id,external_campaign_id);
alter table public.google_ads_campaign_reads_v7 enable row level security;
create policy google_ads_campaign_reads_client_v7 on public.google_ads_campaign_reads_v7
  for select to authenticated using(public.can_access_client(client_id));
revoke all on public.google_ads_campaign_reads_v7 from public,anon,authenticated;
grant select on public.google_ads_campaign_reads_v7 to authenticated;
grant all on public.google_ads_campaign_reads_v7 to service_role;
create trigger google_ads_campaign_reads_immutable_v7 before update or delete
  on public.google_ads_campaign_reads_v7 for each row
  execute function public.reject_approval_ledger_mutation_v6();

create function public.record_google_ads_read_v7(
  p_client_id uuid,p_integration_id uuid,p_credential_secret_id uuid,
  p_job_id uuid,p_customer_id text,
  p_currency text,p_from_date date,p_through_date date,p_request_id text,p_campaigns jsonb)
returns uuid language plpgsql volatile security definer
set search_path=pg_catalog,public as $$
declare i public.client_integrations%rowtype;
  v_run uuid; v_count integer;
begin
  if auth.role()<>'service_role' then
    raise exception 'Internal service required.' using errcode='42501'; end if;
  select * into i from public.client_integrations
    where id=p_integration_id and client_id=p_client_id and provider='google_ads'
    for share;
  if i.id is null or i.google_ads_customer_id is distinct from p_customer_id
    or i.credential_secret_id is distinct from p_credential_secret_id
    or public.integration_usable(p_client_id,'google_ads') is not true
    or public.integration_secret(p_client_id,'google_ads') is null
    or p_currency !~ '^[A-Z]{3}$' or p_from_date is null or p_through_date is null
    or p_from_date>p_through_date or p_through_date>current_date
    or nullif(btrim(p_request_id),'') is null
    or p_campaigns is null or jsonb_typeof(p_campaigns)<>'array'
    or jsonb_array_length(p_campaigns)>5000 then
    raise exception 'Current Google Ads account, credential and bounded read required.'
      using errcode='23514'; end if;
  select count(*) into v_count from public.agent_jobs j
    where j.id=p_job_id and j.client_id=p_client_id and j.agent_key='google_ads_read';
  if v_count<>1 then raise exception 'Matching Google read job required.' using errcode='23514'; end if;
  if exists(select 1 from jsonb_array_elements(p_campaigns) c
    where jsonb_typeof(c)<>'object'
      or coalesce(c->>'id','') !~ '^[0-9]+$'
      or length(btrim(coalesce(c->>'name',''))) not between 1 and 500
      or length(btrim(coalesce(c->>'status',''))) not between 1 and 80
      or length(btrim(coalesce(c->>'channel',''))) not between 1 and 80
      or coalesce(c->>'impressions','') !~ '^[0-9]{1,18}$'
      or coalesce(c->>'clicks','') !~ '^[0-9]{1,18}$'
      or coalesce(c->>'cost_micros','') !~ '^[0-9]{1,18}$'
      or coalesce(c->>'conversions','') !~ '^[0-9]{1,12}(\.[0-9]{1,10})?$')
    or exists(select 1 from jsonb_array_elements(p_campaigns) c
      group by c->>'id' having count(*)>1) then
    raise exception 'Malformed or duplicate Google campaign read.' using errcode='23514'; end if;
  select id into v_run from public.google_ads_read_runs_v7 where job_id=p_job_id;
  if v_run is not null then
    raise exception 'Google read job already recorded.' using errcode='23505'; end if;
  insert into public.google_ads_read_runs_v7
    (client_id,integration_id,credential_secret_id,job_id,customer_id,currency,
      from_date,through_date,provider_request_id)
  values(p_client_id,p_integration_id,p_credential_secret_id,p_job_id,p_customer_id,p_currency,
    p_from_date,p_through_date,btrim(p_request_id)) returning id into v_run;
  insert into public.google_ads_campaign_reads_v7
    (run_id,client_id,external_campaign_id,name,status,channel,
      impressions,clicks,cost_micros,conversions)
  select v_run,p_client_id,c->>'id',c->>'name',c->>'status',c->>'channel',
    (c->>'impressions')::bigint,(c->>'clicks')::bigint,(c->>'cost_micros')::bigint,
    (c->>'conversions')::numeric
  from jsonb_array_elements(p_campaigns) c;
  return v_run;
end $$;
revoke all on function public.record_google_ads_read_v7(
  uuid,uuid,uuid,uuid,text,text,date,date,text,jsonb) from public,anon,authenticated;
grant execute on function public.record_google_ads_read_v7(
  uuid,uuid,uuid,uuid,text,text,date,date,text,jsonb) to service_role;

-- A reported external ID becomes observed only in a read of this client's
-- current recorded Google customer account. No matching row remains unknown.
create view public.google_operator_google_match_v7 with (security_invoker=true) as
select b.id as bundle_id,b.client_id,b.campaign_id,
  e.external_campaign_id as reported_campaign_id,e.recorded_at as reported_at,
  i.google_ads_customer_id as configured_customer_id,
  r.id as read_run_id,r.fetched_at,r.from_date,r.through_date,r.currency,
  c.name as observed_name,c.status as observed_status,c.channel,
  c.impressions,c.clicks,c.cost_micros,c.conversions,
  case when e.id is null then 'no_external_id_reported'
    when i.google_ads_customer_id is null then 'no_google_account_configured'
    when r.id is null then 'no_current_account_read'
    when c.external_campaign_id is null then 'reported_id_not_observed'
    else 'observed_in_google_account' end as match_state
from public.google_operator_bundles_v7 b
left join lateral (select ev.* from public.google_operator_events_v7 ev
  where ev.bundle_id=b.id and ev.client_id=b.client_id
    and ev.event='external_ids_reported'
  order by ev.recorded_at desc,ev.id desc limit 1) e on true
left join public.client_integrations i on i.client_id=b.client_id
  and i.provider='google_ads'
left join lateral (select run.* from public.google_ads_read_runs_v7 run
  where run.client_id=b.client_id and run.integration_id=i.id
    and run.customer_id=i.google_ads_customer_id
    and run.credential_secret_id=i.credential_secret_id
  order by run.fetched_at desc,run.id desc limit 1) r on true
left join public.google_ads_campaign_reads_v7 c on c.run_id=r.id
  and c.client_id=b.client_id and c.external_campaign_id=e.external_campaign_id;
revoke all on public.google_operator_google_match_v7 from public,anon,authenticated;
grant select on public.google_operator_google_match_v7 to authenticated,service_role;

insert into public.agents(agent_key,name,initials,domain,description,requires_upstream)
values('google_ads_read','Google Ads Read','GR',null,
  'Reads the configured Google Ads account and campaign inventory/metrics. Never creates, activates or changes an ad.',
  array[]::text[])
on conflict(agent_key) do update set name=excluded.name,initials=excluded.initials,
  description=excluded.description,requires_upstream=excluded.requires_upstream;
select public.lock_down_definer_functions();

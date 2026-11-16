-- Provider-observed Meta inventory is separate from administratively writable
-- metrics_daily. A complete snapshot binds one granted credential generation.
create table public.meta_ads_read_runs_v7 (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete restrict,
  integration_id uuid not null references public.client_integrations(id) on delete restrict,
  credential_secret_id uuid not null,
  job_id uuid not null references public.agent_jobs(id) on delete restrict unique,
  account_id text not null check(account_id ~ '^act_[0-9]+$'),
  currency text not null check(currency ~ '^[A-Z]{3}$'),
  from_date date not null,
  through_date date not null,
  fetched_at timestamptz not null default now(),
  check(from_date<=through_date and through_date<=current_date),
  unique(id,client_id)
);
create index meta_ads_read_runs_client_v7 on public.meta_ads_read_runs_v7
  (client_id,fetched_at desc);
alter table public.meta_ads_read_runs_v7 enable row level security;
create policy meta_ads_read_runs_client_v7 on public.meta_ads_read_runs_v7
  for select to authenticated using(public.can_access_client(client_id));
revoke all on public.meta_ads_read_runs_v7 from public,anon,authenticated;
grant select on public.meta_ads_read_runs_v7 to authenticated;
grant all on public.meta_ads_read_runs_v7 to service_role;
create trigger meta_ads_read_runs_immutable_v7 before update or delete
  on public.meta_ads_read_runs_v7 for each row
  execute function public.reject_approval_ledger_mutation_v6();

create table public.meta_ads_campaign_reads_v7 (
  run_id uuid not null,
  client_id uuid not null,
  external_campaign_id text not null check(external_campaign_id ~ '^[0-9]+$'),
  name text not null check(length(btrim(name)) between 1 and 500),
  status text not null check(length(btrim(status)) between 1 and 80),
  effective_status text not null check(length(btrim(effective_status)) between 1 and 80),
  impressions bigint not null check(impressions>=0),
  clicks bigint not null check(clicks>=0),
  spend numeric(22,2) not null check(spend>=0),
  actions jsonb not null check(jsonb_typeof(actions)='array'),
  primary key(run_id,external_campaign_id),
  foreign key(run_id,client_id) references public.meta_ads_read_runs_v7(id,client_id)
    on delete restrict
);
create index meta_ads_campaign_reads_client_v7 on public.meta_ads_campaign_reads_v7
  (client_id,external_campaign_id);
alter table public.meta_ads_campaign_reads_v7 enable row level security;
create policy meta_ads_campaign_reads_client_v7 on public.meta_ads_campaign_reads_v7
  for select to authenticated using(public.can_access_client(client_id));
revoke all on public.meta_ads_campaign_reads_v7 from public,anon,authenticated;
grant select on public.meta_ads_campaign_reads_v7 to authenticated;
grant all on public.meta_ads_campaign_reads_v7 to service_role;
create trigger meta_ads_campaign_reads_immutable_v7 before update or delete
  on public.meta_ads_campaign_reads_v7 for each row
  execute function public.reject_approval_ledger_mutation_v6();

create table public.meta_ads_ad_reads_v7 (
  run_id uuid not null,
  client_id uuid not null,
  external_ad_id text not null check(external_ad_id ~ '^[0-9]+$'),
  external_campaign_id text not null check(external_campaign_id ~ '^[0-9]+$'),
  external_adset_id text not null check(external_adset_id ~ '^[0-9]+$'),
  name text not null check(length(btrim(name)) between 1 and 500),
  status text not null check(length(btrim(status)) between 1 and 80),
  effective_status text not null check(length(btrim(effective_status)) between 1 and 80),
  creative_id text check(creative_id ~ '^[0-9]+$'),
  creative_name text,
  impressions bigint not null check(impressions>=0),
  clicks bigint not null check(clicks>=0),
  spend numeric(22,2) not null check(spend>=0),
  actions jsonb not null check(jsonb_typeof(actions)='array'),
  primary key(run_id,external_ad_id),
  foreign key(run_id,client_id) references public.meta_ads_read_runs_v7(id,client_id)
    on delete restrict,
  foreign key(run_id,external_campaign_id)
    references public.meta_ads_campaign_reads_v7(run_id,external_campaign_id)
    on delete restrict
);
create index meta_ads_ad_reads_client_v7 on public.meta_ads_ad_reads_v7
  (client_id,external_campaign_id);
alter table public.meta_ads_ad_reads_v7 enable row level security;
create policy meta_ads_ad_reads_client_v7 on public.meta_ads_ad_reads_v7
  for select to authenticated using(public.can_access_client(client_id));
revoke all on public.meta_ads_ad_reads_v7 from public,anon,authenticated;
grant select on public.meta_ads_ad_reads_v7 to authenticated;
grant all on public.meta_ads_ad_reads_v7 to service_role;
create trigger meta_ads_ad_reads_immutable_v7 before update or delete
  on public.meta_ads_ad_reads_v7 for each row
  execute function public.reject_approval_ledger_mutation_v6();

create function public.record_meta_ads_read_v7(
  p_client_id uuid,p_integration_id uuid,p_credential_secret_id uuid,p_job_id uuid,
  p_account_id text,p_currency text,p_from_date date,p_through_date date,
  p_campaigns jsonb,p_ads jsonb)
returns uuid language plpgsql volatile security definer
set search_path=pg_catalog,public as $$
declare i public.client_integrations%rowtype; v_run uuid;
begin
  if auth.role()<>'service_role' then
    raise exception 'Internal service required.' using errcode='42501'; end if;
  select * into i from public.client_integrations
    where id=p_integration_id and client_id=p_client_id and provider='meta' for share;
  if i.id is null or i.ad_account_id is distinct from p_account_id
    or i.credential_secret_id is distinct from p_credential_secret_id
    or public.integration_usable(p_client_id,'meta') is not true
    or public.integration_secret(p_client_id,'meta') is null
    or p_account_id !~ '^act_[0-9]+$' or p_currency !~ '^[A-Z]{3}$'
    or p_from_date is null or p_through_date is null
    or p_from_date>p_through_date or p_through_date>current_date
    or p_campaigns is null or jsonb_typeof(p_campaigns)<>'array'
    or p_ads is null or jsonb_typeof(p_ads)<>'array'
    or jsonb_array_length(p_campaigns)>5000 or jsonb_array_length(p_ads)>5000 then
    raise exception 'Current Meta account, credential and bounded read required.'
      using errcode='23514'; end if;
  if not exists(select 1 from public.agent_jobs j where j.id=p_job_id
    and j.client_id=p_client_id and j.agent_key='meta_ads_read') then
    raise exception 'Matching Meta read job required.' using errcode='23514'; end if;
  if exists(select 1 from jsonb_array_elements(p_campaigns) c
    where jsonb_typeof(c)<>'object'
      or coalesce(c->>'id','') !~ '^[0-9]+$'
      or length(btrim(coalesce(c->>'name',''))) not between 1 and 500
      or length(btrim(coalesce(c->>'status',''))) not between 1 and 80
      or length(btrim(coalesce(c->>'effective_status',''))) not between 1 and 80
      or coalesce(c->>'impressions','') !~ '^[0-9]{1,18}$'
      or coalesce(c->>'clicks','') !~ '^[0-9]{1,18}$'
      or coalesce(c->>'spend','') !~ '^[0-9]{1,12}(\.[0-9]{1,2})?$'
      or jsonb_typeof(c->'actions') is distinct from 'array')
    or exists(select 1 from jsonb_array_elements(p_campaigns) c
      group by c->>'id' having count(*)>1) then
    raise exception 'Malformed or duplicate Meta campaign read.' using errcode='23514'; end if;
  if exists(select 1 from jsonb_array_elements(p_ads) a
    where jsonb_typeof(a)<>'object'
      or coalesce(a->>'id','') !~ '^[0-9]+$'
      or coalesce(a->>'campaign_id','') !~ '^[0-9]+$'
      or coalesce(a->>'adset_id','') !~ '^[0-9]+$'
      or length(btrim(coalesce(a->>'name',''))) not between 1 and 500
      or length(btrim(coalesce(a->>'status',''))) not between 1 and 80
      or length(btrim(coalesce(a->>'effective_status',''))) not between 1 and 80
      or (a->>'creative_id' is not null and a->>'creative_id' !~ '^[0-9]+$')
      or (a->>'creative_name' is not null and length(a->>'creative_name')>500)
      or coalesce(a->>'impressions','') !~ '^[0-9]{1,18}$'
      or coalesce(a->>'clicks','') !~ '^[0-9]{1,18}$'
      or coalesce(a->>'spend','') !~ '^[0-9]{1,12}(\.[0-9]{1,2})?$'
      or jsonb_typeof(a->'actions') is distinct from 'array'
      or not exists(select 1 from jsonb_array_elements(p_campaigns) c
        where c->>'id'=a->>'campaign_id'))
    or exists(select 1 from jsonb_array_elements(p_ads) a
      group by a->>'id' having count(*)>1) then
    raise exception 'Malformed, duplicate or orphan Meta ad read.' using errcode='23514'; end if;
  if exists(select 1 from public.meta_ads_read_runs_v7 where job_id=p_job_id) then
    raise exception 'Meta read job already recorded.' using errcode='23505'; end if;
  insert into public.meta_ads_read_runs_v7
    (client_id,integration_id,credential_secret_id,job_id,account_id,currency,from_date,through_date)
  values(p_client_id,p_integration_id,p_credential_secret_id,p_job_id,p_account_id,p_currency,
    p_from_date,p_through_date) returning id into v_run;
  insert into public.meta_ads_campaign_reads_v7
    (run_id,client_id,external_campaign_id,name,status,effective_status,
      impressions,clicks,spend,actions)
  select v_run,p_client_id,c->>'id',c->>'name',c->>'status',c->>'effective_status',
    (c->>'impressions')::bigint,(c->>'clicks')::bigint,(c->>'spend')::numeric,c->'actions'
  from jsonb_array_elements(p_campaigns) c;
  insert into public.meta_ads_ad_reads_v7
    (run_id,client_id,external_ad_id,external_campaign_id,external_adset_id,name,status,
      effective_status,creative_id,creative_name,impressions,clicks,spend,actions)
  select v_run,p_client_id,a->>'id',a->>'campaign_id',a->>'adset_id',a->>'name',a->>'status',
    a->>'effective_status',a->>'creative_id',a->>'creative_name',
    (a->>'impressions')::bigint,(a->>'clicks')::bigint,(a->>'spend')::numeric,a->'actions'
  from jsonb_array_elements(p_ads) a;
  return v_run;
end $$;
revoke all on function public.record_meta_ads_read_v7(
  uuid,uuid,uuid,uuid,text,text,date,date,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.record_meta_ads_read_v7(
  uuid,uuid,uuid,uuid,text,text,date,date,jsonb,jsonb) to service_role;

-- Human-reported IDs are observed only in the latest read of the current
-- client account and credential generation, never from shared metric rows.
create view public.meta_operator_account_match_v7 with (security_invoker=true) as
select b.id as bundle_id,b.client_id,b.campaign_id,
  e.external_campaign_id as reported_campaign_id,e.external_ad_id as reported_ad_id,
  e.recorded_at as reported_at,
  i.ad_account_id as configured_account_id,
  r.id as read_run_id,r.fetched_at,r.currency,
  c.name as observed_campaign_name,c.effective_status as observed_campaign_status,
  a.name as observed_ad_name,a.effective_status as observed_ad_status,
  case when e.id is null then 'no_external_id_reported'
    when i.ad_account_id is null then 'no_meta_account_configured'
    when r.id is null then 'no_current_account_read'
    when c.external_campaign_id is null then 'reported_campaign_not_observed'
    when e.external_ad_id is not null and a.external_ad_id is null
      then 'reported_ad_not_observed'
    else 'observed_in_meta_account' end as match_state
from public.paid_operator_bundles_v7 b
left join lateral (select ev.* from public.paid_operator_events_v7 ev
  where ev.bundle_id=b.id and ev.client_id=b.client_id and ev.event='external_ids_reported'
  order by ev.recorded_at desc,ev.id desc limit 1) e on true
left join public.client_integrations i on i.client_id=b.client_id and i.provider='meta'
left join lateral (select run.* from public.meta_ads_read_runs_v7 run
  where run.client_id=b.client_id and run.integration_id=i.id
    and run.account_id=i.ad_account_id and run.credential_secret_id=i.credential_secret_id
  order by run.fetched_at desc,run.id desc limit 1) r on true
left join public.meta_ads_campaign_reads_v7 c on c.run_id=r.id and c.client_id=b.client_id
  and c.external_campaign_id=e.external_campaign_id
left join public.meta_ads_ad_reads_v7 a on a.run_id=r.id and a.client_id=b.client_id
  and a.external_campaign_id=e.external_campaign_id and a.external_ad_id=e.external_ad_id
where b.platform='meta';
revoke all on public.meta_operator_account_match_v7 from public,anon,authenticated;
grant select on public.meta_operator_account_match_v7 to authenticated,service_role;

insert into public.agents(agent_key,name,initials,domain,description,requires_upstream)
values('meta_ads_read','Meta Ads Read','MR',null,
  'Reads the configured Meta ad account campaign and ad inventory with period metrics. Never creates or changes ads.',
  array[]::text[])
on conflict(agent_key) do update set name=excluded.name,initials=excluded.initials,
  description=excluded.description,requires_upstream=excluded.requires_upstream;
select public.lock_down_definer_functions();

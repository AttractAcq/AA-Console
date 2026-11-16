-- Ad-group ads are keyed by provider resource name because one ad ID can occur
-- in more than one ad group. Store the creative and period metrics with the same
-- account-bound run as campaigns; no partial campaign-only run is accepted.
alter table public.google_ads_read_runs_v7 drop constraint google_ads_read_runs_v7_provider_request_id_check;
alter table public.google_ads_read_runs_v7 add constraint google_ads_read_runs_v7_provider_request_id_check
  check(length(btrim(provider_request_id)) between 1 and 500);

create table public.google_ads_ad_reads_v7 (
  run_id uuid not null,
  client_id uuid not null,
  resource_name text not null check(length(resource_name) between 1 and 200),
  external_campaign_id text not null check(external_campaign_id ~ '^[0-9]+$'),
  external_ad_group_id text not null check(external_ad_group_id ~ '^[0-9]+$'),
  external_ad_id text not null check(external_ad_id ~ '^[0-9]+$'),
  status text not null check(length(btrim(status)) between 1 and 80),
  ad_type text not null check(length(btrim(ad_type)) between 1 and 80),
  final_urls jsonb not null check(jsonb_typeof(final_urls)='array'),
  headlines jsonb not null check(jsonb_typeof(headlines)='array'),
  descriptions jsonb not null check(jsonb_typeof(descriptions)='array'),
  impressions bigint not null check(impressions>=0),
  clicks bigint not null check(clicks>=0),
  cost_micros bigint not null check(cost_micros>=0),
  conversions numeric(22,10) not null check(conversions>=0),
  primary key(run_id,resource_name),
  foreign key(run_id,client_id) references public.google_ads_read_runs_v7(id,client_id)
    on delete restrict,
  foreign key(run_id,external_campaign_id)
    references public.google_ads_campaign_reads_v7(run_id,external_campaign_id)
    on delete restrict
);
create index google_ads_ad_reads_client_v7 on public.google_ads_ad_reads_v7
  (client_id,external_campaign_id);
alter table public.google_ads_ad_reads_v7 enable row level security;
create policy google_ads_ad_reads_client_v7 on public.google_ads_ad_reads_v7
  for select to authenticated using(public.can_access_client(client_id));
revoke all on public.google_ads_ad_reads_v7 from public,anon,authenticated;
grant select on public.google_ads_ad_reads_v7 to authenticated;
grant all on public.google_ads_ad_reads_v7 to service_role;
create trigger google_ads_ad_reads_immutable_v7 before update or delete
  on public.google_ads_ad_reads_v7 for each row
  execute function public.reject_approval_ledger_mutation_v6();

-- Retire the campaign-only writer so future reads cannot appear complete with
-- an empty ad snapshot when ads were never requested.
revoke execute on function public.record_google_ads_read_v7(
  uuid,uuid,uuid,uuid,text,text,date,date,text,jsonb) from service_role;
create function public.record_google_ads_full_read_v7(
  p_client_id uuid,p_integration_id uuid,p_credential_secret_id uuid,
  p_job_id uuid,p_customer_id text,
  p_currency text,p_from_date date,p_through_date date,p_request_id text,p_campaigns jsonb,p_ads jsonb)
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
    or jsonb_array_length(p_campaigns)>5000
    or p_ads is null or jsonb_typeof(p_ads)<>'array'
    or jsonb_array_length(p_ads)>5000 then
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
  if exists(select 1 from jsonb_array_elements(p_ads) a
    where jsonb_typeof(a)<>'object'
      or coalesce(a->>'resource_name','') !~
        ('^customers/'||p_customer_id||'/adGroupAds/[0-9]+~[0-9]+$')
      or coalesce(a->>'campaign_id','') !~ '^[0-9]+$'
      or coalesce(a->>'ad_group_id','') !~ '^[0-9]+$'
      or coalesce(a->>'ad_id','') !~ '^[0-9]+$'
      or (a->>'resource_name') is distinct from
        ('customers/'||p_customer_id||'/adGroupAds/'||(a->>'ad_group_id')||'~'||(a->>'ad_id'))
      or length(btrim(coalesce(a->>'status',''))) not between 1 and 80
      or length(btrim(coalesce(a->>'ad_type',''))) not between 1 and 80
      or jsonb_typeof(a->'final_urls') is distinct from 'array'
      or jsonb_typeof(a->'headlines') is distinct from 'array'
      or jsonb_typeof(a->'descriptions') is distinct from 'array'
      or jsonb_array_length(a->'final_urls')>20
      or jsonb_array_length(a->'headlines')>30
      or jsonb_array_length(a->'descriptions')>30
      or exists(select 1 from jsonb_array_elements_text(a->'final_urls') u
        where length(u)>2048 or u !~ '^https?://')
      or exists(select 1 from jsonb_array_elements_text(a->'headlines') h
        where length(btrim(h)) not between 1 and 1000)
      or exists(select 1 from jsonb_array_elements_text(a->'descriptions') d
        where length(btrim(d)) not between 1 and 1000)
      or coalesce(a->>'impressions','') !~ '^[0-9]{1,18}$'
      or coalesce(a->>'clicks','') !~ '^[0-9]{1,18}$'
      or coalesce(a->>'cost_micros','') !~ '^[0-9]{1,18}$'
      or coalesce(a->>'conversions','') !~ '^[0-9]{1,12}(\.[0-9]{1,10})?$'
      or not exists(select 1 from jsonb_array_elements(p_campaigns) c
        where c->>'id'=a->>'campaign_id'))
    or exists(select 1 from jsonb_array_elements(p_ads) a
      group by a->>'resource_name' having count(*)>1) then
    raise exception 'Malformed, duplicate or orphan Google ad read.' using errcode='23514'; end if;
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
  insert into public.google_ads_ad_reads_v7
    (run_id,client_id,resource_name,external_campaign_id,external_ad_group_id,
      external_ad_id,status,ad_type,final_urls,headlines,descriptions,
      impressions,clicks,cost_micros,conversions)
  select v_run,p_client_id,a->>'resource_name',a->>'campaign_id',
    a->>'ad_group_id',a->>'ad_id',a->>'status',a->>'ad_type',
    a->'final_urls',a->'headlines',a->'descriptions',
    (a->>'impressions')::bigint,(a->>'clicks')::bigint,
    (a->>'cost_micros')::bigint,(a->>'conversions')::numeric
  from jsonb_array_elements(p_ads) a;
  return v_run;
end $$;
revoke all on function public.record_google_ads_full_read_v7(
  uuid,uuid,uuid,uuid,text,text,date,date,text,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.record_google_ads_full_read_v7(
  uuid,uuid,uuid,uuid,text,text,date,date,text,jsonb,jsonb) to service_role;
select public.lock_down_definer_functions();

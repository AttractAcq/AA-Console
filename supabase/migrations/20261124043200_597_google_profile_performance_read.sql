-- Read-only Business Profile performance snapshots. A returned dated value
-- with no value is zero; an absent series or absent day remains unknown.
begin;

create table public.google_profile_performance_runs_v8 (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete restrict,
  location_id uuid not null,
  integration_id uuid not null references public.client_integrations(id) on delete restrict,
  credential_secret_id uuid not null,
  job_id uuid not null references public.agent_jobs(id) on delete restrict unique,
  location_ref text not null,
  from_date date not null,
  through_date date not null,
  observed_metrics text[] not null,
  fetched_at timestamptz not null default clock_timestamp(),
  foreign key(location_id,client_id) references public.client_google_locations(id,client_id)
    on delete restrict,
  unique(id,client_id),
  check(from_date<=through_date and through_date<=current_date
    and through_date-from_date<=30)
);
create index google_profile_performance_runs_v8_latest
  on public.google_profile_performance_runs_v8(client_id,location_id,fetched_at desc);
alter table public.google_profile_performance_runs_v8 enable row level security;
create policy google_profile_performance_runs_v8_read
  on public.google_profile_performance_runs_v8 for select to authenticated
  using(public.can_access_client(client_id));
revoke all on public.google_profile_performance_runs_v8
  from public,anon,authenticated,service_role;
grant select on public.google_profile_performance_runs_v8 to authenticated,service_role;
create trigger google_profile_performance_runs_v8_immutable
  before update or delete on public.google_profile_performance_runs_v8
  for each row execute function public.reject_approval_ledger_mutation_v6();

create table public.google_profile_performance_points_v8 (
  run_id uuid not null,
  client_id uuid not null,
  metric text not null check(metric in (
    'BUSINESS_IMPRESSIONS_DESKTOP_MAPS','BUSINESS_IMPRESSIONS_DESKTOP_SEARCH',
    'BUSINESS_IMPRESSIONS_MOBILE_MAPS','BUSINESS_IMPRESSIONS_MOBILE_SEARCH',
    'BUSINESS_DIRECTION_REQUESTS','CALL_CLICKS','WEBSITE_CLICKS')),
  day date not null,
  value bigint not null check(value>=0),
  primary key(run_id,metric,day),
  foreign key(run_id,client_id) references public.google_profile_performance_runs_v8(id,client_id)
    on delete restrict
);
alter table public.google_profile_performance_points_v8 enable row level security;
create policy google_profile_performance_points_v8_read
  on public.google_profile_performance_points_v8 for select to authenticated
  using(public.can_access_client(client_id));
revoke all on public.google_profile_performance_points_v8
  from public,anon,authenticated,service_role;
grant select on public.google_profile_performance_points_v8 to authenticated,service_role;
create trigger google_profile_performance_points_v8_immutable
  before update or delete on public.google_profile_performance_points_v8
  for each row execute function public.reject_approval_ledger_mutation_v6();

-- Historical runs stay readable in their base table. The client page uses
-- only a run still bound to the configured location and credential.
create view public.google_profile_performance_current_v8
with (security_invoker=true) as
select r.* from public.client_google_locations l
join public.client_integrations i on i.client_id=l.client_id
  and i.provider='google_business'
join lateral (
  select run.* from public.google_profile_performance_runs_v8 run
  where run.client_id=l.client_id and run.location_id=l.id
    and run.location_ref=l.location_ref
    and run.integration_id=i.id
    and run.credential_secret_id=i.credential_secret_id
  order by run.fetched_at desc,run.id desc limit 1
) r on true
where l.verification_state='verified';
revoke all on public.google_profile_performance_current_v8
  from public,anon,authenticated,service_role;
grant select on public.google_profile_performance_current_v8
  to authenticated,service_role;

insert into public.agents(agent_key,name,initials,domain,description,requires_upstream)
values('google_profile_metrics_read','Business Profile Performance Read','GPM',null,
  'Reads exact-location Business Profile daily performance; no profile or ad write.',
  array[]::text[])
on conflict(agent_key) do update set name=excluded.name,
  description=excluded.description,requires_upstream=excluded.requires_upstream;

create unique index google_profile_metrics_one_active_v8
  on public.agent_jobs(input_id)
  where agent_key='google_profile_metrics_read' and input_table='client_google_locations'
    and status in ('queued','claimed','running','paused');

create function public.request_google_profile_performance_read_v8(p_location_id uuid)
returns uuid language plpgsql volatile security definer
set search_path=pg_catalog,public as $$
declare l public.client_google_locations%rowtype; v_job uuid;
begin
  if auth.role() is distinct from 'authenticated' or auth.uid() is null
    or public.current_role_of() is null then
    raise exception 'A signed-in client operator is required.' using errcode='42501';
  end if;
  select * into l from public.client_google_locations where id=p_location_id for share;
  if l.id is null or not (coalesce(public.is_admin(),false)
    or coalesce(auth.uid()=public.active_video_approval_manager(l.client_id),false)) then
    raise exception 'Only the client approval owner may request a profile metric read.'
      using errcode='42501';
  end if;
  if l.verification_state<>'verified'
    or l.location_ref !~ '^accounts/[A-Za-z0-9_-]+/locations/[0-9]+$'
    or public.integration_usable(l.client_id,'google_business') is not true then
    raise exception 'A verified numeric location and usable Business Profile connection are required.'
      using errcode='23514';
  end if;
  select id into v_job from public.agent_jobs
    where agent_key='google_profile_metrics_read'
      and input_table='client_google_locations' and input_id=l.id
      and status in ('queued','claimed','running','paused')
    order by created_at desc limit 1;
  if v_job is not null then return v_job; end if;
  insert into public.agent_jobs
    (agent_key,client_id,input_table,input_id,params,created_by)
  values('google_profile_metrics_read',l.client_id,'client_google_locations',l.id,
    '{}'::jsonb,auth.uid())
  on conflict do nothing returning id into v_job;
  if v_job is null then
    select id into v_job from public.agent_jobs
      where agent_key='google_profile_metrics_read'
        and input_table='client_google_locations' and input_id=l.id
        and status in ('queued','claimed','running','paused')
      order by created_at desc limit 1;
  end if;
  return v_job;
end $$;
revoke all on function public.request_google_profile_performance_read_v8(uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.request_google_profile_performance_read_v8(uuid)
  to authenticated;

create function public.record_google_profile_performance_read_v8(
  p_client_id uuid,p_location_id uuid,p_integration_id uuid,
  p_credential_secret_id uuid,p_job_id uuid,p_location_ref text,
  p_from_date date,p_through_date date,p_observed_metrics text[],p_points jsonb)
returns uuid language plpgsql volatile security definer
set search_path=pg_catalog,public as $$
declare l public.client_google_locations%rowtype;
  i public.client_integrations%rowtype; v_run uuid;
  allowed text[] := array[
    'BUSINESS_IMPRESSIONS_DESKTOP_MAPS','BUSINESS_IMPRESSIONS_DESKTOP_SEARCH',
    'BUSINESS_IMPRESSIONS_MOBILE_MAPS','BUSINESS_IMPRESSIONS_MOBILE_SEARCH',
    'BUSINESS_DIRECTION_REQUESTS','CALL_CLICKS','WEBSITE_CLICKS'];
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Internal service required.' using errcode='42501';
  end if;
  select * into l from public.client_google_locations
    where id=p_location_id and client_id=p_client_id for share;
  select * into i from public.client_integrations
    where id=p_integration_id and client_id=p_client_id
      and provider='google_business' for share;
  if l.id is null or i.id is null or l.verification_state<>'verified'
    or l.location_ref is distinct from p_location_ref
    or i.credential_secret_id is distinct from p_credential_secret_id
    or public.integration_usable(p_client_id,'google_business') is not true
    or public.integration_secret(p_client_id,'google_business') is null
    or p_from_date is null or p_through_date is null
    or p_from_date>p_through_date or p_through_date>current_date
    or p_through_date-p_from_date>30
    or not exists(select 1 from public.agent_jobs j where j.id=p_job_id
      and j.client_id=p_client_id and j.agent_key='google_profile_metrics_read'
      and j.input_table='client_google_locations' and j.input_id=p_location_id)
    or p_points is null or jsonb_typeof(p_points)<>'array'
    or jsonb_array_length(p_points)>217 or p_observed_metrics is null
    or cardinality(p_observed_metrics)>7
    or exists(select 1 from unnest(p_observed_metrics) m where m is null or m<>all(allowed))
    or (select count(distinct m) from unnest(p_observed_metrics) m)
      <>cardinality(p_observed_metrics) then
    raise exception 'Current exact-location, credential, job and bounded metrics required.'
      using errcode='23514';
  end if;
  if exists(select 1 from jsonb_array_elements(p_points) p
    where jsonb_typeof(p)<>'object'
      or coalesce(p->>'metric','')<>all(p_observed_metrics)
      or coalesce(p->>'day','') !~ '^\d{4}-\d{2}-\d{2}$'
      or coalesce(p->>'value','') !~ '^(0|[1-9][0-9]{0,17})$'
      or (p->>'day')::date not between p_from_date and p_through_date)
    or exists(select 1 from jsonb_array_elements(p_points) p
      group by p->>'metric',p->>'day' having count(*)>1) then
    raise exception 'Malformed or duplicate Business Profile metric points.'
      using errcode='23514';
  end if;
  if exists(select 1 from public.google_profile_performance_runs_v8
    where job_id=p_job_id) then
    raise exception 'Performance read job already recorded.' using errcode='23505';
  end if;
  insert into public.google_profile_performance_runs_v8
    (client_id,location_id,integration_id,credential_secret_id,job_id,
      location_ref,from_date,through_date,observed_metrics)
  values(p_client_id,p_location_id,p_integration_id,p_credential_secret_id,p_job_id,
    p_location_ref,p_from_date,p_through_date,p_observed_metrics)
  returning id into v_run;
  insert into public.google_profile_performance_points_v8
    (run_id,client_id,metric,day,value)
  select v_run,p_client_id,p->>'metric',(p->>'day')::date,(p->>'value')::bigint
  from jsonb_array_elements(p_points) p;
  return v_run;
end $$;
revoke all on function public.record_google_profile_performance_read_v8(
  uuid,uuid,uuid,uuid,uuid,text,date,date,text[],jsonb)
  from public,anon,authenticated,service_role;
grant execute on function public.record_google_profile_performance_read_v8(
  uuid,uuid,uuid,uuid,uuid,text,date,date,text[],jsonb) to service_role;

select public.lock_down_definer_functions();
commit;

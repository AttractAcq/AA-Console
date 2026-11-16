-- An endpoint binds one exact route version before it can be activated. Older
-- endpoints and submissions remain unknown rather than acquiring a guessed route.
alter table public.lead_capture_endpoints
  add column route_package_id uuid;
alter table public.lead_capture_endpoints
  add constraint lead_capture_endpoint_route_campaign_v9
  foreign key (route_package_id,campaign_id,client_id)
  references public.campaign_route_packages_v6(id,campaign_id,client_id);
alter table public.lead_capture_endpoints
  add constraint lead_capture_endpoint_route_requires_campaign_v9
  check (route_package_id is null or campaign_id is not null);

create function public.guard_lead_capture_route_v9()
returns trigger language plpgsql
set search_path=pg_catalog,public as $$
declare v_route public.campaign_route_packages_v6%rowtype;
  v_campaign public.client_campaigns%rowtype;
begin
  if tg_op='UPDATE' and (
    new.route_package_id is distinct from old.route_package_id
    or new.campaign_id is distinct from old.campaign_id
    or new.client_id is distinct from old.client_id
  ) then
    -- Binding the route is only allowed once, while the endpoint is disabled
    -- and has never accepted a submission. Later retargeting creates a new
    -- endpoint and page revision instead.
    if old.route_package_id is not null or old.enabled or old.submissions <> 0
       or old.revoked_at is not null
       or new.route_package_id is null
       or new.campaign_id is distinct from old.campaign_id
       or new.client_id is distinct from old.client_id then
      raise exception 'Capture endpoint route and ownership are immutable.' using errcode='23514';
    end if;
  end if;
  -- A disabled draft may wait days for a person to approve activation. Check
  -- the package again at that final gate, after any plan or page-link edits.
  -- Existing already-live endpoints are not retargeted by this migration.
  if new.enabled and not old.enabled and new.purpose='page_form'
     and new.campaign_id is not null then
    if new.route_package_id is null or new.page_id is null then
      raise exception 'A campaign page form needs an exact route package before activation.'
        using errcode='23514';
    end if;
    select * into v_route from public.campaign_route_packages_v6
      where id=new.route_package_id and campaign_id=new.campaign_id
        and client_id=new.client_id;
    select * into v_campaign from public.client_campaigns
      where id=new.campaign_id and client_id=new.client_id;
    if v_route.id is null or v_campaign.id is null
       or v_route.version is distinct from (
         select max(version) from public.campaign_route_packages_v6
           where campaign_id=new.campaign_id and route=v_route.route)
       or v_route.plan_fingerprint is distinct from public.campaign_plan_fingerprint(v_campaign)
       or not exists (
         select 1 from public.campaign_artifacts
         where client_id=new.client_id and campaign_id=new.campaign_id
           and page_id=new.page_id and kind='landing_page') then
      raise exception 'Campaign page form route or plan is stale; create a new reviewed form.'
        using errcode='23514';
    end if;
  end if;
  return new;
end $$;
create trigger lead_capture_route_guard_v9
  before update on public.lead_capture_endpoints
  for each row execute function public.guard_lead_capture_route_v9();

-- Keep the familiar generic endpoint API for magnet and agent doors. A page
-- form uses this route-specific API so it cannot be enabled without a known
-- package. Creation and binding occur in one transaction.
create function public.create_route_lead_capture_endpoint_v9(
  p_client_id uuid,p_token_hash text,p_consent_wording text,
  p_campaign_id uuid,p_page_id uuid,p_source_channel text,
  p_route_package_id uuid,p_days integer default 90
) returns public.lead_capture_endpoints
language plpgsql security definer
set search_path=pg_catalog,public as $$
declare v_route public.campaign_route_packages_v6%rowtype;
  v_campaign public.client_campaigns%rowtype;
  v_endpoint public.lead_capture_endpoints%rowtype;
begin
  if p_campaign_id is null or p_page_id is null or p_route_package_id is null then
    raise exception 'A campaign page requires an exact route package.' using errcode='23514';
  end if;
  select * into v_route from public.campaign_route_packages_v6
    where id=p_route_package_id and campaign_id=p_campaign_id and client_id=p_client_id;
  if not found then
    raise exception 'Route package does not match this campaign and client.' using errcode='23514';
  end if;
  select * into v_campaign from public.client_campaigns
    where id=p_campaign_id and client_id=p_client_id;
  if v_route.version is distinct from (
      select max(version) from public.campaign_route_packages_v6
      where campaign_id=p_campaign_id and route=v_route.route)
     or v_route.plan_fingerprint is distinct from public.campaign_plan_fingerprint(v_campaign) then
    raise exception 'Select the current route package for the current plan.' using errcode='23514';
  end if;
  if not exists (
    select 1 from public.campaign_artifacts
    where client_id=p_client_id and campaign_id=p_campaign_id
      and page_id=p_page_id and kind='landing_page'
  ) then
    raise exception 'Page is not linked to this campaign.' using errcode='23514';
  end if;
  v_endpoint:=public.create_lead_capture_endpoint_v6(
    p_client_id,'page_form',p_token_hash,p_consent_wording,
    p_campaign_id,p_page_id,p_source_channel,p_days,500);
  update public.lead_capture_endpoints
    set route_package_id=p_route_package_id where id=v_endpoint.id
    returning * into v_endpoint;
  return v_endpoint;
end $$;
revoke all on function public.create_route_lead_capture_endpoint_v9(uuid,text,text,uuid,uuid,text,uuid,integer)
  from public,anon,authenticated;
grant execute on function public.create_route_lead_capture_endpoint_v9(uuid,text,text,uuid,uuid,text,uuid,integer)
  to authenticated,service_role;

alter table public.lead_submissions add column route_package_id uuid;
alter table public.lead_submissions
  add constraint lead_submission_route_client_v9
  foreign key (route_package_id,client_id)
  references public.campaign_route_packages_v6(id,client_id);
create index lead_submissions_route_v9_idx
  on public.lead_submissions(client_id,route_package_id,created_at desc);

create function public.snapshot_lead_submission_route_v9()
returns trigger language plpgsql
set search_path=pg_catalog,public as $$
declare v_endpoint public.lead_capture_endpoints%rowtype;
begin
  if tg_op='UPDATE' then
    if new.route_package_id is distinct from old.route_package_id
       or new.endpoint_id is distinct from old.endpoint_id
       or new.client_id is distinct from old.client_id then
      raise exception 'Submission capture source is immutable.' using errcode='23514';
    end if;
    return new;
  end if;
  select * into v_endpoint from public.lead_capture_endpoints
    where id=new.endpoint_id and client_id=new.client_id;
  if not found then
    raise exception 'Submission endpoint and client do not match.' using errcode='23514';
  end if;
  new.route_package_id:=v_endpoint.route_package_id;
  return new;
end $$;
create trigger lead_submission_route_snapshot_v9
  before insert or update on public.lead_submissions
  for each row execute function public.snapshot_lead_submission_route_v9();

-- The route is evidence of the capture door, not proof that this route caused
-- a sale. A deduplicated lead can have multiple submissions and routes.
create function public.lead_journey_trace_v9(
  p_client_id uuid,p_days integer default 30,p_limit integer default 50)
returns table(
  lead_id uuid,lead_created_at timestamptz,lead_stage text,
  source_channel text,campaign_id uuid,campaign_name text,campaign_mode text,
  opportunity_ids uuid[],offer_version_id uuid,asset_id uuid,asset_title text,
  page_id uuid,page_title text,sales_agent_id uuid,
  sale_value numeric,cash_collected numeric,outcome_events integer,
  route_package_ids uuid[],capture_submissions integer,unknown_route_submissions integer
) language plpgsql stable security definer
set search_path=pg_catalog,public as $$
begin
  -- v8 performs the same client lead-read authorization and window clamp.
  return query
  select j.lead_id,j.lead_created_at,j.lead_stage,j.source_channel,
    j.campaign_id,j.campaign_name,j.campaign_mode,j.opportunity_ids,
    j.offer_version_id,j.asset_id,j.asset_title,j.page_id,j.page_title,
    j.sales_agent_id,j.sale_value,j.cash_collected,j.outcome_events,
    coalesce(s.route_ids,array[]::uuid[]),coalesce(s.total,0),coalesce(s.unknown,0)
  from public.lead_journey_trace_v8(p_client_id,p_days,p_limit) j
  left join lateral (
    select array_agg(distinct s0.route_package_id) filter (where s0.route_package_id is not null) route_ids,
      count(*)::integer total,
      count(*) filter (where s0.route_package_id is null)::integer unknown
    from public.lead_submissions s0
    where s0.client_id=p_client_id and s0.lead_id=j.lead_id and s0.status='promoted'
  ) s on true;
end $$;
revoke all on function public.lead_journey_trace_v9(uuid,integer,integer)
  from public,anon,authenticated;
grant execute on function public.lead_journey_trace_v9(uuid,integer,integer)
  to authenticated,service_role;
select public.lock_down_definer_functions();

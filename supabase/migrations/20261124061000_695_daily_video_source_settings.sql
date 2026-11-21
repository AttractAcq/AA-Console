-- Prepare exact organic route and supported model sources for the code-video
-- daily package. This does not change the v5 planner or enable any worker.
create table public.client_daily_video_sources_v1 (
  client_id uuid primary key references public.clients(id) on delete cascade,
  campaign_id uuid not null,
  route_package_id uuid not null,
  model_record_ids uuid[] not null,
  review_snapshot jsonb not null check (jsonb_typeof(review_snapshot) = 'array'),
  source_digest text not null check (source_digest ~ '^[0-9a-f]{64}$'),
  configured_at timestamptz not null default clock_timestamp(),
  foreign key (route_package_id, campaign_id, client_id)
    references public.campaign_route_packages_v6(id, campaign_id, client_id)
    on delete restrict,
  check (cardinality(model_record_ids) between 1 and 12),
  check (jsonb_array_length(review_snapshot) between 1 and 12)
);

alter table public.client_daily_video_sources_v1 enable row level security;
create policy client_daily_video_sources_read_v1
  on public.client_daily_video_sources_v1 for select to authenticated
  using (public.can_access_client(client_id));
revoke all on public.client_daily_video_sources_v1
  from public, anon, authenticated, service_role;
grant select on public.client_daily_video_sources_v1 to authenticated, service_role;

create function public.configure_daily_video_sources_v1(
  p_client_id uuid, p_route_package_id uuid, p_record_ids uuid[]
) returns jsonb language plpgsql volatile security definer
set search_path=pg_catalog,public as $$
declare
  settings public.client_daily_package_settings%rowtype;
  route public.campaign_route_packages_v6%rowtype;
  campaign public.client_campaigns%rowtype;
  source_record public.client_agent_records%rowtype;
  review record;
  ids uuid[];
  snapshot jsonb := '[]'::jsonb;
  digest text;
  count_seen integer := 0;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Service daily video configuration only.' using errcode='42501';
  end if;
  if p_client_id is null or p_route_package_id is null
    or p_record_ids is null or cardinality(p_record_ids) not between 1 and 12
    or exists(select 1 from unnest(p_record_ids) as item(id) where id is null)
    or cardinality(p_record_ids)<>(select count(distinct id)
      from unnest(p_record_ids) as item(id)) then
    raise exception 'Choose one current organic route and 1–12 distinct model sources.'
      using errcode='22023';
  end if;
  select * into settings from public.client_daily_package_settings
    where client_id=p_client_id for update;
  select * into route from public.campaign_route_packages_v6
    where id=p_route_package_id and client_id=p_client_id;
  select * into campaign from public.client_campaigns
    where id=route.campaign_id and client_id=p_client_id for share;
  if settings.client_id is null or route.id is null or campaign.id is null
    or settings.campaign_id is distinct from campaign.id
    or route.route is distinct from 'organic'
    or campaign.status in ('cancelled','complete')
    or route.plan_fingerprint is distinct from
      public.campaign_plan_fingerprint(campaign)
    or route.version<>(select max(version)
      from public.campaign_route_packages_v6 newer
      where newer.campaign_id=route.campaign_id and newer.route='organic') then
    raise exception 'Daily video requires the settings campaign current organic route.'
      using errcode='23514';
  end if;
  select array_agg(id order by id) into ids
    from unnest(p_record_ids) as item(id);
  for source_record in select * from public.client_agent_records
      where id=any(ids) order by id for share loop
    select * into review from public.model_section_review_state_v7
      where record_id=source_record.id and client_id=p_client_id;
    if not found or source_record.client_id<>p_client_id
      or review.review_state is distinct from 'supported'
      or review.review_id is null or review.record_hash is null
      or nullif(btrim(coalesce(source_record.body,'')),'') is null
      or length(source_record.body)>4000 then
      raise exception 'Every daily video model source must be current and supported.'
        using errcode='23514';
    end if;
    count_seen:=count_seen+1;
    snapshot:=snapshot||jsonb_build_array(jsonb_build_object(
      'record_id',source_record.id,'review_id',review.review_id,
      'record_hash',review.record_hash));
  end loop;
  if count_seen<>cardinality(ids) then
    raise exception 'A daily video model source is missing or belongs to another client.'
      using errcode='23514';
  end if;
  digest:=encode(sha256(convert_to(snapshot::text,'UTF8')),'hex');
  insert into public.client_daily_video_sources_v1
    (client_id,campaign_id,route_package_id,model_record_ids,
      review_snapshot,source_digest,configured_at)
  values(p_client_id,campaign.id,route.id,ids,snapshot,digest,clock_timestamp())
  on conflict(client_id) do update set
    campaign_id=excluded.campaign_id,
    route_package_id=excluded.route_package_id,
    model_record_ids=excluded.model_record_ids,
    review_snapshot=excluded.review_snapshot,
    source_digest=excluded.source_digest,
    configured_at=excluded.configured_at;
  return jsonb_build_object('client_id',p_client_id,
    'campaign_id',campaign.id,'route_package_id',route.id,
    'source_digest',digest,'source_count',count_seen);
end $$;
revoke all on function public.configure_daily_video_sources_v1(uuid,uuid,uuid[])
  from public,anon,authenticated,service_role;
grant execute on function public.configure_daily_video_sources_v1(uuid,uuid,uuid[])
  to service_role;
comment on function public.configure_daily_video_sources_v1(uuid,uuid,uuid[]) is
  'Prepares current organic route and supported model-source IDs for a future daily code-video planner; never queues a project or enables an Engine.';

-- A saved configuration is not a permanent clearance. The future planner and
-- execution gate call this after reading settings and before any new work.
create function public.daily_video_sources_current_v1(p_client_id uuid)
returns boolean language plpgsql stable security definer
set search_path=pg_catalog,public as $$
declare
  settings public.client_daily_package_settings%rowtype;
  configured public.client_daily_video_sources_v1%rowtype;
  route public.campaign_route_packages_v6%rowtype;
  campaign public.client_campaigns%rowtype;
  entry jsonb;
  source_record public.client_agent_records%rowtype;
  review record;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Service daily video source check only.' using errcode='42501';
  end if;
  select * into settings from public.client_daily_package_settings
    where client_id=p_client_id;
  select * into configured from public.client_daily_video_sources_v1
    where client_id=p_client_id;
  if settings.client_id is null or configured.client_id is null
    or settings.campaign_id is distinct from configured.campaign_id
    or configured.source_digest is distinct from
      encode(sha256(convert_to(configured.review_snapshot::text,'UTF8')),'hex')
    or cardinality(configured.model_record_ids) is distinct from
      jsonb_array_length(configured.review_snapshot) then
    return false;
  end if;
  select * into route from public.campaign_route_packages_v6
    where id=configured.route_package_id
      and campaign_id=configured.campaign_id and client_id=p_client_id;
  select * into campaign from public.client_campaigns
    where id=configured.campaign_id and client_id=p_client_id;
  if route.id is null or campaign.id is null
    or route.route is distinct from 'organic'
    or campaign.status in ('cancelled','complete')
    or route.plan_fingerprint is distinct from
      public.campaign_plan_fingerprint(campaign)
    or route.version<>(select max(version)
      from public.campaign_route_packages_v6 newer
      where newer.campaign_id=route.campaign_id and newer.route='organic') then
    return false;
  end if;
  for entry in select value from jsonb_array_elements(configured.review_snapshot) loop
    if entry->>'record_id' is null
      or (entry->>'record_id')::uuid<>all(configured.model_record_ids) then
      return false;
    end if;
    select * into source_record from public.client_agent_records
      where id=(entry->>'record_id')::uuid and client_id=p_client_id;
    select * into review from public.model_section_review_state_v7
      where record_id=source_record.id and client_id=p_client_id;
    if source_record.id is null or not found
      or review.review_state is distinct from 'supported'
      or review.review_id::text is distinct from entry->>'review_id'
      or review.record_hash is distinct from entry->>'record_hash' then
      return false;
    end if;
  end loop;
  return true;
end $$;
revoke all on function public.daily_video_sources_current_v1(uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.daily_video_sources_current_v1(uuid)
  to service_role;
comment on function public.daily_video_sources_current_v1(uuid) is
  'Rechecks saved daily code-video route and exact model reviews; a true result is valid only at this read, not a durable approval.';

-- Freeze the actual research used by one planner job. A retry reuses its
-- original snapshot, even if the underlying client records changed.
create table public.campaign_intelligence_snapshots (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null,
  campaign_id uuid not null,
  planner_job_id uuid not null unique,
  brief text not null,
  acquisition_mode text not null check (acquisition_mode in ('organic', 'paid')),
  paid_platform text,
  business_context jsonb not null check (jsonb_typeof(business_context) = 'object'),
  source_records jsonb not null check (jsonb_typeof(source_records) = 'array'),
  content_pillars jsonb not null check (jsonb_typeof(content_pillars) = 'array'),
  missing_domains text[] not null default '{}',
  snapshot_hash text not null check (snapshot_hash ~ '^[0-9a-f]{32}$'),
  captured_at timestamptz not null default now(),
  foreign key (campaign_id, client_id)
    references public.client_campaigns(id, client_id) on delete cascade,
  check ((acquisition_mode = 'paid' and paid_platform in ('meta', 'google'))
    or (acquisition_mode = 'organic' and paid_platform is null)),
  unique (id, campaign_id, client_id)
);

create table public.campaign_manifest_intelligence (
  manifest_id uuid primary key,
  campaign_id uuid not null,
  client_id uuid not null,
  snapshot_id uuid not null,
  foreign key (manifest_id, campaign_id, client_id)
    references public.campaign_manifest_versions(id, campaign_id, client_id) on delete cascade,
  foreign key (snapshot_id, campaign_id, client_id)
    references public.campaign_intelligence_snapshots(id, campaign_id, client_id) on delete restrict
);

create function public.guard_campaign_intelligence_snapshot_immutable()
returns trigger language plpgsql as $$
begin
  raise exception 'Campaign intelligence snapshots are immutable. Replan to capture new research.';
end;
$$;
create trigger campaign_intelligence_snapshots_immutable
  before update on public.campaign_intelligence_snapshots
  for each row execute function public.guard_campaign_intelligence_snapshot_immutable();
create trigger campaign_manifest_intelligence_immutable
  before update on public.campaign_manifest_intelligence
  for each row execute function public.guard_campaign_intelligence_snapshot_immutable();

alter table public.campaign_intelligence_snapshots enable row level security;
alter table public.campaign_manifest_intelligence enable row level security;
create policy campaign_intelligence_snapshots_read on public.campaign_intelligence_snapshots
  for select to authenticated using (
    public.is_admin() or auth.uid() = public.active_video_approval_manager(client_id)
  );
create policy campaign_manifest_intelligence_read on public.campaign_manifest_intelligence
  for select to authenticated using (
    public.is_admin() or auth.uid() = public.active_video_approval_manager(client_id)
  );
grant select on public.campaign_intelligence_snapshots,
  public.campaign_manifest_intelligence to authenticated;

create function public.capture_campaign_intelligence_snapshot_v6(
  p_campaign_id uuid, p_job_id uuid
) returns public.campaign_intelligence_snapshots
language plpgsql volatile security definer
set search_path = pg_catalog, public
set timezone = 'UTC'
as $$
declare
  c public.client_campaigns%rowtype;
  v_context jsonb;
  v_records jsonb;
  v_pillars jsonb;
  v_missing text[];
  v_snapshot public.campaign_intelligence_snapshots%rowtype;
  v_material jsonb;
begin
  if auth.role() <> 'service_role' then raise exception 'Service role required.'; end if;
  select * into v_snapshot from public.campaign_intelligence_snapshots
    where planner_job_id = p_job_id;
  if found then
    if v_snapshot.campaign_id is distinct from p_campaign_id then
      raise exception 'Planner job already belongs to another campaign.';
    end if;
    return v_snapshot;
  end if;
  select * into c from public.client_campaigns where id = p_campaign_id;
  if not found or c.acquisition_mode not in ('organic', 'paid') then
    raise exception 'A route-bound campaign is required.';
  end if;
  if not exists (select 1 from public.agent_jobs j
    where j.id = p_job_id and j.input_table = 'client_campaigns'
      and j.input_id = c.id and j.agent_key = 'campaign_plan') then
    raise exception 'A matching campaign planner job is required.';
  end if;
  select coalesce(jsonb_build_object(
    'business_overview', b.business_overview,
    'ideal_customer', b.ideal_customer,
    'main_offer', b.main_offer,
    'competitors', b.competitors,
    'brand_voice', b.brand_voice,
    'proof_testimonials', b.proof_testimonials,
    'current_marketing', b.current_marketing,
    'sales_process', b.sales_process,
    'current_revenue', b.current_revenue,
    'target_revenue', b.target_revenue,
    'updated_at', b.updated_at
  ), '{}'::jsonb) into v_context
  from public.client_business_context b where b.client_id = c.client_id;
  v_context := coalesce(v_context, '{}'::jsonb);

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', r.id, 'domain', r.domain, 'item_key', r.item_key,
    'title', r.title, 'body', r.body, 'updated_at', r.updated_at
  ) order by r.domain, r.display_order, r.id), '[]'::jsonb)
  into v_records
  from public.client_agent_records r
  where r.client_id = c.client_id
    and r.domain::text in (
      'offer_strategy', 'icp', 'brand_strategy', 'money_model',
      'market', 'competitor', 'association', 'campaign_intel')
    and nullif(btrim(r.body), '') is not null;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', p.id, 'name', p.name, 'premise', p.premise,
    'belongs', p.belongs, 'does_not_belong', p.does_not_belong
  ) order by p.id), '[]'::jsonb)
  into v_pillars
  from public.campaign_content_pillars cp
  join public.client_content_pillars p on p.id = cp.pillar_id
  where cp.campaign_id = c.id;

  select coalesce(array_agg(domain), '{}'::text[]) into v_missing
  from unnest(array[
    'offer_strategy', 'icp', 'brand_strategy', 'money_model',
    'market', 'competitor', 'campaign_intel'
  ]) as domain
  where not exists (
    select 1 from jsonb_array_elements(v_records) r where r->>'domain' = domain
  );
  if v_context = '{}'::jsonb then
    v_missing := array_append(v_missing, 'business_context');
  end if;
  v_material := jsonb_build_object(
    'brief', c.brief, 'acquisition_mode', c.acquisition_mode,
    'paid_platform', c.paid_platform, 'business_context', v_context,
    'source_records', v_records, 'content_pillars', v_pillars
  );
  insert into public.campaign_intelligence_snapshots (
    client_id, campaign_id, planner_job_id, brief,
    acquisition_mode, paid_platform, business_context,
    source_records, content_pillars, missing_domains, snapshot_hash
  ) values (
    c.client_id, c.id, p_job_id, c.brief,
    c.acquisition_mode, c.paid_platform, v_context,
    v_records, v_pillars, v_missing, md5(v_material::text)
  ) returning * into v_snapshot;
  return v_snapshot;
end;
$$;

create function public.attach_campaign_manifest_intelligence_v6(
  p_manifest_id uuid, p_snapshot_id uuid
) returns void
language plpgsql volatile security definer
set search_path = pg_catalog, public
as $$
declare
  v_manifest public.campaign_manifest_versions%rowtype;
  v_snapshot public.campaign_intelligence_snapshots%rowtype;
  v_existing uuid;
begin
  if auth.role() <> 'service_role' then raise exception 'Service role required.'; end if;
  select * into v_manifest from public.campaign_manifest_versions where id = p_manifest_id;
  select * into v_snapshot from public.campaign_intelligence_snapshots where id = p_snapshot_id;
  if v_manifest.id is null or v_snapshot.id is null
    or v_manifest.campaign_id <> v_snapshot.campaign_id
    or v_manifest.client_id <> v_snapshot.client_id
    or v_manifest.plan_snapshot->>'acquisition_mode' <> v_snapshot.acquisition_mode
    or v_manifest.plan_snapshot->>'paid_platform' is distinct from v_snapshot.paid_platform then
    raise exception 'Intelligence snapshot does not match this campaign package.';
  end if;
  select snapshot_id into v_existing from public.campaign_manifest_intelligence
    where manifest_id = p_manifest_id;
  if found then
    if v_existing <> p_snapshot_id then
      raise exception 'Campaign package already uses another intelligence snapshot.';
    end if;
    return;
  end if;
  insert into public.campaign_manifest_intelligence (
    manifest_id, campaign_id, client_id, snapshot_id
  ) values (
    v_manifest.id, v_manifest.campaign_id, v_manifest.client_id, v_snapshot.id
  );
end;
$$;

revoke all on function public.capture_campaign_intelligence_snapshot_v6(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.capture_campaign_intelligence_snapshot_v6(uuid, uuid)
  to service_role;
revoke all on function public.attach_campaign_manifest_intelligence_v6(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.attach_campaign_manifest_intelligence_v6(uuid, uuid)
  to service_role;

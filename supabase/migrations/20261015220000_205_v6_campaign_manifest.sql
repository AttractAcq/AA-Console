-- A versioned acquisition package is a plan, not evidence of readiness.
-- Actual artifact versions, QA, approvals and activation belong to later
-- module-specific evidence records tied to one of these immutable versions.
create table public.campaign_manifest_versions (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null,
  client_id uuid not null,
  version integer not null check (version > 0),
  idempotency_key text not null check (length(btrim(idempotency_key)) between 1 and 160),
  acquisition_mode text not null check (acquisition_mode in ('organic', 'paid')),
  paid_platform text,
  plan_snapshot jsonb not null check (jsonb_typeof(plan_snapshot) = 'object'),
  plan_hash text not null check (plan_hash ~ '^[0-9a-f]{32}$'),
  created_at timestamptz not null default now(),
  foreign key (campaign_id, client_id)
    references public.client_campaigns (id, client_id) on delete cascade,
  check ((acquisition_mode = 'paid' and paid_platform in ('meta', 'google'))
    or (acquisition_mode = 'organic' and paid_platform is null)),
  unique (campaign_id, version),
  unique (campaign_id, idempotency_key),
  unique (id, client_id)
);

create table public.campaign_manifest_items (
  manifest_id uuid not null references public.campaign_manifest_versions(id) on delete cascade,
  item_key text not null check (item_key in (
    'intelligence', 'offer', 'proof', 'creative', 'website', 'lead_magnet',
    'sales_path', 'proof_distribution', 'distribution', 'attribution'
  )),
  module_key text not null check (module_key in (
    'intelligence_os', 'offer_studio', 'proof_production_factory',
    'content_production_factory', 'website_studio', 'lead_magnet_studio',
    'sales_os', 'proof_distribution', 'content_distribution',
    'meta_ads_studio', 'google_ads_studio', 'attribution_os'
  )),
  required boolean not null,
  depends_on text[] not null default '{}',
  external_activation boolean not null default false,
  primary key (manifest_id, item_key),
  check (not item_key = any(depends_on))
);

create index campaign_manifest_versions_client_idx
  on public.campaign_manifest_versions (client_id, created_at desc);

create function public.guard_campaign_manifest_immutable()
returns trigger language plpgsql as $$
begin
  raise exception 'Campaign manifest versions are immutable. Create a new version.';
end;
$$;
create trigger campaign_manifest_versions_immutable
  before update on public.campaign_manifest_versions
  for each row execute function public.guard_campaign_manifest_immutable();
create trigger campaign_manifest_items_immutable
  before update on public.campaign_manifest_items
  for each row execute function public.guard_campaign_manifest_immutable();

alter table public.campaign_manifest_versions enable row level security;
alter table public.campaign_manifest_items enable row level security;
create policy campaign_manifest_versions_read on public.campaign_manifest_versions
  for select to authenticated using (public.can_access_client(client_id));
create policy campaign_manifest_items_read on public.campaign_manifest_items
  for select to authenticated using (exists (
    select 1 from public.campaign_manifest_versions v
    where v.id = manifest_id and public.can_access_client(v.client_id)
  ));
grant select on public.campaign_manifest_versions, public.campaign_manifest_items
  to authenticated;

create function public.create_campaign_manifest_v6(
  p_campaign_id uuid,
  p_idempotency_key text,
  p_needs_lead_magnet boolean default false
) returns public.campaign_manifest_versions
language plpgsql volatile security definer
set search_path = pg_catalog, public
set timezone = 'UTC'
as $$
declare
  c public.client_campaigns%rowtype;
  v_snapshot jsonb;
  v_hash text;
  v_version public.campaign_manifest_versions%rowtype;
  v_website_required boolean;
  v_activation_module text;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Service role required to version a campaign package.';
  end if;
  if p_idempotency_key is null or length(btrim(p_idempotency_key)) not between 1 and 160
     or p_needs_lead_magnet is null then
    raise exception 'A key and explicit magnet choice are required.';
  end if;
  select * into c from public.client_campaigns where id = p_campaign_id for update;
  if not found then raise exception 'Campaign not found.'; end if;
  if c.acquisition_mode not in ('organic', 'paid') or c.built_at is null
     or nullif(btrim(c.objective), '') is null
     or nullif(btrim(c.audience), '') is null then
    raise exception 'A route-bound, built campaign plan with objective and audience is required.';
  end if;
  v_website_required := c.acquisition_mode = 'paid' or c.needs_landing_page
    or p_needs_lead_magnet;
  v_activation_module := case
    when c.acquisition_mode = 'organic' then 'content_distribution'
    when c.paid_platform = 'meta' then 'meta_ads_studio'
    else 'google_ads_studio' end;
  v_snapshot := jsonb_build_object(
    'campaign_id', c.id, 'client_id', c.client_id,
    'acquisition_mode', c.acquisition_mode, 'paid_platform', c.paid_platform,
    'built_at', c.built_at, 'objective', c.objective, 'audience', c.audience,
    'offer_summary', c.offer_summary, 'core_message', c.core_message,
    'channels', c.channels, 'budget', c.budget,
    'starts_on', c.starts_on, 'ends_on', c.ends_on,
    'kpi_metric', c.kpi_metric, 'kpi_target', c.kpi_target,
    'content_count', c.content_count,
    'needs_landing_page', v_website_required,
    'needs_lead_magnet', p_needs_lead_magnet,
    'needs_sales_agent', c.needs_sales_agent
  );
  -- The legacy plan saver refreshes built_at on an idempotent retry. Its
  -- timestamp is evidence of the save, not a change to the plan content.
  v_hash := md5((v_snapshot - 'built_at')::text);
  select * into v_version from public.campaign_manifest_versions
    where campaign_id = c.id and idempotency_key = btrim(p_idempotency_key);
  if found then
    if v_version.plan_hash <> v_hash then
      raise exception 'Idempotency key already belongs to a different campaign package.';
    end if;
    return v_version;
  end if;
  insert into public.campaign_manifest_versions (
    campaign_id, client_id, version, idempotency_key,
    acquisition_mode, paid_platform, plan_snapshot, plan_hash
  ) values (
    c.id, c.client_id,
    coalesce((select max(version) + 1 from public.campaign_manifest_versions
      where campaign_id = c.id), 1),
    btrim(p_idempotency_key), c.acquisition_mode, c.paid_platform,
    v_snapshot, v_hash
  ) returning * into v_version;

  insert into public.campaign_manifest_items (
    manifest_id, item_key, module_key, required, depends_on, external_activation
  ) values
    (v_version.id, 'intelligence', 'intelligence_os', true, '{}', false),
    (v_version.id, 'offer', 'offer_studio', true, '{intelligence}', false),
    (v_version.id, 'proof', 'proof_production_factory', true, '{intelligence}', false),
    (v_version.id, 'creative', 'content_production_factory', true, '{offer,proof}', false),
    (v_version.id, 'website', 'website_studio', v_website_required, '{offer,proof}', true),
    (v_version.id, 'lead_magnet', 'lead_magnet_studio', p_needs_lead_magnet,
      '{offer,website}', true),
    (v_version.id, 'sales_path', 'sales_os', true,
      case when v_website_required then '{website}'::text[] else '{offer}'::text[] end,
      true),
    (v_version.id, 'proof_distribution', 'proof_distribution', true, '{proof}', true),
    (v_version.id, 'distribution', v_activation_module, true,
      case when v_website_required then '{creative,website,sales_path}'::text[]
        else '{creative,sales_path}'::text[] end, true),
    (v_version.id, 'attribution', 'attribution_os', true,
      '{distribution,sales_path}'::text[], false);
  return v_version;
end;
$$;

revoke all on function public.create_campaign_manifest_v6(uuid, text, boolean)
  from public, anon, authenticated;
grant execute on function public.create_campaign_manifest_v6(uuid, text, boolean)
  to service_role;

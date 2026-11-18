-- Coordinate the two routes through the existing immutable v6 plan boundary.
-- Old single-route manifests keep their shape and idempotency hashes. The
-- paid route remains separately held by its own executor and approval gates.

alter table public.campaign_intelligence_snapshots
  drop constraint campaign_intelligence_snapshots_acquisition_mode_check,
  drop constraint campaign_intelligence_snapshots_check;
alter table public.campaign_intelligence_snapshots
  add constraint campaign_intelligence_snapshots_acquisition_mode_check
    check (acquisition_mode in ('organic','paid','both')),
  add constraint campaign_intelligence_snapshots_route_check
    check ((acquisition_mode='organic' and paid_platform is null)
      or (acquisition_mode in ('paid','both') and paid_platform in ('meta','google')));

alter table public.campaign_manifest_versions
  drop constraint campaign_manifest_versions_acquisition_mode_check,
  drop constraint campaign_manifest_versions_check;
alter table public.campaign_manifest_versions
  add constraint campaign_manifest_versions_acquisition_mode_check
    check (acquisition_mode in ('organic','paid','both')),
  add constraint campaign_manifest_versions_route_check
    check ((acquisition_mode='organic' and paid_platform is null)
      or (acquisition_mode in ('paid','both') and paid_platform in ('meta','google')));

alter table public.campaign_manifest_items
  drop constraint campaign_manifest_items_item_key_check;
alter table public.campaign_manifest_items
  add constraint campaign_manifest_items_item_key_check check (item_key in (
    'intelligence','offer','proof','creative','website','lead_magnet',
    'sales_path','proof_distribution','distribution','paid_distribution','attribution'
  ));

create or replace function public.capture_campaign_intelligence_snapshot_v6(
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
  if not found or c.acquisition_mode not in ('organic', 'paid', 'both') then
    raise exception 'A route-bound campaign is required.';
  end if;
  if not exists (select 1 from public.agent_jobs j
    where j.id = p_job_id and j.input_table = 'client_campaigns'
      and j.input_id = c.id and j.client_id = c.client_id
      and j.agent_key = 'campaign_plan') then
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

create or replace function public.create_campaign_manifest_v6(
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
  if c.acquisition_mode not in ('organic', 'paid', 'both') or c.built_at is null
     or nullif(btrim(c.objective), '') is null
     or nullif(btrim(c.audience), '') is null then
    raise exception 'A route-bound, built campaign plan with objective and audience is required.';
  end if;
  if c.acquisition_mode = 'both' and (
      coalesce(c.organic_content_count,0) < 1
      or coalesce(c.paid_content_count,0) < 1
      or c.organic_content_count + c.paid_content_count is distinct from c.content_count
      or c.content_spec_id is null) then
    raise exception 'Both routes need an exact planned content specification.';
  end if;
  v_website_required := c.acquisition_mode in ('paid', 'both') or c.needs_landing_page
    or p_needs_lead_magnet;
  v_activation_module := case
    when c.acquisition_mode in ('organic', 'both') then 'content_distribution'
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
  ) || case when c.acquisition_mode = 'both' then jsonb_build_object(
    'organic_content_count', c.organic_content_count,
    'paid_content_count', c.paid_content_count,
    'content_spec_id', c.content_spec_id
  ) else '{}'::jsonb end;
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
      case when c.acquisition_mode = 'both' then
        '{distribution,paid_distribution,sales_path}'::text[]
        else '{distribution,sales_path}'::text[] end, false);
  if c.acquisition_mode = 'both' then
    insert into public.campaign_manifest_items (
      manifest_id, item_key, module_key, required, depends_on, external_activation
    ) values (v_version.id, 'paid_distribution',
      case when c.paid_platform = 'meta' then 'meta_ads_studio' else 'google_ads_studio' end,
      true, '{creative,website,sales_path}', true);
  end if;
  return v_version;
end;
$$;

create or replace function public.request_campaign_action_approval_v6(
  p_manifest_id uuid, p_idempotency_key text, p_action_key text,
  p_destination text, p_artifact_version_hash text, p_scope jsonb
) returns public.campaign_action_approvals
language plpgsql volatile security definer
set search_path = pg_catalog, public
set timezone = 'UTC'
as $$
declare
  v_manifest public.campaign_manifest_versions%rowtype;
  v_request public.campaign_action_approvals%rowtype;
  v_hash text;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Only the internal service can request an external action.';
  end if;
  select * into v_manifest from public.campaign_manifest_versions
    where id = p_manifest_id;
  if not found then raise exception 'Campaign package not found.'; end if;
  if exists (select 1 from public.campaign_manifest_versions v
    where v.campaign_id = v_manifest.campaign_id and v.version > v_manifest.version) then
    raise exception 'Campaign package was superseded.';
  end if;
  if p_idempotency_key is null or length(btrim(p_idempotency_key)) not between 1 and 160
     or p_action_key is null or p_action_key not in (
       'campaign_launch', 'meta_ad_build', 'google_ad_build', 'organic_publish',
       'proof_publish', 'page_deploy', 'lead_message', 'profile_update', 'budget_change')
     or p_destination is null or length(btrim(p_destination)) not between 1 and 300
     or p_artifact_version_hash is null or p_artifact_version_hash !~ '^[0-9a-f]{32,128}$'
     or p_scope is null or jsonb_typeof(p_scope) <> 'object' then
    raise exception 'An action, destination, exact version and scope are required.';
  end if;
  if p_action_key = 'campaign_launch' and p_artifact_version_hash <> v_manifest.plan_hash then
    raise exception 'Campaign launch must reference the exact package hash.';
  end if;
  if (p_action_key in ('meta_ad_build', 'google_ad_build')
      and (v_manifest.acquisition_mode not in ('paid', 'both')
        or p_action_key <> v_manifest.paid_platform || '_ad_build'))
     or (p_action_key = 'organic_publish' and v_manifest.acquisition_mode not in ('organic', 'both')) then
    raise exception 'External action does not match the campaign route.';
  end if;
  v_hash := md5(jsonb_build_object(
    'manifest_id', p_manifest_id, 'action_key', p_action_key,
    'destination', btrim(p_destination),
    'artifact_version_hash', p_artifact_version_hash, 'scope', p_scope
  )::text);
  perform pg_advisory_xact_lock(hashtextextended(
    v_manifest.campaign_id::text || ':action:' || btrim(p_idempotency_key), 0));
  select * into v_request from public.campaign_action_approvals
    where campaign_id = v_manifest.campaign_id and idempotency_key = btrim(p_idempotency_key);
  if found then
    if v_request.request_hash <> v_hash then
      raise exception 'Idempotency key already belongs to a different action.';
    end if;
    return v_request;
  end if;
  insert into public.campaign_action_approvals (
    client_id, campaign_id, manifest_id, idempotency_key, action_key,
    destination, artifact_version_hash, scope, request_hash
  ) values (
    v_manifest.client_id, v_manifest.campaign_id, v_manifest.id,
    btrim(p_idempotency_key), p_action_key, btrim(p_destination),
    p_artifact_version_hash, p_scope, v_hash
  ) returning * into v_request;
  return v_request;
end;
$$;

-- The current manifest now has an organic and a paid external obligation.
create or replace view campaign_route_actions with (security_invoker = true) as
select
  m.campaign_id,
  m.client_id,
  m.id as manifest_id,
  m.version as manifest_version,
  m.acquisition_mode,
  m.paid_platform,
  i.item_key,
  i.module_key,
  i.required,
  case i.item_key
    when 'website' then 'page_deploy'
    when 'proof_distribution' then 'proof_publish'
    when 'distribution' then
      case
        when m.acquisition_mode in ('organic', 'both') then 'organic_publish'
        when m.paid_platform = 'meta' then 'meta_ad_build'
        when m.paid_platform = 'google' then 'google_ad_build'
        else null
      end
    when 'paid_distribution' then
      case when m.paid_platform = 'meta' then 'meta_ad_build'
           when m.paid_platform = 'google' then 'google_ad_build'
           else null end
    else null
  end as action_key
from public.campaign_manifest_versions m
join public.campaign_manifest_items i on i.manifest_id = m.id
where i.external_activation
  -- The current manifest only. An older version's requirements are history.
  and not exists (
    select 1 from public.campaign_manifest_versions later
     where later.campaign_id = m.campaign_id and later.version > m.version);

select public.lock_down_definer_functions();

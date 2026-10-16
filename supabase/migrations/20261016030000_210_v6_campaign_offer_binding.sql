-- Select an approved offer before planning so the planner and package use
-- the same immutable version. Nullable for campaigns created before this flow.
alter table public.client_campaigns
  add column offer_version_id uuid;
alter table public.client_campaigns
  add constraint client_campaigns_offer_version_client_fk
  foreign key (offer_version_id, client_id)
  references public.service_offer_versions(id, client_id) on delete restrict;

create function public.guard_campaign_offer_version_v6()
returns trigger language plpgsql set search_path = pg_catalog, public as $$
begin
  if tg_op = 'UPDATE' and old.offer_version_id is distinct from new.offer_version_id
     and (old.offer_version_id is not null or old.built_at is not null) then
    raise exception 'Choose the campaign offer before planning; create a new campaign for another offer.';
  end if;
  if new.offer_version_id is not null and
     not exists (select 1 from public.service_offer_signoffs s
       where s.offer_version_id = new.offer_version_id and s.client_id = new.client_id) then
    raise exception 'Choose an approved offer version belonging to this client.';
  end if;
  return new;
end;
$$;
create trigger guard_campaign_offer_version_v6
  before insert or update of offer_version_id on public.client_campaigns
  for each row execute function public.guard_campaign_offer_version_v6();

create function public.guard_manifest_offer_matches_campaign_v6()
returns trigger language plpgsql set search_path = pg_catalog, public as $$
declare
  v_selected uuid;
begin
  select offer_version_id into v_selected from public.client_campaigns
    where id = new.campaign_id and client_id = new.client_id;
  if v_selected is not null and v_selected <> new.offer_version_id then
    raise exception 'Campaign package must use its selected offer version.';
  end if;
  return new;
end;
$$;
create trigger guard_manifest_offer_matches_campaign_v6
  before insert on public.campaign_manifest_offers
  for each row execute function public.guard_manifest_offer_matches_campaign_v6();

-- Checks live proof rights before the model sees a quantified claim. The
-- immutable version and hash identify exactly what the model was given.
create function public.capture_campaign_offer_v6(p_campaign_id uuid)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public
set timezone = 'UTC'
as $$
declare
  v_campaign public.client_campaigns%rowtype;
  v_version public.service_offer_versions%rowtype;
  v_service text;
  v_claim jsonb;
  v_proof public.client_proof_assets%rowtype;
begin
  if auth.role() <> 'service_role' then raise exception 'Service role required.'; end if;
  select * into v_campaign from public.client_campaigns where id = p_campaign_id;
  if not found then raise exception 'Campaign not found.'; end if;
  if v_campaign.offer_version_id is null then return null; end if;
  select * into v_version from public.service_offer_versions v
    where v.id = v_campaign.offer_version_id and v.client_id = v_campaign.client_id;
  if not found or not exists (select 1 from public.service_offer_signoffs s
    where s.offer_version_id = v_version.id and s.client_id = v_campaign.client_id) then
    raise exception 'Campaign offer is missing approval or belongs to another client.';
  end if;
  select service_name into v_service from public.service_offers
    where id = v_version.offer_id and client_id = v_version.client_id;
  for v_claim in select * from jsonb_array_elements(v_version.claims) loop
    if v_claim->>'kind' = 'quantified' then
      select * into v_proof from public.client_proof_assets
        where id = (v_claim->>'proof_asset_id')::uuid;
      if not found or v_proof.client_id <> v_version.client_id
         or v_proof.usage_rights <> 'approved'
         or (v_proof.expires_on is not null and v_proof.expires_on < current_date) then
        raise exception 'A quantified offer claim needs current, cleared proof for this client.';
      end if;
    end if;
  end loop;
  return jsonb_build_object(
    'id', v_version.id, 'offer_id', v_version.offer_id,
    'service_name', v_service, 'version', v_version.version,
    'audience', v_version.audience, 'promise', v_version.promise,
    'inclusions', v_version.inclusions, 'exclusions', v_version.exclusions,
    'price_amount', v_version.price_amount, 'currency', v_version.currency,
    'claims', v_version.claims, 'content_hash', v_version.content_hash
  );
end;
$$;
revoke all on function public.capture_campaign_offer_v6(uuid)
  from public, anon, authenticated;
grant execute on function public.capture_campaign_offer_v6(uuid) to service_role;

create or replace function public.clone_campaign_for_route(
  p_source_campaign_id uuid,
  p_target_mode text,
  p_paid_platform text default null,
  p_name text default null
)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_source public.client_campaigns%rowtype;
  v_clone_id uuid;
  v_name text;
begin
  if auth.role() <> 'service_role' and not public.is_admin() then
    raise exception 'Only an admin can clone campaigns.';
  end if;
  if p_target_mode is null or p_target_mode not in ('organic', 'paid')
     or (p_target_mode = 'paid' and coalesce(p_paid_platform, '') not in ('meta', 'google'))
     or (p_target_mode = 'organic' and p_paid_platform is not null) then
    raise exception 'Choose organic, or paid with Meta or Google.';
  end if;
  select * into v_source from public.client_campaigns where id = p_source_campaign_id;
  if not found then raise exception 'Source campaign not found.'; end if;
  if v_source.acquisition_mode <> 'legacy' and v_source.acquisition_mode = p_target_mode then
    raise exception 'Clone into the other route to keep independent distribution and results.';
  end if;
  v_name := coalesce(nullif(btrim(p_name), ''), v_source.name || ' · ' || initcap(p_target_mode));
  if length(v_name) > 200 then raise exception 'Campaign name is too long.'; end if;
  insert into public.client_campaigns (
    client_id, name, brief, acquisition_mode, paid_platform,
    cloned_from_campaign_id, ideate_on_plan, offer_version_id
  ) values (
    v_source.client_id, v_name, v_source.brief, p_target_mode, p_paid_platform,
    v_source.id, v_source.ideate_on_plan, v_source.offer_version_id
  ) returning id into v_clone_id;
  return v_clone_id;
end;
$$;

-- The gateway supplies this ninth argument, including an explicit null for
-- legacy offer-strategy planning. Keep the eight-argument RPC for existing
-- callers; idempotency still checks the complete payload for this path.
create or replace function mcp_internal.campaign_json(c public.client_campaigns)
returns jsonb language plpgsql stable
set search_path = pg_catalog, mcp_internal, public as $$
begin
  return jsonb_build_object(
    'id', c.id, 'client_id', c.client_id,
    'name', c.name, 'brief', mcp_internal.clip_text(c.brief, 4000),
    'status', c.status,
    'acquisition_mode', c.acquisition_mode,
    'paid_platform', c.paid_platform,
    'cloned_from_campaign_id', c.cloned_from_campaign_id,
    'offer_version_id', c.offer_version_id,
    'objective', mcp_internal.clip_text(c.objective, 2000),
    'audience', mcp_internal.clip_text(c.audience, 2000),
    'offer_summary', mcp_internal.clip_text(c.offer_summary, 2000),
    'core_message', mcp_internal.clip_text(c.core_message, 2000),
    'channels', to_jsonb(c.channels), 'budget', c.budget,
    'starts_on', c.starts_on, 'ends_on', c.ends_on,
    'kpi_metric', c.kpi_metric, 'kpi_target', c.kpi_target,
    'content_count', c.content_count,
    'needs_landing_page', c.needs_landing_page,
    'needs_sales_agent', c.needs_sales_agent,
    'ad_campaign_id', c.ad_campaign_id,
    'built_at', c.built_at, 'launched_at', c.launched_at,
    'created_at', c.created_at, 'updated_at', c.updated_at
  );
end;
$$;

create function public.mcp_campaign_create_v6(
  p_bot_id text, p_client_id uuid, p_name text, p_brief text,
  p_acquisition_mode text, p_paid_platform text, p_request_id text,
  p_execution_id text, p_offer_version_id uuid
) returns jsonb
language plpgsql volatile security definer
set search_path = pg_catalog, mcp_internal, public
set timezone = 'UTC'
as $$
declare
  v_campaign public.client_campaigns%rowtype;
  v_payload jsonb;
  v_existing jsonb;
  v_result jsonb;
  v_job uuid;
begin
  perform mcp_internal.require_service_role();
  perform mcp_internal.require_campaign_execution_permission(
    p_bot_id, p_client_id, 'campaign.create');
  perform mcp_internal.require_mcp_ids(p_request_id, p_execution_id);
  if p_name is null or length(btrim(p_name)) not between 1 and 200
     or p_brief is null or length(btrim(p_brief)) not between 1 and 4000
     or p_acquisition_mode is null or p_acquisition_mode not in ('organic', 'paid')
     or (p_acquisition_mode = 'paid' and coalesce(p_paid_platform, '') not in ('meta', 'google'))
     or (p_acquisition_mode = 'organic' and p_paid_platform is not null) then
    raise exception using message = 'invalid_request', errcode = 'P0001';
  end if;
  v_payload := jsonb_build_object(
    'action', 'create', 'name', btrim(p_name), 'brief', btrim(p_brief),
    'acquisition_mode', p_acquisition_mode, 'paid_platform', p_paid_platform,
    'offer_version_id', p_offer_version_id
  );
  v_existing := mcp_internal.take_campaign_request(
    p_bot_id, p_execution_id, 'campaign.create', p_client_id, v_payload);
  if v_existing is not null then return v_existing; end if;
  insert into public.client_campaigns (
    client_id, name, brief, acquisition_mode, paid_platform, offer_version_id
  ) values (
    p_client_id, btrim(p_name), btrim(p_brief), p_acquisition_mode,
    p_paid_platform, p_offer_version_id
  ) returning * into v_campaign;
  v_job := mcp_internal.enqueue_mcp_job(
    'campaign_plan', p_client_id, 'client_campaigns', v_campaign.id,
    p_bot_id, p_request_id, p_execution_id, 'campaign_agent_unavailable');
  v_result := jsonb_build_object(
    'client_id', p_client_id,
    'campaign', mcp_internal.campaign_json(v_campaign) || jsonb_build_object(
      'acquisition_mode', v_campaign.acquisition_mode,
      'paid_platform', v_campaign.paid_platform,
      'cloned_from_campaign_id', v_campaign.cloned_from_campaign_id,
      'offer_version_id', v_campaign.offer_version_id
    ),
    'job_id', v_job, 'replayed', false
  );
  insert into mcp_internal.mcp_campaign_requests (
    bot_id, execution_id, request_id, tool, client_id, campaign_id, payload, result
  ) values (
    p_bot_id, p_execution_id, p_request_id, 'campaign.create',
    p_client_id, v_campaign.id, v_payload, v_result
  );
  return v_result;
end;
$$;
revoke all on function public.mcp_campaign_create_v6(
  text, uuid, text, text, text, text, text, text, uuid
) from public, anon, authenticated;
grant execute on function public.mcp_campaign_create_v6(
  text, uuid, text, text, text, text, text, text, uuid
) to service_role;

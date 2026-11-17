-- Freeze the current proof-rights decision used by a quantified offer claim.
-- A withdrawal and later new clearance must not revive an older package
-- approval. Packages without quantified claims retain their old JSON shape.
create or replace function public.campaign_preparation_snapshot_v7(p_campaign_id uuid)
returns jsonb language plpgsql stable security definer
set search_path=pg_catalog,public as $$
declare
  c public.client_campaigns%rowtype;
  v_readiness jsonb;
  v_run uuid;
  v_routes jsonb;
  v_outputs jsonb;
  v_offer_rights jsonb;
begin
  select * into c from public.client_campaigns where id=p_campaign_id;
  if c.id is null then raise exception 'Campaign unavailable.' using errcode='P0001'; end if;
  if auth.role() not in ('authenticated','service_role')
    or (auth.role()='authenticated' and not public.can_access_client(c.client_id)) then
    raise exception 'Campaign access required.' using errcode='42501';
  end if;
  v_readiness:=public.campaign_package_readiness_v7(c.id);
  if v_readiness->>'status'<>'ready_for_review' then return null; end if;
  v_run:=(v_readiness->>'run_id')::uuid;
  select jsonb_agg(jsonb_build_object('id',r.id,'route',r.route,
    'version',r.version,'paid_platform',r.paid_platform,
    'plan_fingerprint',r.plan_fingerprint) order by r.route)
    into v_routes
  from public.campaign_route_packages_v6 r
  where r.campaign_id=c.id and r.id in (
    select w.route_package_id from public.delivery_work_items_v6 w
    where w.campaign_id=c.id and w.input_snapshot->>'workflow_run_id'=v_run::text
      and w.route_package_id is not null);
  select jsonb_agg(jsonb_build_object(
    'work_item_id',w.id,'item_key',w.item_key,'route_key',w.route_key,
    'route_package_id',w.route_package_id,'work_version',w.work_version,
    'owner_module',w.owner_module,'input_fingerprint',w.input_fingerprint,
    'expected_output',w.expected_output,'output_fingerprint',w.output_fingerprint,
    'output_refs',w.output_refs) order by
      case when w.owner_module='content_production_factory' then 0
        when w.owner_module='website_studio' then 1 else 2 end,
      w.item_key)
    into v_outputs
  from public.delivery_work_items_v6 w
  where w.campaign_id=c.id and w.client_id=c.client_id and w.required
    and w.input_snapshot->>'workflow_run_id'=v_run::text
    and w.owner_module in ('content_production_factory','website_studio',
      'sales_os','lead_magnet_studio');
  if jsonb_array_length(coalesce(v_outputs,'[]'::jsonb))
      <> (v_readiness->>'expected')::integer then
    return null;
  end if;
  select jsonb_agg(jsonb_build_object(
      'proof_id',proof.id,
      'rights_request_id',proof.approved_rights_request_id,
      'rights_content_hash',proof.approved_rights_content_hash,
      'rights_expiry',proof.expires_on) order by proof.id)
    into v_offer_rights
  from public.service_offer_versions offer_version
    cross join lateral jsonb_array_elements(offer_version.claims) claim
    join public.client_proof_assets proof
      on proof.id::text=claim.value->>'proof_asset_id'
        and proof.client_id=offer_version.client_id
  where offer_version.id=c.offer_version_id
    and offer_version.client_id=c.client_id and claim.value->>'kind'='quantified';
  return jsonb_build_object('client_id',c.client_id,'campaign_id',c.id,
    'run_id',v_run,'plan_fingerprint',public.campaign_plan_fingerprint(c),
    'content_spec_id',c.content_spec_id,'content_spec_hash',c.content_spec_hash,
    'offer_version_id',c.offer_version_id,'routes',coalesce(v_routes,'[]'::jsonb),
    'outputs',v_outputs)
    || case when jsonb_array_length(coalesce(v_offer_rights,'[]'::jsonb))>0
      then jsonb_build_object('offer_proof_rights',v_offer_rights)
      else '{}'::jsonb end;
end $$;

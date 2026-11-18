-- Include human-approved Google search-copy versions in the existing paid
-- operator packet. The packet remains a manual handoff, never ad activation.
begin;

create or replace function public.paid_operator_source_v7(p_package_id uuid)
returns jsonb language plpgsql stable security definer
set search_path=pg_catalog,public as $$
declare p public.campaign_preparation_packages_v7%rowtype;
  c public.client_campaigns%rowtype;
  v_route jsonb;
  v_creative jsonb:='[]'::jsonb;
  v_output jsonb;
  v_ref jsonb;
  v_asset public.client_media_assets%rowtype;
  v_copy public.campaign_google_search_copy_versions_v7%rowtype;
begin
  select * into p from public.campaign_preparation_packages_v7 where id=p_package_id;
  if p.id is null then return null; end if;
  if auth.role() not in ('authenticated','service_role')
    or (auth.role()='authenticated' and not public.can_access_client(p.client_id)) then
    raise exception 'Client access required.' using errcode='42501';
  end if;
  if not public.campaign_preparation_approved_v7(p.id) then return null; end if;
  select * into c from public.client_campaigns where id=p.campaign_id and client_id=p.client_id;
  if c.id is null or not c.runs_paid or c.paid_platform not in ('meta','google') then return null; end if;
  select value into v_route from jsonb_array_elements(p.snapshot->'routes')
    where value->>'route'='paid' and value->>'paid_platform'=c.paid_platform limit 1;
  if v_route is null or nullif(v_route->>'id','') is null then return null; end if;
  for v_output in select value from jsonb_array_elements(p.snapshot->'outputs')
    where value->>'route_key'='paid' and value->>'owner_module'='content_production_factory'
    order by value->>'item_key' loop
    if v_output->>'route_package_id' is distinct from v_route->>'id' then return null; end if;
    if c.paid_platform='google' then
      if v_output->'expected_output'->>'platform'<>'google_ads' then return null; end if;
      select value into v_ref from jsonb_array_elements(v_output->'output_refs')
        where value->>'kind'='google_search_copy' limit 1;
      if v_ref is null or v_ref->>'record_id' is null then return null; end if;
      select * into v_copy from public.campaign_google_search_copy_versions_v7
        where id=(v_ref->>'record_id')::uuid and client_id=c.client_id
          and campaign_id=c.id and route_package_id=(v_route->>'id')::uuid
          and work_item_id=(v_output->>'work_item_id')::uuid;
      if v_copy.id is null or v_copy.copy_hash is distinct from v_ref->>'version'
        or not public.google_search_copy_approved_v7(v_copy.id) then return null; end if;
      v_creative:=v_creative || jsonb_build_array(jsonb_build_object(
        'work',v_output,'copy_id',v_copy.id,'copy_hash',v_copy.copy_hash,
        'headlines',v_copy.headlines,'descriptions',v_copy.descriptions,
        'rationale',v_copy.rationale));
    else
      select value into v_ref from jsonb_array_elements(v_output->'output_refs')
        where value->>'kind'='asset' limit 1;
      if v_ref is null or v_ref->>'record_id' is null then return null; end if;
      select * into v_asset from public.client_media_assets
        where id=(v_ref->>'record_id')::uuid and client_id=c.client_id;
      if v_asset.id is null or v_asset.delivery_bytes_sha256 is null
        or v_asset.review_status<>'approved' or v_asset.human_approved_at is null
        or v_asset.media_type not in ('image','text') or v_asset.content_format<>'single'
        or not public.ordinary_media_signoff_current_v6(v_asset.id) then return null; end if;
      v_creative:=v_creative || jsonb_build_array(jsonb_build_object(
        'work',v_output,'asset_id',v_asset.id,'media_type',v_asset.media_type,
        'content_format',v_asset.content_format,'storage_path',v_asset.storage_path,
        'file_sha256',v_asset.delivery_bytes_sha256,'title',v_asset.title,
        'ad_primary_text',v_asset.ad_primary_text,'ad_headline',v_asset.ad_headline,
        'ad_description',v_asset.ad_description,'ad_cta',v_asset.ad_cta,
        'ad_link_url',v_asset.ad_link_url));
    end if;
  end loop;
  if jsonb_array_length(v_creative)=0 then return null; end if;
  if c.offer_version_id is null or not exists(select 1 from public.service_offer_signoffs s
      where s.offer_version_id=c.offer_version_id and s.client_id=c.client_id)
    or c.audience is null or nullif(btrim(c.audience),'') is null
    or coalesce(array_length(c.target_countries,1),0)=0
    or coalesce(c.daily_budget,c.budget,0)<=0 then return null; end if;
  return jsonb_build_object(
    'package_id',p.id,'package_version',p.version,'package_hash',p.snapshot_hash,
    'campaign_id',c.id,'campaign_name',c.name,'platform',c.paid_platform,
    'route',v_route,'creative',v_creative,
    'audience',c.audience,'target_countries',c.target_countries,
    'offer_version_id',c.offer_version_id,'offer_summary',c.offer_summary,
    'core_message',c.core_message,'objective',c.objective,
    'daily_budget',c.daily_budget,'total_budget',c.budget,
    'starts_on',c.starts_on,'ends_on',c.ends_on,
    'conversion_event',c.conversion_event,'optimisation_event',c.optimisation_event,
    'page_outputs',coalesce((select jsonb_agg(value order by value->>'item_key')
      from jsonb_array_elements(p.snapshot->'outputs')
      where value->>'owner_module'='website_studio'),'[]'::jsonb),
    'plan_fingerprint',public.campaign_plan_fingerprint(c));
end $$;

create function public.paid_operator_bundle_export_v7(p_bundle_id uuid)
returns text language plpgsql stable security definer
set search_path=pg_catalog,public as $$
declare b public.paid_operator_bundles_v7%rowtype;
begin
  select * into b from public.paid_operator_bundles_v7 where id=p_bundle_id;
  if b.id is null or auth.role()<>'authenticated' or auth.uid() is null
    or not public.can_access_client(b.client_id)
    or not public.paid_operator_bundle_current_v7(b.id) then
    raise exception 'A current paid operator bundle is required.' using errcode='42501';
  end if;
  return b.snapshot::text;
end $$;
revoke all on function public.paid_operator_bundle_export_v7(uuid)
  from public,anon,service_role;
grant execute on function public.paid_operator_bundle_export_v7(uuid)
  to authenticated;

select public.lock_down_definer_functions();
commit;

-- Exact packet-byte evidence is required before a reported operator handoff.
begin;
create or replace function public.record_paid_operator_event_v7(
  p_bundle_id uuid,p_event text,p_reference text,p_external_campaign_id text default null,
  p_external_ad_id text default null,p_detail text default null)
returns public.paid_operator_events_v7 language plpgsql volatile security definer
set search_path=pg_catalog,public as $$
declare b public.paid_operator_bundles_v7%rowtype;
  v_prior public.paid_operator_events_v7%rowtype;
  v_event public.paid_operator_events_v7%rowtype;
begin
  select * into b from public.paid_operator_bundles_v7 where id=p_bundle_id;
  if b.id is null then raise exception 'Bundle unavailable.' using errcode='23514'; end if;
  if auth.role()<>'authenticated' or auth.uid() is null
    or public.current_role_of() is null or not public.can_access_client(b.client_id) then
    raise exception 'Client operator required.' using errcode='42501';
  end if;
  if not public.paid_operator_bundle_current_v7(b.id) then
    raise exception 'The exact paid bundle is stale or unapproved.' using errcode='23514';
  end if;
  if p_event not in ('verified_download','handoff_reported','external_ids_reported','activation_reported','change_reported')
    or nullif(btrim(p_reference),'') is null then
    raise exception 'A supported event and external evidence reference are required.' using errcode='23514';
  end if;
  select * into v_prior from public.paid_operator_events_v7
    where bundle_id=b.id and event=p_event and reference=btrim(p_reference);
  if v_prior.id is not null then
    if v_prior.external_campaign_id is distinct from nullif(btrim(p_external_campaign_id),'')
      or v_prior.external_ad_id is distinct from nullif(btrim(p_external_ad_id),'')
      or v_prior.detail is distinct from nullif(btrim(p_detail),'') then
      raise exception 'This evidence reference already records a different event.' using errcode='23514';
    end if;
    return v_prior;
  end if;
  if p_event='verified_download' and p_reference is distinct from 'sha256:'||b.snapshot_hash then
    raise exception 'Download evidence must name the exact packet hash.' using errcode='23514';
  end if;
  if p_event='handoff_reported' and not exists(select 1 from public.paid_operator_events_v7
    where bundle_id=b.id and event='verified_download'
      and reference='sha256:'||b.snapshot_hash) then
    raise exception 'Download and verify the bundle files before reporting handoff.' using errcode='23514';
  end if;
  if p_event not in ('verified_download','handoff_reported') and not exists(select 1 from public.paid_operator_events_v7
    where bundle_id=b.id and event='handoff_reported') then
    raise exception 'Record the operator handoff first.' using errcode='23514';
  end if;
  if p_event in ('external_ids_reported','activation_reported','change_reported')
    and nullif(btrim(p_external_campaign_id),'') is null then
    raise exception 'The external campaign ID is required.' using errcode='23514';
  end if;
  insert into public.paid_operator_events_v7
    (bundle_id,client_id,event,reference,external_campaign_id,external_ad_id,detail,recorded_by)
  values(b.id,b.client_id,p_event,btrim(p_reference),nullif(btrim(p_external_campaign_id),''),
    nullif(btrim(p_external_ad_id),''),nullif(btrim(p_detail),''),auth.uid())
  returning * into v_event;
  return v_event;
end $$;
commit;

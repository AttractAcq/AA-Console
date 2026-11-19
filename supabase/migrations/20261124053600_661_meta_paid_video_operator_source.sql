-- Freeze every selected paid creative, including an exact reviewed final MP4.
-- A standalone paid campaign may use its manually supplied service direction.
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
        or v_asset.review_status<>'approved' or v_asset.human_approved_at is null then
        return null;
      end if;
      if v_asset.media_type='video' then
        -- A paid video is the final rendered cut, not its source footage.
        if v_asset.content_format not in ('reel','single')
          or nullif(btrim(v_asset.render_path),'') is null
          or not public.video_signoff_current_v6(v_asset.id,'owner')
          or not public.video_signoff_current_v6(v_asset.id,'manager')
          or (exists(select 1 from public.video_client_approval_requests q
              where q.asset_id=v_asset.id)
            and not public.video_signoff_current_v6(v_asset.id,'client')) then
          return null;
        end if;
      elsif v_asset.media_type in ('image','text') then
        if v_asset.content_format<>'single'
          or not public.ordinary_media_signoff_current_v6(v_asset.id) then
          return null;
        end if;
      else
        return null;
      end if;
      v_creative:=v_creative || jsonb_build_array(jsonb_build_object(
        'work',v_output,'asset_id',v_asset.id,'media_type',v_asset.media_type,
        'content_format',v_asset.content_format,
        'storage_path',coalesce(nullif(btrim(v_asset.render_path),''),v_asset.storage_path),
        'file_sha256',v_asset.delivery_bytes_sha256,'title',v_asset.title,
        'ad_primary_text',v_asset.ad_primary_text,'ad_headline',v_asset.ad_headline,
        'ad_description',v_asset.ad_description,'ad_cta',v_asset.ad_cta,
        'ad_link_url',v_asset.ad_link_url));
    end if;
  end loop;
  if jsonb_array_length(v_creative)=0 then return null; end if;
  if (c.offer_version_id is null and c.campaign_kind is distinct from 'standalone_paid')
    or (c.offer_version_id is not null and not exists(
      select 1 from public.service_offer_signoffs s
      where s.offer_version_id=c.offer_version_id and s.client_id=c.client_id))
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
select public.lock_down_definer_functions();
commit;

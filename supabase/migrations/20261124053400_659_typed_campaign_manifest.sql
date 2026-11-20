-- A typed campaign package records exactly the producers selected by its
-- operator. The older v6 writer remains unchanged for historical campaigns.
begin;

create function public.create_typed_campaign_manifest_v11(
  p_campaign_id uuid,
  p_idempotency_key text,
  p_needs_lead_magnet boolean
) returns public.campaign_manifest_versions
language plpgsql volatile security definer
set search_path=pg_catalog,public
set timezone='UTC'
as $$
declare
  c public.client_campaigns%rowtype;
  v_snapshot jsonb;
  v_hash text;
  v_version public.campaign_manifest_versions%rowtype;
  v_paid_module text;
  v_organic boolean;
  v_paid boolean;
  v_offer boolean;
  v_dependencies text[];
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Service role required to version a campaign package.' using errcode='42501';
  end if;
  if p_idempotency_key is null or length(btrim(p_idempotency_key)) not between 1 and 160
    or p_needs_lead_magnet is null then
    raise exception 'A key and explicit magnet choice are required.' using errcode='22023';
  end if;
  select * into c from public.client_campaigns where id=p_campaign_id for update;
  if c.id is null then raise exception 'Campaign not found.' using errcode='23514'; end if;
  if c.campaign_kind not in ('standalone_paid','standalone_organic','opportunity_campaign')
    or c.acquisition_mode not in ('organic','paid','both')
    or c.built_at is null or nullif(btrim(c.objective),'') is null
    or nullif(btrim(c.audience),'') is null then
    raise exception 'A built, typed and route-bound campaign is required.' using errcode='23514';
  end if;
  if p_needs_lead_magnet is distinct from c.needs_lead_magnet then
    raise exception 'The magnet choice differs from the saved campaign plan.' using errcode='23514';
  end if;
  v_organic:=c.acquisition_mode in ('organic','both');
  v_paid:=c.acquisition_mode in ('paid','both');
  v_offer:=c.offer_version_id is not null;
  if v_paid and c.paid_platform not in ('meta','google') then
    raise exception 'A paid campaign needs a selected platform.' using errcode='23514';
  end if;
  if c.acquisition_mode='both' and (
    coalesce(c.organic_content_count,0)<1 or coalesce(c.paid_content_count,0)<1
    or c.organic_content_count+c.paid_content_count is distinct from c.content_count
    or c.content_spec_id is null) then
    raise exception 'Both routes need an exact planned content specification.' using errcode='23514';
  end if;
  v_paid_module:=case when c.paid_platform='meta' then 'meta_ads_studio'
    else 'google_ads_studio' end;
  v_snapshot:=jsonb_build_object(
    'campaign_id',c.id,'client_id',c.client_id,
    'campaign_kind',c.campaign_kind,
    'acquisition_mode',c.acquisition_mode,'paid_platform',c.paid_platform,
    'built_at',c.built_at,'plan_fingerprint',public.campaign_plan_fingerprint(c),
    'objective',c.objective,'audience',c.audience,
    'offer_version_id',c.offer_version_id,
    'offer_summary',c.offer_summary,'core_message',c.core_message,
    'channels',c.channels,'budget',c.budget,
    'starts_on',c.starts_on,'ends_on',c.ends_on,
    'kpi_metric',c.kpi_metric,'kpi_target',c.kpi_target,
    'content_count',c.content_count,
    'needs_landing_page',c.needs_landing_page,
    'needs_sales_agent',c.needs_sales_agent,
    'needs_lead_magnet',c.needs_lead_magnet
  ) || case when c.acquisition_mode='both' then jsonb_build_object(
    'organic_content_count',c.organic_content_count,
    'paid_content_count',c.paid_content_count,
    'content_spec_id',c.content_spec_id
  ) else '{}'::jsonb end;
  v_hash:=md5((v_snapshot-'built_at')::text);
  select * into v_version from public.campaign_manifest_versions
    where campaign_id=c.id and idempotency_key=btrim(p_idempotency_key);
  if found then
    if v_version.plan_hash is distinct from v_hash then
      raise exception 'Idempotency key belongs to another campaign package.' using errcode='23514';
    end if;
    return v_version;
  end if;
  insert into public.campaign_manifest_versions(
    campaign_id,client_id,version,idempotency_key,
    acquisition_mode,paid_platform,plan_snapshot,plan_hash
  ) values (
    c.id,c.client_id,
    coalesce((select max(version)+1 from public.campaign_manifest_versions
      where campaign_id=c.id),1),
    btrim(p_idempotency_key),c.acquisition_mode,c.paid_platform,v_snapshot,v_hash
  ) returning * into v_version;

  -- Keep stable item keys for existing readers, but only selected producers
  -- are requirements. Creative and the selected routes are always required.
  insert into public.campaign_manifest_items(
    manifest_id,item_key,module_key,required,depends_on,external_activation
  ) values
    (v_version.id,'intelligence','intelligence_os',true,'{}',false),
    (v_version.id,'offer','offer_studio',v_offer,'{intelligence}',false),
    (v_version.id,'proof','proof_production_factory',false,'{intelligence}',false),
    (v_version.id,'creative','content_production_factory',true,
      case when v_offer then '{offer}'::text[] else '{intelligence}'::text[] end,false),
    (v_version.id,'website','website_studio',c.needs_landing_page,
      case when v_offer then '{offer}'::text[] else '{creative}'::text[] end,true),
    (v_version.id,'lead_magnet','lead_magnet_studio',c.needs_lead_magnet,
      case when c.needs_landing_page then '{website}'::text[]
        when v_offer then '{offer}'::text[] else '{creative}'::text[] end,true),
    (v_version.id,'sales_path','sales_os',c.needs_sales_agent,
      case when c.needs_landing_page then '{website}'::text[]
        when v_offer then '{offer}'::text[] else '{creative}'::text[] end,true),
    (v_version.id,'proof_distribution','proof_distribution',false,'{proof}',true),
    (v_version.id,'attribution','attribution_os',true,
      case when c.acquisition_mode='both' then '{distribution,paid_distribution}'::text[]
        else '{distribution}'::text[] end,false);
  v_dependencies:=array['creative']::text[];
  if c.needs_landing_page then v_dependencies:=v_dependencies||array['website']::text[]; end if;
  if c.needs_sales_agent then v_dependencies:=v_dependencies||array['sales_path']::text[]; end if;
  insert into public.campaign_manifest_items(
    manifest_id,item_key,module_key,required,depends_on,external_activation
  ) values (
    v_version.id,'distribution',
    case when v_organic then 'content_distribution' else v_paid_module end,
    true,v_dependencies,true
  );
  if v_organic and v_paid then
    insert into public.campaign_manifest_items(
      manifest_id,item_key,module_key,required,depends_on,external_activation
    ) values (v_version.id,'paid_distribution',v_paid_module,true,v_dependencies,true);
  end if;
  return v_version;
end $$;

revoke all on function public.create_typed_campaign_manifest_v11(uuid,text,boolean)
  from public,anon,authenticated,service_role;
grant execute on function public.create_typed_campaign_manifest_v11(uuid,text,boolean)
  to service_role;
select public.lock_down_definer_functions();
commit;

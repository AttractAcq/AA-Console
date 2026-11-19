-- A plan edit is a new campaign row with its own planner, manifest and
-- approvals. Preserve the source and its artifacts; retries return the same
-- revision. Route changes remain a new campaign action, not an in-place edit.
begin;

-- Historical unsourced clones stay held. A typed standalone revision can
-- carry its same-client parent without manufacturing an opportunity link.
create or replace function public.prevent_unsourced_campaign_clone_v7()
returns trigger language plpgsql security definer
set search_path=pg_catalog,public as $$
declare source public.client_campaigns%rowtype;
begin
  if new.cloned_from_campaign_id is null or exists(
    select 1 from public.opportunity_links l
    where l.campaign_id=new.cloned_from_campaign_id
      and l.client_id=new.client_id and l.role='campaign') then
    return new;
  end if;
  select * into source from public.client_campaigns
    where id=new.cloned_from_campaign_id for share;
  if source.id is null or source.client_id is distinct from new.client_id
    or source.campaign_kind is null
    or source.campaign_kind not in ('standalone_paid','standalone_organic')
    or new.campaign_kind is distinct from source.campaign_kind then
    raise exception 'An unsourced clone needs a same-client typed standalone source.'
      using errcode='23514';
  end if;
  return new;
end $$;

create function public.create_typed_campaign_revision_v11(
  p_campaign_id uuid,p_name text,p_brief text,p_offer_version_id text,
  p_template text,p_needs_landing_page boolean,p_needs_sales_agent boolean,
  p_needs_lead_magnet boolean,p_idempotency_key text
) returns public.client_campaigns
language plpgsql volatile security definer
set search_path=pg_catalog,public
as $$
declare
  source public.client_campaigns%rowtype;
  revised public.client_campaigns%rowtype;
  offer public.service_offers%rowtype;
  offer_version public.service_offer_versions%rowtype;
  v_key text;
  v_hash text;
  v_pillars uuid[];
  v_template text;
  v_offer_version_id uuid;
  v_paid boolean;
  v_pillar_count integer;
begin
  if auth.role() is distinct from 'authenticated' or auth.uid() is null
    or public.current_role_of() is null then
    raise exception 'A signed-in client manager must revise a campaign.' using errcode='42501';
  end if;
  if p_name is null or length(btrim(p_name)) not between 1 and 180
    or p_brief is null or length(btrim(p_brief)) not between 1 and 4000
    or p_needs_landing_page is null or p_needs_sales_agent is null
    or p_needs_lead_magnet is null or p_idempotency_key is null
    or length(btrim(p_idempotency_key)) not between 1 and 123 then
    raise exception 'A name, plan direction, module choices and request key are required.'
      using errcode='22023';
  end if;
  select * into source from public.client_campaigns where id=p_campaign_id for share;
  if source.id is null or source.archived_at is not null or source.campaign_kind not in (
      'standalone_paid','standalone_organic','opportunity_campaign')
    or not coalesce(public.can_shape_opportunity(source.client_id),false) then
    raise exception 'A typed campaign in your client scope is required.' using errcode='42501';
  end if;
  v_key:=source.id::text||':'||btrim(p_idempotency_key);
  v_template:=nullif(btrim(coalesce(p_template,'')),'');
  v_offer_version_id:=nullif(btrim(coalesce(p_offer_version_id,'')),'')::uuid;
  select array_agg(cp.pillar_id order by cp.pillar_id) into v_pillars
    from public.campaign_content_pillars cp where cp.campaign_id=source.id;
  v_pillars:=coalesce(v_pillars,'{}'::uuid[]);
  if source.campaign_kind in ('standalone_paid','standalone_organic') then
    if v_template is not null then
      raise exception 'Standalone campaigns do not use an opportunity template.'
        using errcode='22023';
    end if;
    select count(*) into v_pillar_count from public.client_content_pillars p
      where p.id=any(v_pillars) and p.client_id=source.client_id and p.active;
    if v_pillar_count<>cardinality(v_pillars) then
      raise exception 'A selected pillar is no longer active for this client.'
        using errcode='23514';
    end if;
    if v_offer_version_id is not null then
      select version_row.* into offer_version from public.service_offer_versions version_row
        join public.service_offers offer_row on offer_row.id=version_row.offer_id
          and offer_row.client_id=version_row.client_id
        join public.service_offer_signoffs s on s.offer_version_id=version_row.id
          and s.client_id=version_row.client_id
        where version_row.id=v_offer_version_id and version_row.client_id=source.client_id
          and offer_row.archived_at is null
          and not exists(select 1 from public.service_offer_versions newer
            where newer.offer_id=offer_row.id and newer.version>version_row.version)
        for share of version_row;
      if not found then raise exception 'Choose a current approved offer version.'
        using errcode='23514'; end if;
      select * into offer from public.service_offers where id=offer_version.offer_id;
      if (offer.kind='secondary' and not coalesce(public.secondary_offer_source_current_v7(offer.id),false))
        or (offer.kind='main' and exists(select 1 from public.main_offer_sources_v7 s
          where s.offer_id=offer.id) and not coalesce(public.main_offer_source_current_v7(offer.id),false))
        or (offer_version.value_equation is not null
          and not public.offer_claims_supported_v11(offer_version.id)) then
        raise exception 'The selected offer source or claim evidence is no longer current.'
          using errcode='23514';
      end if;
    end if;
    v_paid:=source.campaign_kind='standalone_paid';
    v_hash:=encode(sha256(convert_to(jsonb_build_object(
      'source_id',source.id,'name',btrim(p_name),'brief',btrim(p_brief),
      'offer_version_id',v_offer_version_id,
      'landing_page',p_needs_landing_page,'sales_agent',p_needs_sales_agent,
      'lead_magnet',p_needs_lead_magnet)::text,'UTF8')),'hex');
    perform pg_advisory_xact_lock(hashtextextended(
      source.client_id::text||':campaign-revision:'||v_key,0));
    select * into revised from public.client_campaigns
      where client_id=source.client_id and creation_key=v_key;
    if found then
      if revised.creation_fingerprint is distinct from v_hash
        or revised.cloned_from_campaign_id is distinct from source.id then
        raise exception 'The request key belongs to another campaign revision.'
          using errcode='23514';
      end if;
      return revised;
    end if;
    insert into public.client_campaigns(
      client_id,name,brief,acquisition_mode,paid_platform,runs_organic,runs_paid,
      cloned_from_campaign_id,offer_version_id,ideate_on_plan,
      needs_landing_page,needs_sales_agent,needs_lead_magnet,campaign_kind,
      creation_key,creation_fingerprint
    ) values (
      source.client_id,left(btrim(p_name),160)||' · Plan revision',btrim(p_brief),
      source.acquisition_mode,source.paid_platform,not v_paid,v_paid,
      source.id,v_offer_version_id,source.ideate_on_plan,
      p_needs_landing_page,p_needs_sales_agent,p_needs_lead_magnet,
      source.campaign_kind,v_key,v_hash
    ) returning * into revised;
    insert into public.campaign_content_pillars(campaign_id,pillar_id)
      select revised.id,unnest(v_pillars);
    perform public.enqueue_agent_job('campaign_plan',source.client_id,
      'client_campaigns',revised.id);
    return revised;
  end if;

  if v_offer_version_id is null then
    raise exception 'An opportunity campaign needs its signed offer version.'
      using errcode='22023';
  end if;
  v_hash:=encode(sha256(convert_to(jsonb_build_object(
    'source_id',source.id,'name',btrim(p_name),'brief',btrim(p_brief),
    'offer_version_id',v_offer_version_id,'template',v_template,
    'landing_page',p_needs_landing_page,'sales_agent',p_needs_sales_agent,
    'lead_magnet',p_needs_lead_magnet)::text,'UTF8')),'hex');
  perform pg_advisory_xact_lock(hashtextextended(
    source.client_id::text||':campaign-revision:'||v_key,0));
  select * into revised from public.client_campaigns
    where client_id=source.client_id and creation_key=v_key;
  if found then
    if revised.creation_fingerprint is distinct from v_hash
      or revised.cloned_from_campaign_id is distinct from source.id then
      raise exception 'The request key belongs to another campaign revision.'
        using errcode='23514';
    end if;
    return revised;
  end if;
  revised:=public.create_sourced_campaign_revision_v7(
    source.id,btrim(p_brief),v_offer_version_id,v_template);
  update public.client_campaigns set
    campaign_kind='opportunity_campaign',
    needs_landing_page=p_needs_landing_page,
    needs_sales_agent=p_needs_sales_agent,
    needs_lead_magnet=p_needs_lead_magnet,
    creation_key=v_key,creation_fingerprint=v_hash
    where id=revised.id and client_id=source.client_id
    returning * into revised;
  return revised;
end $$;

revoke all on function public.create_typed_campaign_revision_v11(
  uuid,text,text,text,text,boolean,boolean,boolean,text)
  from public,anon,authenticated,service_role;
grant execute on function public.create_typed_campaign_revision_v11(
  uuid,text,text,text,text,boolean,boolean,boolean,text)
  to authenticated;
select public.lock_down_definer_functions();
commit;

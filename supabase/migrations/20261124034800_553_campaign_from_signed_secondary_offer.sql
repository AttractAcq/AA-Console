-- New opportunity-led campaigns must bind the exact current secondary offer.
-- Keep v6 for historical callers until every writer has been moved; the UI
-- entry from Market Opportunities uses this stricter transaction.
begin;

create function public.create_campaign_from_opportunity_v7(
  p_opportunity_id uuid,
  p_offer_version_id uuid,
  p_acquisition_mode text,
  p_paid_platform text default null,
  p_name text default null
) returns public.client_campaigns
language plpgsql volatile security definer
set search_path=pg_catalog,public as $$
declare
  v_opportunity public.market_opportunities%rowtype;
  v_readiness record;
  v_offer public.service_offers%rowtype;
  v_campaign public.client_campaigns%rowtype;
  v_paid boolean;
  v_organic boolean;
begin
  select * into v_opportunity from public.market_opportunities
    where id=p_opportunity_id for update;
  if v_opportunity.id is null or
    (coalesce(auth.role(),'')<>'service_role'
      and not coalesce(public.can_shape_opportunity(v_opportunity.client_id),false)) then
    raise exception 'An approved client opportunity is required.' using errcode='42501';
  end if;
  if p_acquisition_mode is null or p_acquisition_mode not in ('organic','paid','both') then
    raise exception 'Choose an organic, paid, or both route.' using errcode='23514'; end if;
  v_paid:=p_acquisition_mode in ('paid','both');
  v_organic:=p_acquisition_mode in ('organic','both');
  if (v_paid and coalesce(p_paid_platform,'') not in ('meta','google'))
    or (not v_paid and p_paid_platform is not null) then
    raise exception 'Choose Meta Ads or Google Ads only when this campaign runs paid.'
      using errcode='23514'; end if;
  if v_opportunity.status not in ('approved','active','learning','scaling')
    or not public.opportunity_approval_current_v6(p_opportunity_id) then
    raise exception 'Approve the current opportunity evidence before campaign planning.'
      using errcode='23514'; end if;
  select * into v_readiness from public.opportunity_readiness
    where opportunity_id=p_opportunity_id;
  if not found then
    raise exception 'Opportunity readiness could not be verified.' using errcode='23514'; end if;
  if v_readiness.blocker is not null then
    raise exception '%',v_readiness.blocker using errcode='23514'; end if;
  if p_offer_version_id is null then
    raise exception 'Choose an exact approved secondary offer version for this opportunity.'
      using errcode='23514';
  end if;
  select o.* into v_offer from public.service_offers o
    join public.service_offer_versions v on v.offer_id=o.id and v.client_id=o.client_id
    join public.service_offer_signoffs s on s.offer_version_id=v.id and s.client_id=v.client_id
    join public.opportunity_links l on l.offer_id=o.id and l.client_id=o.client_id
      and l.opportunity_id=p_opportunity_id and l.role='offer'
    join public.secondary_offer_sources_v7 source on source.offer_id=o.id
      and source.client_id=o.client_id and source.opportunity_id=p_opportunity_id
    where v.id=p_offer_version_id and v.client_id=v_opportunity.client_id
      and o.kind='secondary'
      and not exists(select 1 from public.service_offer_versions newer
        where newer.offer_id=o.id and newer.version>v.version)
    for share of o,v;
  if v_offer.id is null or not public.opportunity_approval_current_v6(p_opportunity_id)
      or not coalesce(public.secondary_offer_source_current_v7(v_offer.id),false) then
    raise exception 'Choose the current signed secondary offer for this approved opportunity.'
      using errcode='23514';
  end if;

  select c.* into v_campaign from public.client_campaigns c
    join public.opportunity_links l on l.campaign_id=c.id and l.client_id=c.client_id
      and l.opportunity_id=p_opportunity_id and l.role='campaign'
    where c.acquisition_mode=p_acquisition_mode
      and coalesce(c.paid_platform,'')=coalesce(p_paid_platform,'')
    order by c.created_at,c.id limit 1;
  if v_campaign.id is not null and v_campaign.offer_version_id is distinct from p_offer_version_id then
    raise exception 'This opportunity route already uses another offer version; review its campaign.'
      using errcode='23514';
  end if;
  if v_campaign.id is not null then return v_campaign; end if;

  insert into public.client_campaigns(
    client_id,name,brief,acquisition_mode,paid_platform,runs_organic,runs_paid,offer_version_id)
  values(v_opportunity.client_id,
    coalesce(nullif(btrim(coalesce(p_name,'')),''),v_opportunity.name),
    public.opportunity_brief_v6(p_opportunity_id),p_acquisition_mode,
    case when v_paid then p_paid_platform end,v_organic,v_paid,p_offer_version_id)
  returning * into v_campaign;
  insert into public.opportunity_links(opportunity_id,client_id,role,campaign_id)
    values(p_opportunity_id,v_opportunity.client_id,'campaign',v_campaign.id);
  insert into public.opportunity_events(opportunity_id,client_id,event,actor,detail)
    values(p_opportunity_id,v_opportunity.client_id,'linked',
      case when auth.role()='service_role' then 'agent' else 'human' end,
      'Campaign created: '||v_campaign.name||' ('||p_acquisition_mode||
        coalesce(' '||p_paid_platform,'')||').');
  if not public.opportunity_approval_current_v6(p_opportunity_id)
      or not coalesce(public.secondary_offer_source_current_v7(v_offer.id),false) then
    raise exception 'The opportunity or offer source changed during campaign creation.'
      using errcode='23514';
  end if;
  return v_campaign;
end $$;

revoke all on function public.create_campaign_from_opportunity_v7(uuid,uuid,text,text,text)
  from public,anon,authenticated,service_role;
grant execute on function public.create_campaign_from_opportunity_v7(uuid,uuid,text,text,text)
  to authenticated,service_role;
select public.lock_down_definer_functions();
commit;

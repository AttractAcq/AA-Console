-- A new campaign row made from an existing one is a new plan or route, not a
-- new commercial reason. Carry the source opportunity in the same transaction
-- and refuse a stale or mismatched selected offer. Historical unsourced rows
-- remain readable and cloneable as unsourced work until explicitly reconciled.
begin;

create function public.carry_campaign_opportunity_v7()
returns trigger language plpgsql security definer
set search_path=pg_catalog,public as $$
declare
  source_campaign public.client_campaigns%rowtype;
  source_opportunity uuid;
  source_count integer;
  selected_offer uuid;
begin
  if new.cloned_from_campaign_id is null then return new; end if;
  select * into source_campaign from public.client_campaigns
    where id=new.cloned_from_campaign_id for share;
  if source_campaign.id is null or source_campaign.client_id<>new.client_id then
    raise exception 'A campaign revision or clone needs a same-client source.'
      using errcode='23514'; end if;
  select count(*),min(l.opportunity_id::text)::uuid into source_count,source_opportunity
    from public.opportunity_links l
    where l.campaign_id=source_campaign.id and l.client_id=new.client_id
      and l.role='campaign';
  if source_count=0 then return new; end if;
  if source_count<>1 or not public.opportunity_approval_current_v6(source_opportunity) then
    raise exception 'Review the single current opportunity behind this campaign before cloning it.'
      using errcode='23514'; end if;
  select v.offer_id into selected_offer from public.service_offer_versions v
    join public.service_offer_signoffs s on s.offer_version_id=v.id and s.client_id=v.client_id
    join public.service_offers o on o.id=v.offer_id and o.client_id=v.client_id
    join public.secondary_offer_sources_v7 source on source.offer_id=o.id
      and source.client_id=o.client_id and source.opportunity_id=source_opportunity
    where v.id=new.offer_version_id and v.client_id=new.client_id and o.kind='secondary'
      and not exists(select 1 from public.service_offer_versions later
        where later.offer_id=v.offer_id and later.version>v.version);
  if selected_offer is null or
    not coalesce(public.secondary_offer_source_current_v7(selected_offer),false) then
    raise exception 'A clone or revision needs the current signed secondary offer for its opportunity.'
      using errcode='23514'; end if;
  insert into public.opportunity_links(opportunity_id,client_id,role,campaign_id)
    values(source_opportunity,new.client_id,'campaign',new.id);
  return new;
end $$;

create trigger campaign_clone_opportunity_v7
  after insert on public.client_campaigns for each row
  execute function public.carry_campaign_opportunity_v7();
revoke all on function public.carry_campaign_opportunity_v7()
  from public,anon,authenticated,service_role;
select public.lock_down_definer_functions();
commit;

-- The older opportunity creator has no exact offer-version argument. It may
-- return an existing route to an authorized caller, but it cannot create a
-- new commercial campaign under the sourced v7 contract.
begin;

create or replace function public.create_campaign_from_opportunity_v6(
  p_opportunity_id uuid,
  p_acquisition_mode text,
  p_paid_platform text default null,
  p_name text default null
) returns public.client_campaigns
language plpgsql volatile security definer
set search_path=pg_catalog,public as $$
declare
  opportunity public.market_opportunities%rowtype;
  existing public.client_campaigns%rowtype;
  readiness record;
begin
  select * into opportunity from public.market_opportunities
    where id=p_opportunity_id for share;
  if opportunity.id is null then
    raise exception 'No such opportunity.' using errcode='P0001'; end if;
  if coalesce(auth.role(),'')<>'service_role'
    and not coalesce(public.can_shape_opportunity(opportunity.client_id),false) then
    raise exception 'Only an admin or assigned client manager can read this opportunity route.'
      using errcode='42501'; end if;
  if p_acquisition_mode is null or p_acquisition_mode not in ('organic','paid','both')
    or (p_acquisition_mode in ('paid','both') and coalesce(p_paid_platform,'') not in ('meta','google'))
    or (p_acquisition_mode='organic' and p_paid_platform is not null) then
    raise exception 'Choose a valid organic, paid or combined route.' using errcode='22023'; end if;
  if opportunity.status not in ('approved','active','learning','scaling')
    or not public.opportunity_approval_current_v6(p_opportunity_id) then
    raise exception 'A current approved opportunity is required.' using errcode='23514'; end if;
  select * into readiness from public.opportunity_readiness
    where opportunity_id=p_opportunity_id;
  if not found or readiness.blocker is not null then
    raise exception 'Opportunity readiness must be current.' using errcode='23514'; end if;
  select c.* into existing from public.client_campaigns c
    join public.opportunity_links l on l.campaign_id=c.id and l.client_id=c.client_id
      and l.opportunity_id=p_opportunity_id and l.role='campaign'
    where c.acquisition_mode=p_acquisition_mode
      and coalesce(c.paid_platform,'')=coalesce(p_paid_platform,'')
    order by c.created_at,c.id limit 1;
  if existing.id is not null then return existing; end if;
  raise exception 'New campaigns require an exact signed secondary offer version; use create_campaign_from_opportunity_v7.'
    using errcode='23514';
end $$;

select public.lock_down_definer_functions();
commit;

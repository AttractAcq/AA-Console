-- The Campaign Factory's manual inputs belong to the same transaction as its
-- approved opportunity and exact secondary offer. A failed pillar or planner
-- queue must leave no half-created campaign behind.
begin;

create function public.create_sourced_campaign_plan_v7(
  p_client_id uuid,
  p_opportunity_id uuid,
  p_offer_version_id uuid,
  p_name text,
  p_direction text,
  p_acquisition_mode text,
  p_ideate_on_plan boolean,
  p_paid_platform text default null,
  p_template text default null,
  p_pillar_ids uuid[] default '{}'
) returns public.client_campaigns
language plpgsql volatile security definer
set search_path=pg_catalog,public as $$
declare
  opportunity public.market_opportunities%rowtype;
  existing public.client_campaigns%rowtype;
  campaign public.client_campaigns%rowtype;
  template_row public.campaign_template_matrix%rowtype;
  combined_brief text;
  pillar_count integer;
  chosen_pillars uuid[]:=coalesce(p_pillar_ids,'{}'::uuid[]);
begin
  if auth.role() is distinct from 'authenticated' or auth.uid() is null
    or public.current_role_of() is null then
    raise exception 'A provisioned human must create a campaign.' using errcode='42501'; end if;
  select * into opportunity from public.market_opportunities
    where id=p_opportunity_id and client_id=p_client_id for update;
  if opportunity.id is null or not coalesce(public.can_shape_opportunity(p_client_id),false) then
    raise exception 'Choose an approved opportunity belonging to this client.'
      using errcode='42501'; end if;
  if p_name is null or length(btrim(p_name)) not between 1 and 200
    or p_direction is null or length(btrim(p_direction)) not between 1 and 4000
    or p_ideate_on_plan is null then
    raise exception 'Name, planning direction and idea setting are required.'
      using errcode='22023'; end if;
  if p_acquisition_mode is null or p_acquisition_mode not in ('organic','paid','both') then
    raise exception 'Choose an organic, paid or combined route.' using errcode='22023'; end if;
  if (p_acquisition_mode in ('paid','both') and coalesce(p_paid_platform,'') not in ('meta','google'))
    or (p_acquisition_mode='organic' and p_paid_platform is not null) then
    raise exception 'Choose a paid platform only for a paid route.' using errcode='22023'; end if;
  if nullif(btrim(coalesce(p_template,'')),'') is not null then
    if p_paid_platform is distinct from 'meta' then
      raise exception 'Campaign templates require a Meta paid route.' using errcode='22023'; end if;
    select * into template_row from public.campaign_template_matrix
      where code::text=p_template;
    if template_row.code is null then
      raise exception 'Choose a known campaign template.' using errcode='22023'; end if;
  end if;
  select count(*) into pillar_count from public.client_content_pillars p
    where p.id=any(chosen_pillars) and p.client_id=p_client_id and p.active;
  if pillar_count<>cardinality(chosen_pillars) then
    raise exception 'Every selected pillar must be active and belong to this client.'
      using errcode='23514'; end if;
  select c.* into existing from public.client_campaigns c
    join public.opportunity_links l on l.campaign_id=c.id and l.client_id=c.client_id
      and l.opportunity_id=p_opportunity_id and l.role='campaign'
    where c.acquisition_mode=p_acquisition_mode
      and coalesce(c.paid_platform,'')=coalesce(p_paid_platform,'')
    order by c.created_at,c.id limit 1;
  if existing.id is not null then
    raise exception 'This opportunity already has a campaign for that route (%). Open it or revise its plan.',existing.id
      using errcode='23514'; end if;

  campaign:=public.create_campaign_from_opportunity_v7(
    p_opportunity_id,p_offer_version_id,p_acquisition_mode,p_paid_platform,p_name);
  combined_brief:=campaign.brief||E'\n\nOperator direction:\n'||btrim(p_direction);
  if length(combined_brief)>4000 then
    raise exception 'The opportunity brief and operator direction exceed 4,000 characters.'
      using errcode='22023'; end if;
  update public.client_campaigns set
    brief=combined_brief,
    ideate_on_plan=p_ideate_on_plan,
    template=template_row.code,
    entry_state=template_row.entry_state::public.audience_state,
    exit_state=template_row.exit_state::public.audience_state,
    optimisation_event=template_row.optimisation,
    needs_landing_page=coalesce(template_row.destination='page',false),
    needs_sales_agent=coalesce(template_row.destination='message',false)
    where id=campaign.id and client_id=p_client_id returning * into campaign;
  if cardinality(chosen_pillars)>0 then
    insert into public.campaign_content_pillars(campaign_id,pillar_id)
      select campaign.id,unnest(chosen_pillars);
  end if;
  perform public.enqueue_agent_job('campaign_plan',p_client_id,'client_campaigns',campaign.id);
  return campaign;
end $$;

revoke all on function public.create_sourced_campaign_plan_v7(uuid,uuid,uuid,text,text,text,boolean,text,text,uuid[])
  from public,anon,authenticated,service_role;
grant execute on function public.create_sourced_campaign_plan_v7(uuid,uuid,uuid,text,text,text,boolean,text,text,uuid[])
  to authenticated;
select public.lock_down_definer_functions();
commit;

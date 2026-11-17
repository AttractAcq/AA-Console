-- Human plan revisions are new campaign rows. Create them with the approved
-- opportunity, exact offer, pillars and planner job in one transaction, then
-- remove the authenticated table-insert bypass.
begin;

create function public.create_sourced_campaign_revision_v7(
  p_campaign_id uuid,
  p_brief text,
  p_offer_version_id uuid,
  p_template text default null
) returns public.client_campaigns
language plpgsql volatile security definer
set search_path=pg_catalog,public as $$
declare
  source_campaign public.client_campaigns%rowtype;
  revised public.client_campaigns%rowtype;
  template_row public.campaign_template_matrix%rowtype;
  source_opportunity uuid;
  source_count integer;
  invalid_pillars integer;
begin
  if auth.role() is distinct from 'authenticated' or auth.uid() is null
    or public.current_role_of() is null then
    raise exception 'A provisioned human must revise a campaign.' using errcode='42501'; end if;
  if p_brief is null or length(btrim(p_brief)) not between 1 and 4000
    or p_offer_version_id is null then
    raise exception 'Plan direction and exact signed offer version are required.'
      using errcode='22023'; end if;
  select * into source_campaign from public.client_campaigns
    where id=p_campaign_id for share;
  if source_campaign.id is null then
    raise exception 'Campaign not found.' using errcode='23514'; end if;
  select count(*),min(l.opportunity_id::text)::uuid
    into source_count,source_opportunity from public.opportunity_links l
    where l.campaign_id=p_campaign_id and l.client_id=source_campaign.client_id
      and l.role='campaign';
  if source_count<>1 or source_campaign.acquisition_mode not in ('organic','paid','both') then
    raise exception 'A sourced organic or paid campaign is required before revision.'
      using errcode='23514'; end if;
  perform 1 from public.market_opportunities
    where id=source_opportunity and client_id=source_campaign.client_id for update;
  if not found or not coalesce(public.can_shape_opportunity(source_campaign.client_id),false)
    or not public.opportunity_approval_current_v6(source_opportunity) then
    raise exception 'A current approved opportunity is required before revising this campaign.'
      using errcode='23514'; end if;
  if nullif(btrim(coalesce(p_template,'')),'') is not null then
    if source_campaign.paid_platform is distinct from 'meta' then
      raise exception 'Campaign templates require a Meta paid route.' using errcode='22023'; end if;
    select * into template_row from public.campaign_template_matrix
      where code::text=p_template;
    if template_row.code is null then
      raise exception 'Choose a known campaign template.' using errcode='22023'; end if;
  end if;
  select count(*) into invalid_pillars
    from public.campaign_content_pillars cp
    left join public.client_content_pillars p on p.id=cp.pillar_id
      and p.client_id=source_campaign.client_id and p.active
    where cp.campaign_id=p_campaign_id and p.id is null;
  if invalid_pillars>0 then
    raise exception 'A source content pillar is no longer active for this client.'
      using errcode='23514'; end if;

  insert into public.client_campaigns(
    client_id,name,brief,acquisition_mode,paid_platform,runs_organic,runs_paid,
    cloned_from_campaign_id,offer_version_id,ideate_on_plan,template,
    entry_state,exit_state,optimisation_event,needs_landing_page,needs_sales_agent)
  values(source_campaign.client_id,
    left(source_campaign.name,165)||' · Plan revision '||to_char(now(),'YYYY-MM-DD'),
    btrim(p_brief),source_campaign.acquisition_mode,source_campaign.paid_platform,
    source_campaign.runs_organic,source_campaign.runs_paid,
    source_campaign.id,p_offer_version_id,source_campaign.ideate_on_plan,
    template_row.code,template_row.entry_state::public.audience_state,
    template_row.exit_state::public.audience_state,template_row.optimisation,
    coalesce(template_row.destination='page',false),
    coalesce(template_row.destination='message',false))
  returning * into revised;
  -- The after-insert lineage trigger validates the source opportunity and
  -- selected signed offer before this statement can return.
  insert into public.campaign_content_pillars(campaign_id,pillar_id)
    select revised.id,cp.pillar_id from public.campaign_content_pillars cp
      where cp.campaign_id=p_campaign_id;
  perform public.enqueue_agent_job('campaign_plan',source_campaign.client_id,
    'client_campaigns',revised.id);
  return revised;
end $$;

-- Keep historical unsourced records readable, but do not manufacture another
-- unsourced campaign by cloning one. The existing after-insert trigger still
-- validates current approval and offer lineage for sourced clones.
create function public.prevent_unsourced_campaign_clone_v7()
returns trigger language plpgsql security definer
set search_path=pg_catalog,public as $$
begin
  if new.cloned_from_campaign_id is not null and not exists(
    select 1 from public.opportunity_links l
    where l.campaign_id=new.cloned_from_campaign_id
      and l.client_id=new.client_id and l.role='campaign') then
    raise exception 'Link an approved opportunity and signed offer before cloning this historical campaign.'
      using errcode='23514';
  end if;
  return new;
end $$;
create trigger campaign_source_before_clone_v7
  before insert on public.client_campaigns for each row
  execute function public.prevent_unsourced_campaign_clone_v7();

revoke insert on public.client_campaigns from anon,authenticated;
revoke all on function public.create_sourced_campaign_revision_v7(uuid,text,uuid,text)
  from public,anon,authenticated,service_role;
grant execute on function public.create_sourced_campaign_revision_v7(uuid,text,uuid,text)
  to authenticated;
revoke all on function public.prevent_unsourced_campaign_clone_v7()
  from public,anon,authenticated,service_role;
select public.lock_down_definer_functions();
commit;

-- A lead magnet is a reviewed requirement of the commercial plan.
alter table public.client_campaigns
  add column needs_lead_magnet boolean not null default false;

create or replace function public.campaign_plan_fingerprint(p_campaign public.client_campaigns)
returns text language sql stable set search_path=pg_catalog,public as $$
  select md5((jsonb_build_object(
    'objective', p_campaign.objective,
    'audience', p_campaign.audience,
    'offer_summary', p_campaign.offer_summary,
    'core_message', p_campaign.core_message,
    'channels', to_jsonb(coalesce(p_campaign.channels, array[]::text[])),
    'budget', p_campaign.budget,
    'starts_on', p_campaign.starts_on,
    'ends_on', p_campaign.ends_on,
    'kpi_metric', p_campaign.kpi_metric,
    'kpi_target', p_campaign.kpi_target,
    'content_count', p_campaign.content_count,
    'organic_content_count', p_campaign.organic_content_count,
    'paid_content_count', p_campaign.paid_content_count,
    'needs_landing_page', p_campaign.needs_landing_page,
    'needs_sales_agent', p_campaign.needs_sales_agent,
    'offer_version_id', p_campaign.offer_version_id)
    || case when p_campaign.needs_lead_magnet
      then jsonb_build_object('needs_lead_magnet',true) else '{}'::jsonb end
    || case when p_campaign.content_spec_hash is null then '{}'::jsonb
      else jsonb_build_object('content_spec_hash',p_campaign.content_spec_hash) end
    || case when p_campaign.content_spec_id is not null
      and p_campaign.content_ideas_generated_at is not null
      then jsonb_build_object('planned_ideas_hash',public.campaign_planned_idea_hash_v7(p_campaign.id),
        'planned_idea_epoch',p_campaign.planned_idea_epoch)
      else '{}'::jsonb end)::text)
$$;

create function public.set_campaign_magnet_requirement_v7(
  p_campaign_id uuid,p_required boolean
) returns void language plpgsql volatile security definer
set search_path=pg_catalog,public as $$
declare c public.client_campaigns%rowtype;
begin
  select * into c from public.client_campaigns where id=p_campaign_id for update;
  if c.id is null then raise exception 'Campaign unavailable.' using errcode='P0001'; end if;
  if p_required is null then raise exception 'Choose whether a lead magnet is required.'; end if;
  if auth.role()<>'service_role' and (auth.role()<>'authenticated'
    or auth.uid() is null or public.current_role_of() is null
    or not public.can_access_client(c.client_id)) then
    raise exception 'A client operator or trusted planner is required.' using errcode='42501';
  end if;
  if auth.role()='authenticated' and c.plan_approved_at is not null then
    raise exception 'Regenerate the plan to revise a reviewed magnet requirement.'
      using errcode='23514';
  end if;
  if c.needs_lead_magnet is distinct from p_required then
    update public.client_campaigns set needs_lead_magnet=p_required,
      plan_approved_at=null,plan_approved_by=null,plan_approved_fingerprint=null,
      updated_at=now() where id=c.id;
  end if;
end $$;
revoke all on function public.set_campaign_magnet_requirement_v7(uuid,boolean)
  from public,anon;
grant execute on function public.set_campaign_magnet_requirement_v7(uuid,boolean)
  to authenticated,service_role;
select public.lock_down_definer_functions();

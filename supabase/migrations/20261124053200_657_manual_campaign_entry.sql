-- Give manual campaign entry an explicit type without inventing lineage for
-- historical rows. Existing route and module columns remain the execution
-- authority; the type and their initial choices join the plan fingerprint for
-- new campaigns only. Older approved plan fingerprints keep their shape.
begin;

alter table public.client_campaigns
  add column campaign_kind text,
  add column creation_key text,
  add column creation_fingerprint text,
  add constraint client_campaign_kind_v11 check (
    campaign_kind is null or
    (campaign_kind='standalone_paid' and acquisition_mode='paid'
      and runs_paid and not runs_organic) or
    (campaign_kind='standalone_organic' and acquisition_mode='organic'
      and runs_organic and not runs_paid) or
    (campaign_kind='opportunity_campaign' and acquisition_mode in ('paid','organic','both'))
  ),
  add constraint client_campaign_creation_key_v11 check (
    creation_key is null or length(btrim(creation_key)) between 1 and 160);
create unique index client_campaign_creation_key_v11_unique
  on public.client_campaigns(client_id,creation_key) where creation_key is not null;

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
      else '{}'::jsonb end
    || case when p_campaign.campaign_kind is null then '{}'::jsonb
      else jsonb_build_object(
        'campaign_kind',p_campaign.campaign_kind,
        'acquisition_mode',p_campaign.acquisition_mode,
        'paid_platform',p_campaign.paid_platform,
        'selected_modules',jsonb_build_object(
          'landing_page',p_campaign.needs_landing_page,
          'sales_agent',p_campaign.needs_sales_agent,
          'lead_magnet',p_campaign.needs_lead_magnet)) end)::text)
$$;

-- No plan may silently change the operator's type or selected producers.
-- A different choice belongs to a new campaign revision and approval.
create function public.guard_campaign_entry_selection_v11()
returns trigger language plpgsql security definer
set search_path=pg_catalog,public as $$
begin
  if old.campaign_kind is not null and (
      new.campaign_kind is distinct from old.campaign_kind
      or new.acquisition_mode is distinct from old.acquisition_mode
      or new.paid_platform is distinct from old.paid_platform
      or new.needs_landing_page is distinct from old.needs_landing_page
      or new.needs_sales_agent is distinct from old.needs_sales_agent
      or new.needs_lead_magnet is distinct from old.needs_lead_magnet
      or new.offer_version_id is distinct from old.offer_version_id
      or new.creation_key is distinct from old.creation_key
      or new.creation_fingerprint is distinct from old.creation_fingerprint) then
    raise exception 'Create a campaign plan revision to change its type, channels, modules or offer.'
      using errcode='23514';
  end if;
  return new;
end $$;
create trigger guard_campaign_entry_selection_v11
  before update on public.client_campaigns for each row
  execute function public.guard_campaign_entry_selection_v11();
revoke all on function public.guard_campaign_entry_selection_v11()
  from public,anon,authenticated,service_role;

-- A standalone campaign may use a current approved offer but never needs an
-- opportunity. The request key keeps a retried form submission from creating
-- another campaign or planner job.
create function public.create_standalone_campaign_plan_v11(
  p_client_id uuid,p_campaign_kind text,p_name text,p_direction text,
  p_ideate_on_plan boolean,p_paid_platform text,p_offer_version_id uuid,
  p_needs_landing_page boolean,p_needs_sales_agent boolean,
  p_needs_lead_magnet boolean,p_pillar_ids uuid[],p_idempotency_key text
) returns public.client_campaigns language plpgsql volatile security definer
set search_path=pg_catalog,public as $$
declare c public.client_campaigns%rowtype; o public.service_offers%rowtype;
  v public.service_offer_versions%rowtype; chosen_pillars uuid[];
  request_hash text; pillar_count integer; v_paid boolean;
begin
  if auth.role() is distinct from 'authenticated' or auth.uid() is null
    or public.current_role_of() is null
    or not coalesce(public.can_shape_opportunity(p_client_id),false) then
    raise exception 'A client manager or admin must create a campaign.' using errcode='42501'; end if;
  if p_campaign_kind not in ('standalone_paid','standalone_organic')
    or p_name is null or length(btrim(p_name)) not between 1 and 200
    or p_direction is null or length(btrim(p_direction)) not between 1 and 4000
    or p_ideate_on_plan is null or p_needs_landing_page is null
    or p_needs_sales_agent is null or p_needs_lead_magnet is null
    or p_idempotency_key is null or length(btrim(p_idempotency_key)) not between 1 and 160 then
    raise exception 'Campaign type, purpose, module choices and request key are required.'
      using errcode='22023'; end if;
  v_paid:=p_campaign_kind='standalone_paid';
  if (v_paid and coalesce(p_paid_platform,'') not in ('meta','google'))
    or (not v_paid and p_paid_platform is not null) then
    raise exception 'Choose Meta or Google only for a standalone paid campaign.'
      using errcode='22023'; end if;
  chosen_pillars:=coalesce(p_pillar_ids,'{}'::uuid[]);
  if cardinality(chosen_pillars)<>cardinality(array(select distinct unnest(chosen_pillars))) then
    raise exception 'Choose each content pillar once.' using errcode='22023'; end if;
  select count(*) into pillar_count from public.client_content_pillars p
    where p.id=any(chosen_pillars) and p.client_id=p_client_id and p.active;
  if pillar_count<>cardinality(chosen_pillars) then
    raise exception 'Every chosen pillar must be active and belong to this client.'
      using errcode='23514'; end if;
  request_hash:=encode(sha256(convert_to(jsonb_build_object(
    'kind',p_campaign_kind,'name',btrim(p_name),'direction',btrim(p_direction),
    'ideate',p_ideate_on_plan,'paid_platform',p_paid_platform,
    'offer_version_id',p_offer_version_id,'landing_page',p_needs_landing_page,
    'sales_agent',p_needs_sales_agent,'lead_magnet',p_needs_lead_magnet,
    'pillars',to_jsonb(chosen_pillars))::text,'UTF8')),'hex');
  perform pg_advisory_xact_lock(hashtextextended(
    p_client_id::text||':standalone-campaign:'||btrim(p_idempotency_key),0));
  select * into c from public.client_campaigns
    where client_id=p_client_id and creation_key=btrim(p_idempotency_key);
  if found then
    if c.creation_fingerprint is distinct from request_hash then
      raise exception 'The request key belongs to another campaign input.' using errcode='23514'; end if;
    return c;
  end if;
  if p_offer_version_id is not null then
    select version_row.* into v from public.service_offer_versions version_row
      join public.service_offers offer_row on offer_row.id=version_row.offer_id
        and offer_row.client_id=version_row.client_id
      join public.service_offer_signoffs s on s.offer_version_id=version_row.id
        and s.client_id=version_row.client_id
      where version_row.id=p_offer_version_id and version_row.client_id=p_client_id
        and offer_row.archived_at is null
        and not exists(select 1 from public.service_offer_versions newer
          where newer.offer_id=offer_row.id and newer.version>version_row.version)
      for share of version_row;
    if not found then raise exception 'Choose a current approved offer version.' using errcode='23514'; end if;
    select * into o from public.service_offers where id=v.offer_id;
    if (o.kind='secondary' and not coalesce(public.secondary_offer_source_current_v7(o.id),false))
      or (o.kind='main' and exists(select 1 from public.main_offer_sources_v7 source
          where source.offer_id=o.id)
          and not coalesce(public.main_offer_source_current_v7(o.id),false))
      or (v.value_equation is not null and not public.offer_claims_supported_v11(v.id)) then
      raise exception 'The selected offer source or claim evidence is no longer current.'
        using errcode='23514'; end if;
  end if;
  insert into public.client_campaigns(client_id,name,brief,acquisition_mode,
    paid_platform,runs_organic,runs_paid,offer_version_id,ideate_on_plan,
    needs_landing_page,needs_sales_agent,needs_lead_magnet,campaign_kind,
    creation_key,creation_fingerprint)
  values(p_client_id,btrim(p_name),btrim(p_direction),
    case when v_paid then 'paid' else 'organic' end,
    p_paid_platform,not v_paid,v_paid,p_offer_version_id,p_ideate_on_plan,
    p_needs_landing_page,p_needs_sales_agent,p_needs_lead_magnet,
    p_campaign_kind,btrim(p_idempotency_key),request_hash)
  returning * into c;
  insert into public.campaign_content_pillars(campaign_id,pillar_id)
    select c.id,unnest(chosen_pillars);
  perform public.enqueue_agent_job('campaign_plan',p_client_id,'client_campaigns',c.id);
  return c;
end $$;
revoke all on function public.create_standalone_campaign_plan_v11(
  uuid,text,text,text,boolean,text,uuid,boolean,boolean,boolean,uuid[],text)
  from public,anon,authenticated,service_role;
grant execute on function public.create_standalone_campaign_plan_v11(
  uuid,text,text,text,boolean,text,uuid,boolean,boolean,boolean,uuid[],text)
  to authenticated;

-- Preserve the existing sourced writer and its exact source gates while the
-- new UI adds explicit type/module choices to the same transaction.
create function public.create_opportunity_campaign_plan_v11(
  p_client_id uuid,p_opportunity_id uuid,p_offer_version_id uuid,p_name text,
  p_direction text,p_acquisition_mode text,p_ideate_on_plan boolean,
  p_paid_platform text,p_template text,p_pillar_ids uuid[],
  p_needs_landing_page boolean,p_needs_sales_agent boolean,
  p_needs_lead_magnet boolean
) returns public.client_campaigns language plpgsql volatile security definer
set search_path=pg_catalog,public as $$
declare c public.client_campaigns%rowtype;
begin
  if p_needs_landing_page is null or p_needs_sales_agent is null
    or p_needs_lead_magnet is null then
    raise exception 'Choose the campaign modules before planning.' using errcode='22023'; end if;
  c:=public.create_sourced_campaign_plan_v7(p_client_id,p_opportunity_id,
    p_offer_version_id,p_name,p_direction,p_acquisition_mode,p_ideate_on_plan,
    p_paid_platform,p_template,p_pillar_ids);
  update public.client_campaigns set campaign_kind='opportunity_campaign',
    needs_landing_page=p_needs_landing_page,
    needs_sales_agent=p_needs_sales_agent,
    needs_lead_magnet=p_needs_lead_magnet
    where id=c.id and client_id=p_client_id returning * into c;
  return c;
end $$;
revoke all on function public.create_opportunity_campaign_plan_v11(
  uuid,uuid,uuid,text,text,text,boolean,text,text,uuid[],boolean,boolean,boolean)
  from public,anon,authenticated,service_role;
grant execute on function public.create_opportunity_campaign_plan_v11(
  uuid,uuid,uuid,text,text,text,boolean,text,text,uuid[],boolean,boolean,boolean)
  to authenticated;
select public.lock_down_definer_functions();
commit;

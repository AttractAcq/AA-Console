-- New MCP campaigns require the same approved opportunity and exact signed
-- secondary offer as the human entry. Old request IDs may replay their saved
-- result, but the legacy functions may not create another unsourced campaign.
begin;

create function public.mcp_campaign_create_v7(
  p_bot_id text, p_client_id uuid, p_opportunity_id uuid,
  p_offer_version_id uuid, p_name text, p_direction text,
  p_acquisition_mode text, p_paid_platform text,
  p_request_id text, p_execution_id text
) returns jsonb
language plpgsql volatile security definer
set search_path=pg_catalog,mcp_internal,public
set timezone='UTC' as $$
declare
  v_payload jsonb;
  v_existing jsonb;
  v_campaign public.client_campaigns%rowtype;
  v_result jsonb;
  v_job uuid;
  v_brief text;
begin
  perform mcp_internal.require_service_role();
  perform mcp_internal.require_campaign_execution_permission(
    p_bot_id,p_client_id,'campaign.create');
  perform mcp_internal.require_mcp_ids(p_request_id,p_execution_id);
  if p_opportunity_id is null or p_offer_version_id is null
    or p_name is null or length(btrim(p_name)) not between 1 and 200
    or p_direction is null or length(btrim(p_direction)) not between 1 and 4000
    or p_acquisition_mode not in ('organic','paid','both')
    or (p_acquisition_mode in ('paid','both') and p_paid_platform not in ('meta','google'))
    or (p_acquisition_mode='organic' and p_paid_platform is not null) then
    raise exception using message='invalid_request',errcode='P0001'; end if;

  v_payload:=jsonb_build_object(
    'action','create','opportunity_id',p_opportunity_id,
    'offer_version_id',p_offer_version_id,'name',btrim(p_name),
    'direction',btrim(p_direction),'acquisition_mode',p_acquisition_mode,
    'paid_platform',p_paid_platform);
  v_existing:=mcp_internal.take_campaign_request(
    p_bot_id,p_execution_id,'campaign.create',p_client_id,v_payload);
  if v_existing is not null then return v_existing; end if;

  -- The creator locks this opportunity. A second route creation waits and
  -- then observes the first; no duplicate planner job can be queued.
  perform 1 from public.market_opportunities
    where id=p_opportunity_id and client_id=p_client_id for update;
  if not found then
    raise exception 'Choose an approved opportunity for this client.' using errcode='23514'; end if;
  if exists(select 1 from public.client_campaigns c
      join public.opportunity_links l on l.campaign_id=c.id and l.client_id=c.client_id
      where l.opportunity_id=p_opportunity_id and l.role='campaign'
        and c.acquisition_mode=p_acquisition_mode
        and coalesce(c.paid_platform,'')=coalesce(p_paid_platform,'')) then
    raise exception 'This opportunity already has a campaign for that route.' using errcode='23514'; end if;
  v_campaign:=public.create_campaign_from_opportunity_v7(
    p_opportunity_id,p_offer_version_id,p_acquisition_mode,p_paid_platform,p_name);
  v_brief:=v_campaign.brief||E'\n\nOperator direction:\n'||btrim(p_direction);
  if length(v_brief)>4000 then
    raise exception 'The sourced brief and direction exceed 4,000 characters.' using errcode='22023'; end if;
  update public.client_campaigns set brief=v_brief
    where id=v_campaign.id and client_id=p_client_id returning * into v_campaign;
  v_job:=mcp_internal.enqueue_mcp_job(
    'campaign_plan',p_client_id,'client_campaigns',v_campaign.id,
    p_bot_id,p_request_id,p_execution_id,'campaign_agent_unavailable');
  v_result:=jsonb_build_object(
    'client_id',p_client_id,
    'campaign',mcp_internal.campaign_json(v_campaign)||jsonb_build_object(
      'acquisition_mode',v_campaign.acquisition_mode,
      'paid_platform',v_campaign.paid_platform,
      'offer_version_id',v_campaign.offer_version_id,
      'opportunity_id',p_opportunity_id),
    'job_id',v_job,'replayed',false);
  insert into mcp_internal.mcp_campaign_requests(
    bot_id,execution_id,request_id,tool,client_id,campaign_id,payload,result)
    values(p_bot_id,p_execution_id,p_request_id,'campaign.create',
      p_client_id,v_campaign.id,v_payload,v_result);
  return v_result;
end $$;

-- Replays retain their original v6 payload shapes. A new request must use v7.
create or replace function public.mcp_campaign_create_v6(
  p_bot_id text,p_client_id uuid,p_name text,p_brief text,
  p_acquisition_mode text,p_paid_platform text,p_request_id text,
  p_execution_id text
) returns jsonb language plpgsql volatile security definer
set search_path=pg_catalog,mcp_internal,public set timezone='UTC' as $$
declare v_existing jsonb; v_payload jsonb;
begin
  perform mcp_internal.require_service_role();
  perform mcp_internal.require_campaign_execution_permission(p_bot_id,p_client_id,'campaign.create');
  perform mcp_internal.require_mcp_ids(p_request_id,p_execution_id);
  v_payload:=jsonb_build_object('action','create','name',btrim(p_name),
    'brief',btrim(p_brief),'acquisition_mode',p_acquisition_mode,
    'paid_platform',p_paid_platform);
  v_existing:=mcp_internal.take_campaign_request(
    p_bot_id,p_execution_id,'campaign.create',p_client_id,v_payload);
  if v_existing is not null then return v_existing; end if;
  raise exception 'New campaign creation requires an approved opportunity and signed secondary offer.'
    using errcode='23514';
end $$;

create or replace function public.mcp_campaign_create_v6(
  p_bot_id text,p_client_id uuid,p_name text,p_brief text,
  p_acquisition_mode text,p_paid_platform text,p_request_id text,
  p_execution_id text,p_offer_version_id uuid
) returns jsonb language plpgsql volatile security definer
set search_path=pg_catalog,mcp_internal,public set timezone='UTC' as $$
declare v_existing jsonb; v_payload jsonb;
begin
  perform mcp_internal.require_service_role();
  perform mcp_internal.require_campaign_execution_permission(p_bot_id,p_client_id,'campaign.create');
  perform mcp_internal.require_mcp_ids(p_request_id,p_execution_id);
  v_payload:=jsonb_build_object('action','create','name',btrim(p_name),
    'brief',btrim(p_brief),'acquisition_mode',p_acquisition_mode,
    'paid_platform',p_paid_platform,'offer_version_id',p_offer_version_id);
  v_existing:=mcp_internal.take_campaign_request(
    p_bot_id,p_execution_id,'campaign.create',p_client_id,v_payload);
  if v_existing is not null then return v_existing; end if;
  raise exception 'New campaign creation requires an approved opportunity and signed secondary offer.'
    using errcode='23514';
end $$;

-- The original unversioned gateway path has no opportunity input. Preserve
-- exact historical replay, but hold any new create before its old insert path.
create or replace function public.mcp_campaign_execution(
  p_bot_id text,p_client_id uuid,p_action text,
  p_campaign_id uuid default null,p_limit integer default 25,
  p_after uuid default null,p_name text default null,p_brief text default null,
  p_status text default null,p_summary text default null,p_kind text default null,
  p_request_id text default null,p_execution_id text default null
) returns jsonb language plpgsql volatile security definer
set search_path=pg_catalog,mcp_internal,public set timezone='UTC' as $$
declare v_payload jsonb; v_existing jsonb;
begin
  perform mcp_internal.require_service_role();
  perform mcp_internal.require_active_bot(p_bot_id);
  perform mcp_internal.require_bot_client_grant(p_bot_id,p_client_id);
  if p_action='create' then
    perform mcp_internal.require_campaign_execution_permission(
      p_bot_id,p_client_id,'campaign.create');
    perform mcp_internal.require_mcp_ids(p_request_id,p_execution_id);
    v_payload:=jsonb_strip_nulls(jsonb_build_object(
      'action',p_action,'campaign_id',p_campaign_id,'name',p_name,
      'brief',p_brief,'status',p_status,'summary',p_summary,'kind',p_kind));
    v_existing:=mcp_internal.take_campaign_request(
      p_bot_id,p_execution_id,'campaign.create',p_client_id,v_payload);
    if v_existing is not null then return v_existing; end if;
    raise exception 'New campaign creation requires an approved opportunity and signed secondary offer.'
      using errcode='23514';
  end if;
  return mcp_internal.campaign_execution(
    p_bot_id,p_client_id,p_action,p_campaign_id,p_limit,p_after,
    p_name,p_brief,p_status,p_summary,p_kind,p_request_id,p_execution_id);
end $$;

revoke all on function public.mcp_campaign_create_v7(text,uuid,uuid,uuid,text,text,text,text,text,text)
  from public,anon,authenticated,service_role;
grant execute on function public.mcp_campaign_create_v7(text,uuid,uuid,uuid,text,text,text,text,text,text)
  to service_role;
select public.lock_down_definer_functions();
commit;

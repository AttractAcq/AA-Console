-- The existing MCP campaign.create RPC remains available for historical
-- clients. The v6 gateway calls this scoped, idempotent route-aware variant.
-- Until the exact-version approval executor is installed, no v6 campaign may
-- become live through the UI, the old MCP launch RPC, or a direct table write.
create or replace function public.guard_campaign_acquisition_route()
returns trigger language plpgsql set search_path = public as $$
begin
  if tg_op = 'UPDATE' and (
    old.acquisition_mode is distinct from new.acquisition_mode
    or old.paid_platform is distinct from new.paid_platform
    or old.cloned_from_campaign_id is distinct from new.cloned_from_campaign_id
  ) then
    raise exception 'Campaign route and lineage are immutable. Clone this campaign into a new route.';
  end if;
  if new.acquisition_mode <> 'legacy' and new.status = 'live'
     and (tg_op = 'INSERT' or old.status is distinct from 'live') then
    raise exception 'V6 campaign launch requires exact-version human approval. The approval executor is not connected yet.';
  end if;
  return new;
end;
$$;

create trigger guard_campaign_acquisition_route_insert
  before insert on public.client_campaigns
  for each row execute function public.guard_campaign_acquisition_route();

-- campaign.get and campaign.update use this shared projection. Include route
-- and lineage there as well as in the new create response.
create or replace function mcp_internal.campaign_json(c public.client_campaigns)
returns jsonb language plpgsql stable
set search_path = pg_catalog, mcp_internal, public as $$
begin
  return jsonb_build_object(
    'id', c.id, 'client_id', c.client_id,
    'name', c.name, 'brief', mcp_internal.clip_text(c.brief, 4000),
    'status', c.status,
    'acquisition_mode', c.acquisition_mode,
    'paid_platform', c.paid_platform,
    'cloned_from_campaign_id', c.cloned_from_campaign_id,
    'objective', mcp_internal.clip_text(c.objective, 2000),
    'audience', mcp_internal.clip_text(c.audience, 2000),
    'offer_summary', mcp_internal.clip_text(c.offer_summary, 2000),
    'core_message', mcp_internal.clip_text(c.core_message, 2000),
    'channels', to_jsonb(c.channels), 'budget', c.budget,
    'starts_on', c.starts_on, 'ends_on', c.ends_on,
    'kpi_metric', c.kpi_metric, 'kpi_target', c.kpi_target,
    'content_count', c.content_count,
    'needs_landing_page', c.needs_landing_page,
    'needs_sales_agent', c.needs_sales_agent,
    'ad_campaign_id', c.ad_campaign_id,
    'built_at', c.built_at, 'launched_at', c.launched_at,
    'created_at', c.created_at, 'updated_at', c.updated_at
  );
end;
$$;

create function public.mcp_campaign_create_v6(
  p_bot_id text,
  p_client_id uuid,
  p_name text,
  p_brief text,
  p_acquisition_mode text,
  p_paid_platform text,
  p_request_id text,
  p_execution_id text
) returns jsonb
language plpgsql volatile security definer
set search_path = pg_catalog, mcp_internal, public
set timezone = 'UTC'
as $$
declare
  v_campaign public.client_campaigns%rowtype;
  v_payload jsonb;
  v_existing jsonb;
  v_result jsonb;
  v_job uuid;
begin
  perform mcp_internal.require_service_role();
  perform mcp_internal.require_campaign_execution_permission(
    p_bot_id, p_client_id, 'campaign.create');
  perform mcp_internal.require_mcp_ids(p_request_id, p_execution_id);

  if p_name is null or length(btrim(p_name)) not between 1 and 200
     or p_brief is null or length(btrim(p_brief)) not between 1 and 4000
     or p_acquisition_mode is null or p_acquisition_mode not in ('organic', 'paid')
     or (p_acquisition_mode = 'paid' and coalesce(p_paid_platform, '') not in ('meta', 'google'))
     or (p_acquisition_mode = 'organic' and p_paid_platform is not null) then
    raise exception using message = 'invalid_request', errcode = 'P0001';
  end if;

  v_payload := jsonb_build_object(
    'action', 'create', 'name', btrim(p_name), 'brief', btrim(p_brief),
    'acquisition_mode', p_acquisition_mode, 'paid_platform', p_paid_platform
  );
  v_existing := mcp_internal.take_campaign_request(
    p_bot_id, p_execution_id, 'campaign.create', p_client_id, v_payload);
  if v_existing is not null then return v_existing; end if;

  insert into public.client_campaigns (
    client_id, name, brief, acquisition_mode, paid_platform
  ) values (
    p_client_id, btrim(p_name), btrim(p_brief), p_acquisition_mode, p_paid_platform
  ) returning * into v_campaign;
  v_job := mcp_internal.enqueue_mcp_job(
    'campaign_plan', p_client_id, 'client_campaigns', v_campaign.id,
    p_bot_id, p_request_id, p_execution_id, 'campaign_agent_unavailable');
  v_result := jsonb_build_object(
    'client_id', p_client_id,
    'campaign', mcp_internal.campaign_json(v_campaign) || jsonb_build_object(
      'acquisition_mode', v_campaign.acquisition_mode,
      'paid_platform', v_campaign.paid_platform,
      'cloned_from_campaign_id', v_campaign.cloned_from_campaign_id
    ),
    'job_id', v_job,
    'replayed', false
  );
  insert into mcp_internal.mcp_campaign_requests (
    bot_id, execution_id, request_id, tool, client_id, campaign_id, payload, result
  ) values (
    p_bot_id, p_execution_id, p_request_id, 'campaign.create',
    p_client_id, v_campaign.id, v_payload, v_result
  );
  return v_result;
end;
$$;

revoke all on function public.mcp_campaign_create_v6(text, uuid, text, text, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.mcp_campaign_create_v6(text, uuid, text, text, text, text, text, text)
  to service_role;

create function public.mcp_campaign_list_v6(
  p_bot_id text, p_client_id uuid, p_limit integer default 50, p_after uuid default null
) returns jsonb
language plpgsql volatile security definer
set search_path = pg_catalog, mcp_internal, public
set timezone = 'UTC'
as $$
declare
  v_items jsonb;
  v_next uuid;
begin
  perform mcp_internal.require_service_role();
  perform mcp_internal.require_campaign_execution_permission(
    p_bot_id, p_client_id, 'campaign.list');
  if p_limit is null or p_limit not between 1 and 100 then
    raise exception using message = 'invalid_request', errcode = 'P0001';
  end if;
  select coalesce(jsonb_agg(to_jsonb(x) order by x.id), '[]'::jsonb)
    into v_items
    from (
      select c.id, c.client_id, c.name,
        mcp_internal.clip_text(c.brief, 4000) as brief,
        c.status, c.acquisition_mode, c.paid_platform,
        c.cloned_from_campaign_id,
        mcp_internal.clip_text(c.objective, 2000) as objective,
        mcp_internal.clip_text(c.audience, 2000) as audience,
        mcp_internal.clip_text(c.offer_summary, 2000) as offer_summary,
        mcp_internal.clip_text(c.core_message, 2000) as core_message,
        to_jsonb(c.channels) as channels,
        c.budget, c.starts_on, c.ends_on, c.kpi_metric, c.kpi_target,
        c.content_count, c.needs_landing_page, c.needs_sales_agent,
        c.ad_campaign_id, c.built_at, c.launched_at,
        c.created_at, c.updated_at
      from public.client_campaigns c
      where c.client_id = p_client_id
        and (p_after is null or c.id > p_after)
      order by c.id
      limit p_limit + 1
    ) x;
  if jsonb_array_length(v_items) > p_limit then
    v_items := v_items - p_limit;
    v_next := (v_items -> (p_limit - 1) ->> 'id')::uuid;
  end if;
  return jsonb_build_object(
    'client_id', p_client_id,
    'projection', 'client_campaigns_execution_v6',
    'campaigns', v_items,
    'next_cursor', v_next
  );
end;
$$;

revoke all on function public.mcp_campaign_list_v6(text, uuid, integer, uuid)
  from public, anon, authenticated;
grant execute on function public.mcp_campaign_list_v6(text, uuid, integer, uuid)
  to service_role;

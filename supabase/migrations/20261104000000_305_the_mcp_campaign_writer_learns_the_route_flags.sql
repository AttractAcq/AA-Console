-- 305: mcp_campaign_create_v6 sets the route flags, and accepts 'both'.
--
-- THIS FIXES A REGRESSION MIGRATION 302 INTRODUCED.
--
-- 302 added runs_organic and runs_paid to client_campaigns, defaulting both to
-- false, and rewrote client_campaigns_acquisition_route_check so that the mode
-- must agree with the flags:
--
--   legacy  -> not runs_organic and not runs_paid and paid_platform is null
--   organic -> runs_organic and not runs_paid and paid_platform is null
--   paid    -> runs_paid and not runs_organic and paid_platform in (meta,google)
--   both    -> runs_organic and runs_paid and paid_platform in (meta,google)
--
-- 302 taught create_campaign_from_opportunity_v6 and clone_campaign_for_route
-- to set the flags. It did not touch mcp_campaign_create_v6, which sets the
-- mode and leaves the flags at their false defaults. Every branch of the CHECK
-- but 'legacy' requires at least one flag true, so since 302 was applied that
-- function cannot create a campaign in ANY v6 mode -- it raises a check
-- violation on the insert. Verified against the live constraint: the predicate
-- is false for ('organic',f,f,null), ('paid',f,f,'meta') and ('both',f,f,'meta'),
-- and true only for ('legacy',f,f,null).
--
-- It has not surfaced because no v6 campaign has ever been created: all 20
-- campaigns are 'legacy', and this path is service-role only, reached by a bot
-- rather than by the console. That makes it latent, not harmless -- before 302
-- this function worked for organic and paid, so 302 broke a working path.
--
-- campaign_execution, the third writer of this table, inserts only
-- (client_id, name, brief) and so takes the 'legacy' default with both flags
-- false. That satisfies the CHECK and needs no change.
--
-- AND 'both' BECOMES REACHABLE
--
-- 302 made 'both' a valid route and taught the opportunity and clone paths to
-- produce it, but this function's own validation still listed only organic and
-- paid, so the one remaining creation path refused it. A route the database
-- accepts and no creator can set is a schema-only feature.
--
-- The flags are derived here rather than taken as arguments. 302's design makes
-- the flags authoritative and the mode agree with them, which is right for a
-- caller that knows both; this caller is given only a mode, so the mode decides
-- and the derivation is written where it can be read next to the CHECK it has
-- to satisfy.
--
-- BOTH OVERLOADS ARE FIXED IN PLACE
--
-- 204 created the 8-argument form; 210 added the 9-argument form carrying
-- offer_version_id. Both still exist and both are broken. The 8-argument form
-- is not dead: mcp_internal.mcp_campaign_requests holds one historical
-- campaign.create row whose payload has no offer_version_id key, so that is the
-- form it came through.
--
-- So each is corrected in place and each keeps its own payload shape. Collapsing
-- the older one into a delegation would add 'offer_version_id': null to the
-- payload it records, and that payload is what take_campaign_request compares
-- when deciding whether a request is a replay. Changing the shape of an
-- idempotency key to save repetition is not a trade worth making on a
-- security-definer path.

create or replace function public.mcp_campaign_create_v6(
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
     or p_acquisition_mode is null
     or p_acquisition_mode not in ('organic', 'paid', 'both')
     or (p_acquisition_mode in ('paid', 'both')
         and coalesce(p_paid_platform, '') not in ('meta', 'google'))
     or (p_acquisition_mode = 'organic' and p_paid_platform is not null) then
    raise exception using message = 'invalid_request', errcode = 'P0001';
  end if;

  -- Payload shape unchanged: this form has never recorded offer_version_id,
  -- and take_campaign_request compares the payload to detect a replay.
  v_payload := jsonb_build_object(
    'action', 'create', 'name', btrim(p_name), 'brief', btrim(p_brief),
    'acquisition_mode', p_acquisition_mode, 'paid_platform', p_paid_platform
  );
  v_existing := mcp_internal.take_campaign_request(
    p_bot_id, p_execution_id, 'campaign.create', p_client_id, v_payload);
  if v_existing is not null then return v_existing; end if;

  insert into public.client_campaigns (
    client_id, name, brief, acquisition_mode, paid_platform,
    runs_organic, runs_paid
  ) values (
    p_client_id, btrim(p_name), btrim(p_brief), p_acquisition_mode,
    p_paid_platform,
    p_acquisition_mode in ('organic', 'both'),
    p_acquisition_mode in ('paid', 'both')
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

create or replace function public.mcp_campaign_create_v6(
  p_bot_id text, p_client_id uuid, p_name text, p_brief text,
  p_acquisition_mode text, p_paid_platform text, p_request_id text,
  p_execution_id text, p_offer_version_id uuid
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
     or p_acquisition_mode is null
     or p_acquisition_mode not in ('organic', 'paid', 'both')
     or (p_acquisition_mode in ('paid', 'both')
         and coalesce(p_paid_platform, '') not in ('meta', 'google'))
     or (p_acquisition_mode = 'organic' and p_paid_platform is not null) then
    raise exception using message = 'invalid_request', errcode = 'P0001';
  end if;
  v_payload := jsonb_build_object(
    'action', 'create', 'name', btrim(p_name), 'brief', btrim(p_brief),
    'acquisition_mode', p_acquisition_mode, 'paid_platform', p_paid_platform,
    'offer_version_id', p_offer_version_id
  );
  v_existing := mcp_internal.take_campaign_request(
    p_bot_id, p_execution_id, 'campaign.create', p_client_id, v_payload);
  if v_existing is not null then return v_existing; end if;
  insert into public.client_campaigns (
    client_id, name, brief, acquisition_mode, paid_platform, offer_version_id,
    runs_organic, runs_paid
  ) values (
    p_client_id, btrim(p_name), btrim(p_brief), p_acquisition_mode,
    p_paid_platform, p_offer_version_id,
    p_acquisition_mode in ('organic', 'both'),
    p_acquisition_mode in ('paid', 'both')
  ) returning * into v_campaign;
  v_job := mcp_internal.enqueue_mcp_job(
    'campaign_plan', p_client_id, 'client_campaigns', v_campaign.id,
    p_bot_id, p_request_id, p_execution_id, 'campaign_agent_unavailable');
  v_result := jsonb_build_object(
    'client_id', p_client_id,
    'campaign', mcp_internal.campaign_json(v_campaign) || jsonb_build_object(
      'acquisition_mode', v_campaign.acquisition_mode,
      'paid_platform', v_campaign.paid_platform,
      'cloned_from_campaign_id', v_campaign.cloned_from_campaign_id,
      'offer_version_id', v_campaign.offer_version_id
    ),
    'job_id', v_job, 'replayed', false
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

-- create or replace preserves grants, but they are restated so this file states
-- the whole reachability of what it defines rather than relying on history.
revoke all on function public.mcp_campaign_create_v6(
  text, uuid, text, text, text, text, text, text
) from public, anon, authenticated;
grant execute on function public.mcp_campaign_create_v6(
  text, uuid, text, text, text, text, text, text
) to service_role;
revoke all on function public.mcp_campaign_create_v6(
  text, uuid, text, text, text, text, text, text, uuid
) from public, anon, authenticated;
grant execute on function public.mcp_campaign_create_v6(
  text, uuid, text, text, text, text, text, text, uuid
) to service_role;

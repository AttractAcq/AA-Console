-- The Meta build already works. What it lacked was a reason to be allowed.
--
-- `meta_build` creates paused campaign, ad set, creative and ad objects on a
-- real account today, for legacy campaigns. For a v6 campaign it refuses, in
-- these words: "V6 Meta objects require a version-bound human approval before
-- an external build. The activation executor is not connected yet."
--
-- That refusal was right and is now out of date. 206 records the decision,
-- 230 executes it, and this migration is the gate the runner consults instead
-- of refusing outright.
--
-- A PAUSED OBJECT IS STILL AN EXTERNAL WRITE
--
-- Which is why the build is gated at all, and why activation stays a separate
-- decision rather than being folded into it. Three approvals, not one:
-- `meta_ad_build` creates paused objects, activation turns them on, and
-- `budget_change` moves spend. This migration supports the first. The other
-- two keep their "no executor" sentences, because turning on somebody's ad
-- spend is not a thing to ship as a side effect of making the build work.
--
-- WHAT THE PERSON IS AGREEING TO
--
-- Not "build the Meta campaign". The account, the objective, the audience,
-- the daily budget and its monthly ceiling, the exact creative assets at
-- their approved revisions, and the destination. Hashed together, so adding
-- a creative or raising the budget after the yes produces a different hash
-- and the build fails closed rather than spending against a decision nobody
-- made.

update public.campaign_action_executors
   set supported = true,
       note = 'Creates paused Meta objects from the approved package, re-checking the account, audience, budget and creative set against the approved hash immediately before the build. Activation and budget changes are separate decisions with their own approvals.'
 where action_key = 'meta_ad_build';

-- ---------------------------------------------------------------------------
-- The exact build
-- ---------------------------------------------------------------------------

-- Everything that decides what appears on the account, in one hash. Computed
-- in the database so the request, the review screen and the builder cannot
-- disagree about what was approved.
create function public.meta_build_payload_hash_v6(p_campaign_id uuid)
returns text language sql stable
set search_path = pg_catalog, public as $$
  select encode(sha256(convert_to(
    coalesce(i.ad_account_id, 'no-account') || '|' ||
    -- `template` is the campaign_template enum, so it is cast rather than
    -- coalesced against a string, which Postgres will not resolve.
    coalesce(c.template::text, 'no-template') || '|' ||
    coalesce(c.objective, '') || '|' ||
    coalesce(c.audience, '') || '|' ||
    coalesce(c.daily_budget::text, '0') || '|' ||
    coalesce(array_to_string(c.target_countries, ','), '') || '|' ||
    coalesce(c.conversion_event, '') || '|' ||
    coalesce(c.offer_version_id::text, 'no-offer') || '|' ||
    -- The creative set, at the revisions that were approved. Ordered, so the
    -- same set in a different order is the same build.
    coalesce((select string_agg(a.asset_id::text || ':' ||
                                coalesce(m.human_approved_at::text, 'unapproved'), ','
                                order by a.asset_id)
                from public.campaign_artifacts a
                join public.client_media_assets m on m.id = a.asset_id
               where a.campaign_id = c.id and a.kind = 'content'
                 and m.review_status = 'approved'), 'no-creative')
    , 'UTF8')), 'hex')
    from public.client_campaigns c
    left join public.client_integrations i
      on i.client_id = c.client_id and i.provider = 'meta'
   where c.id = p_campaign_id;
$$;

comment on function public.meta_build_payload_hash_v6(uuid) is
  'Everything that decides what appears on the ad account: account, objective, audience, budget, geography, conversion event, offer version and the approved creative set at its approved revisions. Adding a creative or raising the budget after the yes changes it.';

revoke all on function public.meta_build_payload_hash_v6(uuid) from public, anon;
grant execute on function public.meta_build_payload_hash_v6(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Asking
-- ---------------------------------------------------------------------------

create function public.request_campaign_meta_build_v6(p_campaign_id uuid, p_actor uuid)
returns uuid language plpgsql security definer
set search_path = pg_catalog, public as $$
declare
  v_campaign public.client_campaigns%rowtype;
  v_manifest public.campaign_manifest_versions%rowtype;
  v_hash text;
  v_account text;
  v_creative integer;
  v_approval public.campaign_action_approvals%rowtype;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Only the internal service can request a campaign action.';
  end if;
  select * into v_campaign from public.client_campaigns where id = p_campaign_id;
  if not found then raise exception 'No such campaign.'; end if;
  if v_campaign.acquisition_mode <> 'paid' or v_campaign.paid_platform <> 'meta' then
    raise exception 'That campaign is not a paid Meta campaign.';
  end if;

  select * into v_manifest from public.campaign_manifest_versions
   where campaign_id = p_campaign_id order by version desc limit 1;
  if not found then
    raise exception 'This campaign has no package yet. Plan it before asking to build.';
  end if;

  -- The ad account is the client's, on the integration. There is no
  -- per-campaign override and inventing one here would be a column the rest
  -- of the system has never heard of.
  select i.ad_account_id into v_account
    from public.client_integrations i
   where i.client_id = v_campaign.client_id and i.provider = 'meta';
  if nullif(btrim(coalesce(v_account, '')), '') is null then
    raise exception 'No Meta ad account is recorded for this client, so there is nothing to build on.';
  end if;

  select count(*) into v_creative
    from public.campaign_artifacts a
    join public.client_media_assets m on m.id = a.asset_id
   where a.campaign_id = p_campaign_id and a.kind = 'content'
     and m.review_status = 'approved' and m.human_approved_at is not null;
  if v_creative = 0 then
    -- A build with no approved creative would create empty ads. Refused at
    -- the ask, where it is cheap to explain.
    raise exception 'No approved creative is attached to this campaign yet.';
  end if;

  v_hash := public.meta_build_payload_hash_v6(p_campaign_id);

  select * into v_approval from public.request_campaign_action_approval_v6(
    v_manifest.id,
    'meta-build:' || p_campaign_id::text || ':' || v_hash,
    'meta_ad_build',
    'meta:' || v_account,
    v_hash,
    jsonb_build_object(
      'campaign_id', p_campaign_id,
      'ad_account', v_account,
      'objective', v_campaign.objective,
      'audience', v_campaign.audience,
      'daily_budget', v_campaign.daily_budget,
      'target_countries', v_campaign.target_countries,
      'conversion_event', v_campaign.conversion_event,
      'template', v_campaign.template::text,
      'approved_creative', v_creative,
      'creates', 'paused objects only — activation is a separate approval'));
  return v_approval.id;
end $$;

revoke all on function public.request_campaign_meta_build_v6(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.request_campaign_meta_build_v6(uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- The gate the builder consults
-- ---------------------------------------------------------------------------

-- Called by the `meta_build` runner in place of its blanket v6 refusal. It
-- answers one question: may this campaign be built right now, and under which
-- approval. Everything it checks is re-read here rather than carried from the
-- decision.
create function public.assert_meta_build_allowed_v6(p_campaign_id uuid)
returns uuid language plpgsql security definer
set search_path = pg_catalog, public as $$
declare
  v_campaign public.client_campaigns%rowtype;
  v_approval public.campaign_action_approvals%rowtype;
  v_manifest public.campaign_manifest_versions%rowtype;
  v_hash text;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Only the internal service may build Meta objects.';
  end if;
  select * into v_campaign from public.client_campaigns where id = p_campaign_id;
  if not found then raise exception 'No such campaign.'; end if;

  -- Legacy keeps its old behaviour untouched: this function is only consulted
  -- for a v6 route, and says so rather than silently permitting.
  if v_campaign.acquisition_mode = 'legacy' then
    raise exception 'A legacy campaign does not use the approval gate.';
  end if;

  if not coalesce((select ces.campaign_actions_enabled from public.client_engine_settings ces
                    where ces.client_id = v_campaign.client_id), false) then
    raise exception 'External campaign actions are off for this client.';
  end if;

  select * into v_approval from public.campaign_action_approvals
   where campaign_id = p_campaign_id and action_key = 'meta_ad_build' and status = 'approved'
   order by decided_at desc limit 1;
  if not found then
    raise exception 'No approved Meta build for this campaign. Ask for one and have it approved.';
  end if;

  select * into v_manifest from public.campaign_manifest_versions where id = v_approval.manifest_id;
  if exists (select 1 from public.campaign_manifest_versions v
              where v.campaign_id = p_campaign_id and v.version > v_manifest.version) then
    raise exception 'The campaign package was superseded after this build was approved. Ask again.';
  end if;

  -- The payload, recomputed. A creative added or a budget raised since the
  -- decision changes this, and the build stops rather than spending against
  -- something nobody agreed to.
  v_hash := public.meta_build_payload_hash_v6(p_campaign_id);
  if v_hash <> v_approval.artifact_version_hash then
    raise exception 'The build changed after it was approved — the account, budget, audience or creative set is not what was signed off. Ask again.';
  end if;

  -- Already built once under this approval. Meta object creation is not
  -- idempotent, and a second run makes a second campaign.
  if v_campaign.meta_campaign_id is not null then
    raise exception 'This campaign already has Meta objects (%). Building again would create a second set.',
      v_campaign.meta_campaign_id;
  end if;

  return v_approval.id;
end $$;

comment on function public.assert_meta_build_allowed_v6(uuid) is
  'May this v6 campaign be built on Meta right now, and under which approval. Replaces the meta_build runner''s blanket refusal; re-reads the switch, the package version, the payload hash and whether objects already exist.';

revoke all on function public.assert_meta_build_allowed_v6(uuid) from public, anon, authenticated;
grant execute on function public.assert_meta_build_allowed_v6(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- Why a build has not run
-- ---------------------------------------------------------------------------

create or replace view meta_build_due with (security_invoker = true) as
select
  c.id as campaign_id,
  c.client_id,
  c.name,
  c.meta_campaign_id,
  c.meta_ad_set_id,
  c.meta_built_at,
  a.id as approval_id,
  a.status as approval_status,
  a.artifact_version_hash as approved_hash,
  public.meta_build_payload_hash_v6(c.id) as current_hash,
  (select count(*) from public.campaign_artifacts ca
    join public.client_media_assets m on m.id = ca.asset_id
   where ca.campaign_id = c.id and ca.kind = 'content' and m.review_status = 'approved') as approved_creative,
  case
    when c.meta_campaign_id is not null then 'Built. Activation is a separate decision.'
    when not exists (select 1 from public.campaign_manifest_versions v where v.campaign_id = c.id)
      then 'No package yet. Plan the campaign first.'
    when not exists (select 1 from public.campaign_artifacts ca
                      join public.client_media_assets m on m.id = ca.asset_id
                     where ca.campaign_id = c.id and ca.kind = 'content'
                       and m.review_status = 'approved')
      then 'No approved creative is attached yet.'
    when a.id is null then 'Nobody has approved a build for this campaign.'
    when a.status <> 'approved' then 'The build approval is ' || a.status || '.'
    when a.artifact_version_hash <> public.meta_build_payload_hash_v6(c.id)
      then 'The account, budget, audience or creative set changed after approval. Ask again.'
    when not coalesce(ces.campaign_actions_enabled, false)
      then 'External campaign actions are off for this client.'
    else null
  end as blocker
from public.client_campaigns c
left join public.campaign_action_approvals a
  on a.campaign_id = c.id and a.action_key = 'meta_ad_build'
 and a.id = (select a2.id from public.campaign_action_approvals a2
              where a2.campaign_id = c.id and a2.action_key = 'meta_ad_build'
              order by a2.requested_at desc limit 1)
left join public.client_engine_settings ces on ces.client_id = c.client_id
where c.acquisition_mode = 'paid' and c.paid_platform = 'meta' and c.archived_at is null;

comment on view meta_build_due is
  'Every paid-Meta campaign and the one sentence saying why its objects have not been created. "Built. Activation is a separate decision." is deliberately not "live".';

grant select on meta_build_due to authenticated;

select lock_down_definer_functions();

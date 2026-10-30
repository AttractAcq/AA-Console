-- B010 / 290: contain every legacy browser Meta build producer while the
-- exact AAL2 Inbox decision and per-provider-write attestation are absent.
-- Existing jobs and Meta IDs remain readable for assisted reconciliation.

create or replace function public.enqueue_agent_job(
  p_agent_key text, p_client_id uuid default null,
  p_input_table text default null, p_input_id uuid default null
)
returns uuid language plpgsql security definer set search_path = public as $$
begin
  if public.current_role_of() is null then
    raise exception 'A provisioned console account is required.' using errcode = '42501';
  end if;
  if p_agent_key in ('meta_build', 'recruitment_meta_build') then
    raise exception 'Meta object creation requires an exact AAL2 Approval Inbox decision and a bound prewrite executor.'
      using errcode = '42501';
  end if;
  if p_client_id is null and not public.is_admin() then
    raise exception 'Only an admin may queue agency-wide work.' using errcode = '42501';
  end if;
  if p_client_id is not null and not public.can_access_client(p_client_id) then
    raise exception 'Not permitted for this client' using errcode = '42501';
  end if;
  return public.enqueue_agent_job_internal(
    p_agent_key, p_client_id, p_input_table, p_input_id, auth.uid()
  );
end;
$$;
revoke execute on function public.enqueue_agent_job(text,uuid,text,uuid)
  from public, anon;
grant execute on function public.enqueue_agent_job(text,uuid,text,uuid)
  to authenticated;

create or replace function public.request_meta_build(p_campaign_id uuid)
returns uuid language plpgsql security definer set search_path = public as $$
begin
  raise exception 'Legacy Meta builds are held. Clone into a paid Meta route and request exact AAL2 Inbox approval before any object creation.'
    using errcode = '42501';
end;
$$;
revoke execute on function public.request_meta_build(uuid)
  from public, anon;
grant execute on function public.request_meta_build(uuid)
  to authenticated, service_role;

-- This is a source snapshot, not a decision-ready proof of image bytes.
-- It contains every database field the current recruitment worker consumes
-- for account routing, campaign/ad-set setup and creative construction.
create function public.recruitment_meta_build_snapshot_v6(p_campaign_id uuid)
returns jsonb language sql stable security definer
set search_path = pg_catalog, public set timezone = 'UTC' as $$
  select jsonb_build_object(
    'campaign', jsonb_build_object(
      'id', c.id, 'client_id', c.client_id, 'name', c.name,
      'daily_budget', c.daily_budget, 'target_countries', c.target_countries,
      'conversion_event', c.conversion_event,
      'meta_campaign_id', c.meta_campaign_id,
      'meta_ad_set_id', c.meta_ad_set_id, 'meta_built_at', c.meta_built_at),
    'integrations', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', i.id, 'status', i.status,
        'ad_account_id', i.ad_account_id,
        'meta_page_id', i.meta_page_id, 'meta_pixel_id', i.meta_pixel_id,
        'credential_label', i.credential_label,
        'credential_secret_id', i.credential_secret_id
      ) order by i.id), '[]'::jsonb)
      from public.client_integrations i
      where i.client_id = c.client_id and i.provider = 'meta'),
    'selected_ads', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'selection', jsonb_build_object(
          'asset_id', s.asset_id, 'meta_image_hash', s.meta_image_hash,
          'meta_creative_id', s.meta_creative_id, 'meta_ad_id', s.meta_ad_id),
        'media', jsonb_build_object(
          'id', a.id, 'client_id', a.client_id, 'brief_id', a.brief_id,
          'title', a.title, 'media_type', a.media_type,
          'content_format', a.content_format,
          'storage_path', a.storage_path, 'review_status', a.review_status,
          'human_approved_at', a.human_approved_at,
          'archived_at', a.archived_at, 'purpose', a.purpose,
          'usage_rights', a.usage_rights),
        'brief', jsonb_build_object(
          'id', b.id, 'client_id', b.client_id, 'purpose', b.purpose,
          'status', b.status, 'archived_at', b.archived_at,
          'hook', b.hook, 'script', b.script,
          'compensation_text', b.compensation_text,
          'apply_url', b.apply_url, 'call_to_action', b.call_to_action)
      ) order by s.asset_id), '[]'::jsonb)
      from public.recruitment_meta_campaign_ads s
      left join public.client_media_assets a on a.id = s.asset_id
      left join public.client_briefs b on b.id = a.brief_id
      where s.campaign_id = c.id)
  )
  from public.recruitment_meta_campaigns c where c.id = p_campaign_id;
$$;
revoke all on function public.recruitment_meta_build_snapshot_v6(uuid)
  from public, anon, authenticated, service_role;

-- The old return type stays UUID, but it now identifies the immutable held
-- approval card. It never queues a job. Lock the campaign to serialize two
-- requests for the same source/version and make repeated requests idempotent.
create or replace function public.request_recruitment_meta_build(p_campaign_id uuid)
returns uuid language plpgsql volatile security definer
set search_path = pg_catalog, public set timezone = 'UTC' as $$
declare
  v_campaign public.recruitment_meta_campaigns%rowtype;
  v_snapshot jsonb;
  v_hash text;
  v_round integer;
  v_existing uuid;
  v_account text;
begin
  if auth.role() is distinct from 'authenticated' or auth.uid() is null
    or public.current_role_of() is null or not coalesce(public.is_admin(), false) then
    raise exception 'Only a provisioned admin may request a recruitment Meta build.'
      using errcode = '42501';
  end if;
  select * into v_campaign from public.recruitment_meta_campaigns
    where id = p_campaign_id for update;
  if not found then
    raise exception 'That recruitment campaign no longer exists.' using errcode = 'P0002';
  end if;
  if v_campaign.client_id is distinct from public.aa_house_client_id()
    or not public.can_access_client(v_campaign.client_id) then
    raise exception 'Recruitment must use the AA house account.' using errcode = '42501';
  end if;
  v_snapshot := public.recruitment_meta_build_snapshot_v6(v_campaign.id);
  if v_snapshot is null
    or jsonb_array_length(v_snapshot->'selected_ads') = 0 then
    raise exception 'Choose a recruitment campaign with selected ads.' using errcode = '23514';
  end if;
  v_hash := encode(sha256(convert_to(v_snapshot::text, 'UTF8')), 'hex');
  select r.id into v_existing from public.approval_requests_v6 r
   where r.source_system = 'aa_console'
     and r.source_kind = 'recruitment_meta_build'
     and r.source_id = v_campaign.id::text
     and r.artifact_hash = v_hash
     and r.expires_at > now()
     and not exists (select 1 from public.approval_decision_events_v6 d
       where d.request_id = r.id)
   order by r.requested_at desc, r.id desc limit 1;
  if v_existing is not null then return v_existing; end if;
  select count(*)::integer + 1 into v_round from public.approval_requests_v6 r
   where r.source_system = 'aa_console'
     and r.source_kind = 'recruitment_meta_build'
     and r.source_id = v_campaign.id::text;
  v_account := case when jsonb_array_length(v_snapshot->'integrations') = 1
    then v_snapshot->'integrations'->0->>'ad_account_id' else null end;
  return public.register_approval_request_v6(jsonb_build_object(
    'client_id', v_campaign.client_id,
    'source_system', 'aa_console',
    'source_kind', 'recruitment_meta_build',
    'source_id', v_campaign.id::text,
    'source_version', v_hash || ':v' || v_round::text,
    'title', 'Recruitment Meta build: ' || v_campaign.name,
    'artifact_hash', v_hash,
    'preview', v_snapshot,
    'destination', case when v_account is null then null
      else 'meta:' || v_account end,
    'account_ref', v_account,
    'budget', jsonb_build_object('daily_budget', v_campaign.daily_budget,
      'currency', null),
    'scope', jsonb_build_object(
      'campaign_id', v_campaign.id, 'client_id', v_campaign.client_id,
      'asset_ids', (select coalesce(jsonb_agg(s.asset_id order by s.asset_id), '[]'::jsonb)
        from public.recruitment_meta_campaign_ads s where s.campaign_id = v_campaign.id),
      'ad_account_id', v_account,
      'conversion_event', v_campaign.conversion_event),
    'owner_role', 'admin',
    'expires_at', now() + interval '7 days',
    'preview_blocker',
      'Recruitment Meta object creation is held: exact image bytes, account currency, AAL2 decision and last-moment provider-write attestation are not connected.',
    'requested_by', auth.uid(), 'requester_kind', 'human',
    'owning_path', '/approvals'
  ));
end;
$$;
revoke all on function public.request_recruitment_meta_build(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.request_recruitment_meta_build(uuid)
  to authenticated;

-- Preserve the original authoring validation and selected-ad relations, but
-- register the held Inbox request instead of starting an external job.
create or replace function public.create_recruitment_meta_campaign(
  p_name text, p_daily_budget numeric, p_target_countries text[], p_asset_ids uuid[]
)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_house uuid; v_id uuid; v_count integer;
begin
  if not is_admin() then raise exception 'Only an admin can distribute recruitment ads.'; end if;
  v_house := aa_house_client_id();
  if v_house is null or not can_access_client(v_house) then
    raise exception 'The AA house client is not available.';
  end if;
  if nullif(btrim(p_name),'') is null or length(btrim(p_name)) > 160 then
    raise exception 'Name this recruitment campaign.';
  end if;
  if p_daily_budget is null or p_daily_budget <= 0 then
    raise exception 'Set a positive daily budget.';
  end if;
  if p_target_countries is null or cardinality(p_target_countries) = 0
     or cardinality(p_target_countries) > 25
     or array_position(p_target_countries, null) is not null
     or array_to_string(p_target_countries, ',') !~ '^[A-Z]{2}(,[A-Z]{2})*$' then
    raise exception 'Choose valid two-letter countries.';
  end if;
  if p_asset_ids is null or cardinality(p_asset_ids) = 0 or cardinality(p_asset_ids) > 20 then
    raise exception 'Select between 1 and 20 recruitment ads.';
  end if;
  select count(distinct a.id)::integer into v_count
    from client_media_assets a
    join client_briefs b on b.id=a.brief_id and b.client_id=a.client_id
   where a.id = any(p_asset_ids) and a.client_id=v_house
     and a.purpose='recruitment' and b.purpose='recruitment'
     and a.review_status='approved' and a.media_type='image'
     and a.content_format is distinct from 'carousel'
     and nullif(btrim(a.storage_path),'') is not null
     and nullif(btrim(b.hook),'') is not null
     and nullif(btrim(b.script),'') is not null
     and b.call_to_action in ('APPLY_NOW','LEARN_MORE','SIGN_UP','CONTACT_US')
     and b.apply_url ~ '^https://';
  if v_count <> cardinality(p_asset_ids) then
    raise exception 'Select distinct approved AA recruitment images with complete ad copy and an HTTPS apply URL.';
  end if;
  insert into recruitment_meta_campaigns(client_id,name,daily_budget,target_countries,created_by)
  values(v_house,btrim(p_name),p_daily_budget,p_target_countries,auth.uid()) returning id into v_id;
  insert into recruitment_meta_campaign_ads(campaign_id,asset_id)
  select v_id,unnest(p_asset_ids);
  perform public.request_recruitment_meta_build(v_id);
  return v_id;
end;
$$;
revoke execute on function public.create_recruitment_meta_campaign(text,numeric,text[],uuid[])
  from public, anon;
grant execute on function public.create_recruitment_meta_campaign(text,numeric,text[],uuid[])
  to authenticated;

-- A frozen card stays visible but held while the source is the same exact
-- version. Editing account, budget, selection, media path, or creative copy
-- supersedes it. The source can never become decision-ready in this release.
create function public.recruitment_meta_build_source_state_v6(p_request_id uuid)
returns text language plpgsql stable security definer
set search_path = pg_catalog, public set timezone = 'UTC' as $$
declare
  v_request public.approval_requests_v6%rowtype;
  v_snapshot jsonb;
  v_hash text;
begin
  select * into v_request from public.approval_requests_v6 where id = p_request_id;
  if not found or v_request.source_system is distinct from 'aa_console'
    or v_request.source_kind is distinct from 'recruitment_meta_build' then
    return 'unverified';
  end if;
  if auth.role() is distinct from 'service_role'
    and (auth.role() is distinct from 'authenticated'
      or not coalesce(public.is_admin(), false)
      or not public.can_review_approval_request_v6(
        v_request.client_id, v_request.owner_role)) then
    return 'unverified';
  end if;
  if v_request.source_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then return 'unverified'; end if;
  v_snapshot := public.recruitment_meta_build_snapshot_v6(v_request.source_id::uuid);
  if v_snapshot is null then return 'cancelled'; end if;
  v_hash := encode(sha256(convert_to(v_snapshot::text, 'UTF8')), 'hex');
  if v_request.client_id is distinct from public.aa_house_client_id()
    or v_request.client_id::text is distinct from v_snapshot->'campaign'->>'client_id'
    or v_request.owner_role is distinct from 'admin'
    or v_request.requester_kind is distinct from 'human'
    or v_request.artifact_hash is distinct from v_hash
    or v_request.preview is distinct from v_snapshot
    or v_request.source_version !~ ('^' || v_hash || ':v[1-9][0-9]*$') then
    return 'superseded';
  end if;
  return 'source_held';
end;
$$;
revoke all on function public.recruitment_meta_build_source_state_v6(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.recruitment_meta_build_source_state_v6(uuid)
  to authenticated, service_role;

-- The 288 Inbox view is repeated below with one additional source kind; all
-- existing columns, order, RLS behavior and production-release hold remain.

create or replace view public.approval_inbox_v6 with (security_invoker = true) as
select
  r.id, r.client_id, r.source_system, r.source_kind, r.source_id,
  r.source_version, r.title,
  case
    when r.source_system = 'aa_console'
      and r.source_kind in ('production_release', 'recruitment_meta_build')
      and s.source_state = 'source_held'
      and r.expires_at is not null and r.expires_at <= now() then 'expired'
    when s.source_state in ('cancelled','superseded','source_held','unverified')
      then s.source_state
    when d.decision = 'revoked' then 'revoked'
    when d.decision = 'rejected' then 'rejected'
    when r.expires_at is not null and r.expires_at <= now() then 'expired'
    when d.decision = 'approved' then 'approved'
    when s.source_state <> 'pending' then s.source_state
    else 'pending'
  end as status,
  r.requested_at, r.requested_by, r.requester_kind, r.requester_ref,
  r.expires_at,
  coalesce(e.artifact_hash, r.artifact_hash) as artifact_hash,
  coalesce(e.preview, r.preview) as preview,
  coalesce(e.destination, r.destination) as destination,
  coalesce(e.account_ref, r.account_ref) as account_ref,
  coalesce(e.budget, r.budget) as budget,
  coalesce(e.scope, r.scope) as scope,
  r.owner_role,
  case
    when r.source_system = 'aa_console'
      and r.source_kind = 'production_release' then coalesce(
        nullif(btrim(r.preview_blocker), ''),
        'Release source and external effects are not independently attested.')
    when r.source_system = 'aa_console'
      and r.source_kind = 'recruitment_meta_build' then coalesce(
        nullif(btrim(r.preview_blocker), ''),
        'Recruitment Meta creation still lacks exact media bytes and an AAL2 prewrite gate.')
    when r.expires_at is null then 'An expiry is missing.'
    when nullif(btrim(coalesce(r.owner_role, '')), '') is null then 'The decision owner is missing.'
    when e.id is not null then null
    when nullif(btrim(coalesce(r.preview_blocker, '')), '') is not null then r.preview_blocker
    when r.artifact_hash is null then 'The exact artifact hash is missing.'
    when r.preview is null or jsonb_typeof(r.preview) <> 'object'
      or r.preview = '{}'::jsonb then 'The exact artifact preview is missing.'
    when r.scope is null or r.scope = '{}'::jsonb then 'The exact scope is missing.'
    else null
  end as preview_blocker,
  r.owning_path,
  s.source_state
from public.approval_requests_v6 r
left join public.approval_request_evidence_v6 e on e.request_id = r.id
left join lateral (
  select de.decision from public.approval_decision_events_v6 de
  where de.request_id = r.id
  order by de.event_order desc limit 1
) d on true
cross join lateral (
  select case
    when r.source_system = 'aa_console' and r.source_kind = 'production_release'
      then public.production_release_source_state_v6(r.id)
    when r.source_system = 'aa_console' and r.source_kind = 'recruitment_meta_build'
      then public.recruitment_meta_build_source_state_v6(r.id)
    else public.approval_source_state_v6(r.id)
  end as source_state
) s;
revoke all on public.approval_inbox_v6 from public, anon, authenticated, service_role;
grant select on public.approval_inbox_v6 to authenticated, service_role;

insert into public.approval_class_coverage_versions_v6 (
  class_id, revision, class_key, title, source_state, source_evidence,
  decision_state, decision_evidence, executor_state, executor_evidence, blocker
) values (
  18, 2, 'recruitment_meta_build', 'Recruitment Meta object build',
  'blocked', '290 immutable source snapshot and held Inbox card',
  'missing', null, 'missing', null,
  'Exact media bytes, source-owned AAL2 decision and per-provider-write executor attestation are absent.'
);

select public.lock_down_definer_functions();

-- Give the publisher a read-only view of the same exact source after a guarded claim.
-- The original scheduled-only snapshot continues to govern package registration
-- and human review. The claim RPC remains closed in migration 295.
begin;
create function public.organic_publication_claim_snapshot_v7(p_post_id uuid)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public set timezone = 'UTC' as $$
declare
  v_post public.scheduled_posts%rowtype;
  v_slot public.content_slots%rowtype;
  v_asset public.client_media_assets%rowtype;
  v_brief public.client_briefs%rowtype;
  v_idea public.client_ideas%rowtype;
  v_campaign public.client_campaigns%rowtype;
  v_copy public.post_copy_effective%rowtype;
  v_provider text;
  v_account text;
  v_account_count integer;
  v_paths jsonb;
begin
  select * into v_post from public.scheduled_posts where id = p_post_id;
  if not found or v_post.client_id is null or v_post.asset_id is null
    or v_post.platform is null or v_post.scheduled_at is null
    or v_post.channel is distinct from 'organic'::public.post_channel
    or (v_post.publication_status is distinct from 'scheduled'
      and v_post.publication_status is distinct from 'publishing')
    or v_post.published_at is not null
    then return null; end if;
  select * into v_asset from public.client_media_assets
    where id = v_post.asset_id and client_id = v_post.client_id;
  if not found or v_asset.review_status is distinct from 'approved'::public.review_status
    or v_asset.human_approved_at is null
    or v_asset.content_format is null
    or v_post.media_type is distinct from v_asset.media_type then return null; end if;
  select * into v_brief from public.client_briefs
    where id = v_asset.brief_id and client_id = v_post.client_id;
  if not found then return null; end if;
  select * into v_idea from public.client_ideas
    where id = v_brief.source_idea_id and client_id = v_post.client_id;
  if not found then return null; end if;
  select * into v_campaign from public.client_campaigns
    where id = v_idea.campaign_id and client_id = v_post.client_id;
  if not found or v_campaign.acquisition_mode is distinct from 'organic'
    or v_campaign.paid_platform is not null then return null; end if;
  if (select count(*) from public.content_slots
      where scheduled_post_id = v_post.id) <> 1 then return null; end if;
  select * into v_slot from public.content_slots
    where scheduled_post_id = v_post.id;
  if v_slot.stage is distinct from 'scheduled'::public.slot_stage
    or (v_slot.client_id, v_slot.asset_id, v_slot.brief_id,
        v_slot.idea_id, v_slot.platform, v_slot.scheduled_at)
       is distinct from
       (v_post.client_id, v_asset.id, v_brief.id,
        v_idea.id, v_post.platform, v_post.scheduled_at)
    then return null; end if;
  select * into v_copy from public.post_copy_effective
    where scheduled_post_id = v_post.id and platform = v_post.platform;
  if not found or nullif(btrim(coalesce(v_copy.caption, '')), '') is null
    then return null; end if;
  select provider into v_provider from public.platform_publishing
    where platform = v_post.platform and supported;
  if v_provider is null or v_provider not in ('instagram','meta')
    then return null; end if;
  if not exists (select 1 from public.platform_format_publishing pfp
      where pfp.platform = v_post.platform
        and pfp.content_format = v_asset.content_format
        and (pfp.media_type = v_post.media_type or pfp.media_type is null)
        and pfp.supported) then return null; end if;
  select count(*)::integer,
         max(case when v_provider = 'instagram' then credential_label
                  else meta_page_id end)
    into v_account_count, v_account
    from public.client_integrations
   where client_id = v_post.client_id and provider = v_provider
     and public.integration_state_eligible(status, token_expires_at)
     and credential_secret_id is not null;
  if v_account_count <> 1 or nullif(btrim(v_account), '') is null
    or not coalesce(public.integration_usable(v_post.client_id, v_provider), false)
    then return null; end if;
  if v_asset.content_format in ('carousel','story') then
    if exists (select 1 from public.client_media_frames f
      where f.asset_id = v_asset.id and
        (f.storage_path is null
         or f.storage_path not like v_post.client_id::text || '/%'
         or position('..' in f.storage_path) > 0)) then return null; end if;
    select coalesce(jsonb_agg(f.storage_path order by f.position), '[]'::jsonb)
      into v_paths from public.client_media_frames f where f.asset_id = v_asset.id;
    if jsonb_array_length(v_paths) < (case when v_asset.content_format = 'carousel' then 2 else 1 end)
      or jsonb_array_length(v_paths) > 10 then return null; end if;
  else
    if nullif(btrim(coalesce(v_asset.render_path, v_asset.storage_path)), '') is null
      or coalesce(v_asset.render_path, v_asset.storage_path)
        not like v_post.client_id::text || '/%'
      or position('..' in coalesce(v_asset.render_path, v_asset.storage_path)) > 0
      then return null; end if;
    v_paths := jsonb_build_array(coalesce(v_asset.render_path, v_asset.storage_path));
  end if;
  return jsonb_build_object(
    'client_id',v_post.client_id,'scheduled_post_id',v_post.id,
    'slot_id',v_slot.id,'campaign_id',v_campaign.id,
    'idea_id',v_idea.id,'brief_id',v_brief.id,'asset_id',v_asset.id,
    'platform',v_post.platform,'provider',v_provider,
    'account_ref',v_account,'scheduled_at',v_post.scheduled_at,
    'content_format',v_asset.content_format,'media_type',v_post.media_type,
    'source_paths',v_paths,
    'copy',jsonb_build_object(
      'caption',v_copy.caption,'hashtags',v_copy.hashtags,
      'alt_text',v_copy.alt_text,'link_url',v_copy.link_url,
      'first_comment',v_copy.first_comment),
    'rights',jsonb_build_object(
      'usage_rights',v_asset.usage_rights,
      'intake_source',v_asset.intake_source,
      'asset_human_approved_at',v_asset.human_approved_at));
end;
$$;
revoke all on function public.organic_publication_claim_snapshot_v7(uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.organic_publication_claim_snapshot_v7(uuid)
  to service_role;

-- This attests the exact review and current source for a post already leased
-- by the publisher. It does not claim work or prove a live provider scope.
create or replace function public.require_organic_publication_prewrite_v6(p_post_id uuid)
returns jsonb language plpgsql volatile security definer
set search_path=pg_catalog,public set timezone='UTC' as $$
declare
  v_post public.scheduled_posts%rowtype;
  v_package public.organic_publication_packages_v6%rowtype;
  v_request public.approval_requests_v6%rowtype;
  v_decision public.approval_decision_events_v6%rowtype;
  v_snapshot jsonb;
  v_source_hash text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the publisher may verify publication authority.'
      using errcode='42501';
  end if;
  select * into v_post from public.scheduled_posts
    where id=p_post_id for share;
  if not found or v_post.publication_status is distinct from 'publishing'
    or v_post.published_at is not null or v_post.publish_claimed_at is null
    or v_post.publish_claimed_at < clock_timestamp()-interval '15 minutes'
    or v_post.publish_claimed_at > clock_timestamp()+interval '1 minute'
    or v_post.channel is distinct from 'organic'::public.post_channel then
    raise exception 'This post has no current organic publication claim.'
      using errcode='23514';
  end if;
  if not exists (select 1 from public.client_engine_settings s
      where s.client_id=v_post.client_id and s.publishing_enabled) then
    raise exception 'Client publication switch is off.' using errcode='23514';
  end if;
  v_snapshot:=public.organic_publication_claim_snapshot_v7(p_post_id);
  if v_snapshot is null then
    raise exception 'The claimed post no longer matches its organic source.'
      using errcode='23514';
  end if;
  v_source_hash:=encode(sha256(convert_to(v_snapshot::text,'UTF8')),'hex');
  select * into v_package from public.organic_publication_packages_v6 p
    where p.scheduled_post_id=p_post_id
      and p.client_id=v_post.client_id
      and p.source_snapshot_hash=v_source_hash;
  if not found or v_package.manifest is distinct from
      (v_snapshot || jsonb_build_object(
        'media',v_package.manifest->'media',
        'provider_copy',v_package.manifest->'provider_copy'))
    or v_package.artifact_hash is distinct from
      encode(sha256(convert_to(v_package.manifest::text,'UTF8')),'hex')
    or coalesce(v_package.manifest->'rights'->>'usage_rights','')
      not in ('client_owned','licensed','agency_owned') then
    raise exception 'The frozen package is missing, stale or unlicensed.'
      using errcode='23514';
  end if;
  if jsonb_typeof(v_package.manifest->'media') is distinct from 'array'
    or jsonb_array_length(v_package.manifest->'media') < 1
    or exists (select 1
      from jsonb_array_elements(v_package.manifest->'media') item
      where item->>'frozen_bucket' is distinct from 'publication-media'
        or not exists(select 1 from storage.objects o
          where o.bucket_id='publication-media'
            and o.name=item->>'frozen_path')) then
    raise exception 'Frozen publication media is unavailable.' using errcode='23514';
  end if;
  if (select count(*) from public.approval_requests_v6 q
      where q.source_system='aa_console'
        and q.source_kind='organic_publication'
        and q.source_id=v_package.id::text) <> 1 then
    raise exception 'The exact publication review request is missing or ambiguous.'
      using errcode='23514';
  end if;
  select * into v_request from public.approval_requests_v6 q
    where q.source_system='aa_console'
      and q.source_kind='organic_publication'
      and q.source_id=v_package.id::text;
  if v_request.client_id is distinct from v_package.client_id
    or v_request.owner_role is distinct from 'client_media_reviewer'
    or v_request.requester_kind is distinct from 'service'
    or v_request.requester_ref is distinct from
      ('organic_publication_packages_v6:'||v_package.id::text)
    or v_request.expires_at is null
    or v_request.expires_at <= clock_timestamp()
    or v_request.source_version is distinct from v_package.artifact_hash
    or v_request.artifact_hash is distinct from v_package.artifact_hash
    or v_request.preview is distinct from v_package.manifest
    or v_request.destination is distinct from
      ('organic:'||(v_package.manifest->>'platform'))
    or v_request.account_ref is distinct from
      (v_package.manifest->>'account_ref')
    or v_request.scope is distinct from jsonb_build_object(
      'client_id',v_package.client_id,
      'scheduled_post_id',v_package.scheduled_post_id,
      'slot_id',v_package.slot_id,
      'source_snapshot_hash',v_package.source_snapshot_hash) then
    raise exception 'The exact publication review is stale or expired.'
      using errcode='23514';
  end if;
  if exists (select 1 from public.approval_request_evidence_v6 e
      where e.request_id=v_request.id and
        (e.artifact_hash is distinct from v_package.artifact_hash
          or e.preview is distinct from v_package.manifest
          or e.destination is distinct from v_request.destination
          or e.account_ref is distinct from v_request.account_ref
          or e.scope is distinct from v_request.scope)) then
    raise exception 'The publication review evidence changed.'
      using errcode='23514';
  end if;
  select * into v_decision from public.approval_decision_events_v6 d
    where d.request_id=v_request.id order by d.event_order desc limit 1;
  if not found or v_decision.decision is distinct from 'approved'
    or v_decision.actor_aal is distinct from 'aal2'
    or v_decision.artifact_hash is distinct from v_package.artifact_hash
    or v_decision.source_decision_ref is distinct from
      ('organic_publication_packages_v6:'||v_package.id::text) then
    raise exception 'Exact AAL2 publication approval is unavailable.'
      using errcode='42501';
  end if;
  return jsonb_build_object('artifact_hash',v_package.artifact_hash,
    'manifest',v_package.manifest);
end $$;
revoke all on function public.require_organic_publication_prewrite_v6(uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.require_organic_publication_prewrite_v6(uuid)
  to service_role;
select public.lock_down_definer_functions();
commit;

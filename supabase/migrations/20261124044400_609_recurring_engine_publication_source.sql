-- Recurring organic Engine slots have no commercial campaign route package.
-- Bind their publication snapshot to the exact slot source decision instead.
begin;
create or replace function public.organic_publication_source_snapshot_v6(p_post_id uuid)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public set timezone = 'UTC' as $$
declare
  v_post public.scheduled_posts%rowtype;
  v_slot public.content_slots%rowtype;
  v_asset public.client_media_assets%rowtype;
  v_brief public.client_briefs%rowtype;
  v_idea public.client_ideas%rowtype;
  v_campaign public.client_campaigns%rowtype;
  v_route public.campaign_route_packages_v6%rowtype;
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
    or v_post.publication_status is distinct from 'scheduled'
    or v_post.published_at is not null
    then return null; end if;
  select * into v_asset from public.client_media_assets
    where id = v_post.asset_id and client_id = v_post.client_id;
  if not found or v_asset.review_status is distinct from 'approved'::public.review_status
    or v_asset.human_approved_at is null
    or (v_asset.media_type::text in ('image','text')
      and v_asset.content_format in ('single','carousel','story')
      and public.organic_creative_source_current_v8(p_post_id) is not true)
    or v_asset.content_format is null
    or v_post.media_type is distinct from v_asset.media_type then return null; end if;
  select * into v_brief from public.client_briefs
    where id = v_asset.brief_id and client_id = v_post.client_id;
  if not found then return null; end if;
  select * into v_idea from public.client_ideas
    where id = v_brief.source_idea_id and client_id = v_post.client_id;
  if not found then return null; end if;
  if v_idea.campaign_id is not null then
    select * into v_campaign from public.client_campaigns
      where id = v_idea.campaign_id and client_id = v_post.client_id;
    if not found or not v_campaign.runs_organic
      or v_campaign.acquisition_mode not in ('organic','both')
      or v_idea.acquisition_route is distinct from 'organic' then return null; end if;
    select * into v_route from public.campaign_route_packages_v6
      where campaign_id = v_campaign.id and client_id = v_campaign.client_id
        and route = 'organic' order by version desc limit 1;
    if not found or v_route.plan_fingerprint is distinct from
        public.campaign_plan_fingerprint(v_campaign) then return null; end if;
  end if;
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
  -- The recurring Engine has no commercial campaign. Its own exact AAL2
  -- source decision and slot-bound idea are the route identity instead.
  if v_idea.campaign_id is null and (
    v_idea.slot_id is distinct from v_slot.id
    or (v_idea.acquisition_route is not null
      and v_idea.acquisition_route <> 'organic')
    or v_asset.media_type::text not in ('image','text')
    or v_asset.content_format is distinct from 'single'
    or public.organic_creative_source_current_v8(p_post_id) is not true
  ) then return null; end if;
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
    'route_package_id',v_route.id,'route_package_version',v_route.version,
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
      'asset_human_approved_at',v_asset.human_approved_at))
    || case when v_idea.campaign_id is null
      then jsonb_build_object('source_mode','recurring_engine')
      else '{}'::jsonb end;
end;
$$;

create or replace function public.organic_publication_claim_snapshot_v7(p_post_id uuid)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public set timezone = 'UTC' as $$
declare
  v_post public.scheduled_posts%rowtype;
  v_slot public.content_slots%rowtype;
  v_asset public.client_media_assets%rowtype;
  v_brief public.client_briefs%rowtype;
  v_idea public.client_ideas%rowtype;
  v_campaign public.client_campaigns%rowtype;
  v_route public.campaign_route_packages_v6%rowtype;
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
    or (v_asset.media_type::text in ('image','text')
      and v_asset.content_format in ('single','carousel','story')
      and public.organic_creative_source_current_v8(p_post_id) is not true)
    or v_asset.content_format is null
    or v_post.media_type is distinct from v_asset.media_type then return null; end if;
  select * into v_brief from public.client_briefs
    where id = v_asset.brief_id and client_id = v_post.client_id;
  if not found then return null; end if;
  select * into v_idea from public.client_ideas
    where id = v_brief.source_idea_id and client_id = v_post.client_id;
  if not found then return null; end if;
  if v_idea.campaign_id is not null then
    select * into v_campaign from public.client_campaigns
      where id = v_idea.campaign_id and client_id = v_post.client_id;
    if not found or not v_campaign.runs_organic
      or v_campaign.acquisition_mode not in ('organic','both')
      or v_idea.acquisition_route is distinct from 'organic' then return null; end if;
    select * into v_route from public.campaign_route_packages_v6
      where campaign_id = v_campaign.id and client_id = v_campaign.client_id
        and route = 'organic' order by version desc limit 1;
    if not found or v_route.plan_fingerprint is distinct from
        public.campaign_plan_fingerprint(v_campaign) then return null; end if;
  end if;
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
  -- The recurring Engine has no commercial campaign. Its own exact AAL2
  -- source decision and slot-bound idea are the route identity instead.
  if v_idea.campaign_id is null and (
    v_idea.slot_id is distinct from v_slot.id
    or (v_idea.acquisition_route is not null
      and v_idea.acquisition_route <> 'organic')
    or v_asset.media_type::text not in ('image','text')
    or v_asset.content_format is distinct from 'single'
    or public.organic_creative_source_current_v8(p_post_id) is not true
  ) then return null; end if;
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
    'route_package_id',v_route.id,'route_package_version',v_route.version,
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
      'asset_human_approved_at',v_asset.human_approved_at))
    || case when v_idea.campaign_id is null
      then jsonb_build_object('source_mode','recurring_engine')
      else '{}'::jsonb end;
end;
$$;

create or replace view public.publish_due with (security_invoker = true) as
select
  sp.id as post_id, sp.client_id, c.name as client_name, sp.platform,
  sp.scheduled_at, sp.media_type, sp.publication_status,
  sp.publish_attempts, sp.publish_claimed_at,
  a.id as asset_id, a.title as asset_title,
  coalesce(a.render_path, a.storage_path) as media_path,
  a.human_approved_at, pce.caption, pce.hashtags, pce.alt_text,
  pce.link_url, pce.first_comment, pp.provider,
  pp.supported as platform_supported,
  case
    when sp.asset_id is null or a.id is null then 'The asset is gone. This post can never be published.'
    when sp.client_id is null or a.client_id is distinct from sp.client_id
      then 'The scheduled post and asset belong to different clients.'
    when sp.channel is distinct from 'organic'::public.post_channel
      then 'Paid posts use the Ads Studio route, not the organic publisher.'
    when b.id is null or b.client_id is distinct from sp.client_id
      then 'The asset has no verified brief for this client.'
    when i.id is null or i.client_id is distinct from sp.client_id
      then 'The brief has no verified campaign idea for this client.'
    when i.campaign_id is not null and
      (ca.id is null or ca.client_id is distinct from sp.client_id)
      then 'The idea has no verified campaign for this client.'
    when i.campaign_id is null and
      (a.media_type::text not in ('image','text') or a.content_format is distinct from 'single'
       or i.acquisition_route = 'paid')
      then 'This recurring Engine slot lacks a supported exact single-file source decision.'
    when i.campaign_id is not null and ca.acquisition_mode = 'paid'
      then 'This asset belongs to a paid campaign and cannot use organic publishing.'
    when i.campaign_id is not null and
      (i.acquisition_route is distinct from 'organic'
       or not ca.runs_organic or ca.acquisition_mode not in ('organic','both'))
      then 'This campaign has no explicit organic publishing route.'
    when coalesce(sr.slot_count, 0) = 0
      then 'This calendar entry has no approved Engine slot. An exact-version publication approval must be connected through Approval Inbox before it can publish.'
    when sr.slot_count <> 1 or not coalesce(sr.matches, false)
      then 'The Engine slot and asset campaign lineage do not match this post.'
    when a.review_status is distinct from 'approved'::public.review_status
      then 'The asset approval was revoked.'
    when a.human_approved_at is null then 'Nobody has approved the asset.'
    when a.media_type::text in ('image','text')
      and a.content_format in ('single','carousel','story')
      and public.organic_creative_source_current_v8(sp.id) is not true
      then 'The exact creative source signoff is missing or stale. Request a new source review in Approval Inbox.'
    when sp.platform is null then 'The post has no platform.'
    when pp.platform is null or not pp.supported
      then 'There is no adapter for ' || coalesce(sp.platform::text, 'this platform') || '.'
    when pfp.platform is not null and not pfp.supported and pfp.media_type is not null
      then 'A ' || a.content_format::text || ' made of ' || sp.media_type::text
           || ' cannot be sent to ' || sp.platform::text || ' yet.'
    when pfp.platform is null or not pfp.supported
      then 'A ' || a.content_format::text || ' cannot be sent to ' || sp.platform::text
           || ' yet. Publishing it now would post the first frame on its own and record it as published.'
    when a.content_format = 'carousel' and coalesce(fr.frames, 0) < 2
      then 'A carousel needs at least two frames. This one has '
           || coalesce(fr.frames, 0)::text || ' on file.'
    when a.content_format = 'carousel' and fr.frames > 10
      then 'This carousel has ' || fr.frames::text || ' frames. Ten is the most either platform takes.'
    when a.content_format = 'story' and coalesce(fr.frames, 0) < 1
      then 'This story has no frames on file.'
    when not coalesce(ces.publishing_enabled, false)
      then 'Publishing is off for this client.'
    when not public.integration_usable(sp.client_id, pp.provider)
      then 'No usable ' || pp.provider || ' integration for this client.'
    when pce.caption is null or btrim(pce.caption) = ''
      then 'There is no caption for ' || sp.platform::text || '.'
    when sp.scheduled_at > now() then 'Not due yet.'
    when not exists (select 1 from public.organic_publication_packages_v6 p
      where p.scheduled_post_id = sp.id)
      then 'No immutable outgoing media-byte package exists for this post. Approval Inbox must review the exact destination, account, copy, time and rights.'
    when public.organic_publication_scheduled_authority_v8(sp.id) then null
    else 'The frozen package has no current exact AAL2 approval, route or rights; publication remains held.'
  end as blocker,
  a.content_format, coalesce(pfp.supported, false) as format_supported
from public.scheduled_posts sp
left join public.clients c on c.id = sp.client_id
left join public.client_media_assets a on a.id = sp.asset_id
left join public.client_briefs b on b.id = a.brief_id
left join public.client_ideas i on i.id = b.source_idea_id
left join public.client_campaigns ca on ca.id = i.campaign_id
left join lateral (
  select count(*)::int as slot_count,
         bool_and(s.stage = 'scheduled' and s.client_id = sp.client_id
           and s.asset_id = sp.asset_id and s.brief_id = b.id
           and s.idea_id = i.id and (i.campaign_id is not null or i.slot_id = s.id)
           and s.platform = sp.platform
           and s.scheduled_at = sp.scheduled_at) as matches
    from public.content_slots s where s.scheduled_post_id = sp.id
) sr on true
left join public.client_engine_settings ces on ces.client_id = sp.client_id
left join public.platform_publishing pp on pp.platform = sp.platform
left join lateral (
  select x.platform, x.supported, x.media_type
    from public.platform_format_publishing x
   where x.platform = sp.platform and x.content_format = a.content_format
     and (x.media_type is null or x.media_type = sp.media_type)
   order by x.media_type nulls last limit 1
) pfp on true
left join lateral (
  select count(*)::int as frames from public.client_media_frames f
   where f.asset_id = a.id
) fr on true
left join public.post_copy_effective pce
  on pce.scheduled_post_id = sp.id and pce.platform = sp.platform
where sp.publication_status in ('scheduled','publishing')
  and sp.published_at is null;
comment on view public.publish_due is
  'A null blocker means the exact scheduled package has current AAL2 approval; the publisher still rechecks after claiming and runs provider preflight before any write.';
grant select on public.publish_due to authenticated;


select public.lock_down_definer_functions();
commit;

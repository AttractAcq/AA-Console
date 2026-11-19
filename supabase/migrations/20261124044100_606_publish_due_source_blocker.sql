-- Explain the source-review hold before the destination approval blocker.
begin;
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
    when ca.id is null or ca.client_id is distinct from sp.client_id
      then 'The idea has no verified campaign for this client.'
    when ca.acquisition_mode = 'paid'
      then 'This asset belongs to a paid campaign and cannot use organic publishing.'
    when i.acquisition_route is distinct from 'organic'
      or not ca.runs_organic or ca.acquisition_mode not in ('organic','both')
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
           and s.idea_id = i.id and s.platform = sp.platform
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

commit;

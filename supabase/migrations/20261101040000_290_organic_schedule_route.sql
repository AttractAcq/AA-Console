-- B011: the organic route is a database boundary.
--
-- Browser checks are helpful but cannot protect a direct RPC call. The
-- publisher's existing due view and claim also accepted paid and legacy rows
-- if their media and caption were ready. Preserve historical rows for review,
-- but give every unverified route a named blocker and never claim it.
--
-- This migration does not turn manual calendar entries into publishable posts:
-- a post without exactly one matching approved Engine slot stays blocked until
-- an exact-version Approval Inbox binding is implemented (B008/B076/B080).

create index if not exists content_slots_post_route_idx
  on public.content_slots (scheduled_post_id)
  where scheduled_post_id is not null;

create or replace function public.schedule_asset(
  p_asset_id uuid,
  p_date date,
  p_channel public.post_channel default 'organic'::public.post_channel,
  p_platform public.post_platform default null::public.post_platform,
  p_time time default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_asset public.client_media_assets%rowtype;
  v_brief public.client_briefs%rowtype;
  v_idea public.client_ideas%rowtype;
  v_campaign public.client_campaigns%rowtype;
  v_id uuid;
begin
  if coalesce(auth.role(), '') <> 'authenticated' or auth.uid() is null then
    raise exception 'A signed-in console user must schedule this asset.' using errcode = '42501';
  end if;
  if p_date is null then
    raise exception 'Choose a date before scheduling.' using errcode = 'P0001';
  end if;
  if p_channel is distinct from 'organic'::public.post_channel then
    raise exception 'Paid scheduling uses the Ads Studio route, not organic distribution.' using errcode = 'P0001';
  end if;

  -- FOR SHARE conflicts with updates to approval, client and lineage fields.
  -- The validated chain cannot be edited between this read and the insert.
  select * into v_asset from public.client_media_assets
   where id = p_asset_id for share;
  if not found then
    raise exception 'Asset not found.' using errcode = 'P0001';
  end if;
  if public.can_access_client(v_asset.client_id) is not true then
    raise exception 'Not permitted for this client.' using errcode = '42501';
  end if;
  if v_asset.review_status is distinct from 'approved'::public.review_status then
    raise exception 'Asset must be approved before it can be scheduled.' using errcode = 'P0001';
  end if;
  if v_asset.human_approved_at is null then
    raise exception 'That asset has not been approved by a person yet. Approve it in Approvals before scheduling it.' using errcode = 'P0001';
  end if;
  if v_asset.brief_id is null then
    raise exception 'Scheduling blocked: this asset has no verified organic campaign brief.' using errcode = 'P0001';
  end if;

  select * into v_brief from public.client_briefs
   where id = v_asset.brief_id for share;
  if not found or v_brief.client_id is distinct from v_asset.client_id
     or v_brief.source_idea_id is null then
    raise exception 'Scheduling blocked: the asset brief has no same-client campaign idea.' using errcode = 'P0001';
  end if;

  select * into v_idea from public.client_ideas
   where id = v_brief.source_idea_id for share;
  if not found or v_idea.client_id is distinct from v_asset.client_id
     or v_idea.campaign_id is null then
    raise exception 'Scheduling blocked: the brief idea has no same-client campaign.' using errcode = 'P0001';
  end if;

  select * into v_campaign from public.client_campaigns
   where id = v_idea.campaign_id for share;
  if not found or v_campaign.client_id is distinct from v_asset.client_id then
    raise exception 'Scheduling blocked: the campaign belongs to another client or is missing.' using errcode = 'P0001';
  end if;
  if v_campaign.acquisition_mode = 'paid' then
    raise exception 'Scheduling blocked: this asset belongs to a paid campaign. Use Ads Studio.' using errcode = 'P0001';
  end if;
  if v_campaign.acquisition_mode is distinct from 'organic' or v_campaign.paid_platform is not null then
    raise exception 'Scheduling blocked: this campaign has no explicit organic route.' using errcode = 'P0001';
  end if;

  -- A missing time is still the current contract: the existing BEFORE
  -- trigger applies the client's default 09:00 local time.
  insert into public.scheduled_posts
    (asset_id, scheduled_for, scheduled_at, channel, platform, created_by)
  values (
    p_asset_id, p_date,
    case when p_time is null then null
         else (p_date + p_time) at time zone public.client_timezone(v_asset.client_id) end,
    p_channel, p_platform, auth.uid()
  ) returning id into v_id;
  return v_id;
end
$function$;

comment on function public.schedule_asset(uuid, date, public.post_channel, public.post_platform, time) is
  'Human scheduling: only an approved same-client asset→brief→idea→explicit organic campaign chain may enter the organic calendar. Locked lineage prevents a concurrent edit between validation and insertion. Publication still requires a matching approved Engine slot and later exact-version Inbox approval.';

revoke execute on function public.schedule_asset(uuid, date, public.post_channel, public.post_platform, time)
  from public, anon, service_role;
grant execute on function public.schedule_asset(uuid, date, public.post_channel, public.post_platform, time)
  to authenticated;

create or replace view public.publish_due with (security_invoker = true) as
select
  sp.id as post_id,
  sp.client_id,
  c.name as client_name,
  sp.platform,
  sp.scheduled_at,
  sp.media_type,
  sp.publication_status,
  sp.publish_attempts,
  sp.publish_claimed_at,
  a.id as asset_id,
  a.title as asset_title,
  coalesce(a.render_path, a.storage_path) as media_path,
  a.human_approved_at,
  pce.caption,
  pce.hashtags,
  pce.alt_text,
  pce.link_url,
  pce.first_comment,
  pp.provider,
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
    when ca.acquisition_mode is distinct from 'organic' or ca.paid_platform is not null
      then 'This campaign has no explicit organic publishing route.'
    when coalesce(sr.slot_count, 0) = 0
      then 'This calendar entry has no approved Engine slot. An exact-version publication approval must be connected through Approval Inbox before it can publish.'
    when sr.slot_count <> 1 or not coalesce(sr.matches, false)
      then 'The Engine slot and asset campaign lineage do not match this post.'
    when a.review_status is distinct from 'approved'::public.review_status
      then 'The asset approval was revoked.'
    when a.human_approved_at is null         then 'Nobody has approved the asset.'
    when sp.platform is null                 then 'The post has no platform.'
    when pp.platform is null or not pp.supported
      then 'There is no adapter for ' || coalesce(sp.platform::text, 'this platform') || '.'
    -- Two sentences rather than one, because "a story cannot be sent to
    -- facebook" would be false the moment the photo path works and only the
    -- video path does not. A person reading this needs to know which of the
    -- two they have.
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
    when not integration_usable(sp.client_id, pp.provider)
      then 'No usable ' || pp.provider || ' integration for this client.'
    when pce.caption is null or btrim(pce.caption) = ''
      then 'There is no caption for ' || sp.platform::text || '.'
    when sp.scheduled_at > now()             then 'Not due yet.'
    else null
  end as blocker,
  a.content_format,
  coalesce(pfp.supported, false) as format_supported
from scheduled_posts sp
left join clients c on c.id = sp.client_id
left join client_media_assets a on a.id = sp.asset_id
left join client_briefs b on b.id = a.brief_id
left join client_ideas i on i.id = b.source_idea_id
left join client_campaigns ca on ca.id = i.campaign_id
left join lateral (
  select count(*)::int as slot_count,
         bool_and(
           s.stage = 'scheduled'
           and s.client_id = sp.client_id
           and s.asset_id = sp.asset_id
           and s.brief_id = b.id
           and s.idea_id = i.id
           and s.platform = sp.platform
         ) as matches
    from content_slots s
   where s.scheduled_post_id = sp.id
) sr on true
left join client_engine_settings ces on ces.client_id = sp.client_id
left join platform_publishing pp on pp.platform = sp.platform
-- The most specific row wins: one naming this media type, else the general
-- one. `nulls last` is what makes that ordering say it.
left join lateral (
  select x.platform, x.supported, x.media_type
    from platform_format_publishing x
   where x.platform = sp.platform
     and x.content_format = a.content_format
     and (x.media_type is null or x.media_type = sp.media_type)
   order by x.media_type nulls last
   limit 1
) pfp on true
left join lateral (
  select count(*)::int as frames from client_media_frames f where f.asset_id = a.id
) fr on true
left join post_copy_effective pce
  on pce.scheduled_post_id = sp.id and pce.platform = sp.platform
where sp.publication_status in ('scheduled', 'publishing')
  and sp.published_at is null;

comment on view public.publish_due is
  'Outstanding publication attempts and exact blockers. Only an explicit same-client organic asset→brief→idea→campaign chain with exactly one matching scheduled Engine slot can be claimed by the organic publisher. Paid, legacy, cross-client and slotless rows remain visible but blocked.';

grant select on public.publish_due to authenticated;

create or replace function public.claim_posts_for_publishing(p_limit integer default 5)
returns table (
  post_id uuid,
  client_id uuid,
  platform post_platform,
  provider text,
  media_type media_type,
  media_path text,
  asset_id uuid,
  caption text,
  hashtags text[],
  alt_text text,
  link_url text,
  first_comment text,
  scheduled_at timestamptz,
  attempt integer,
  content_format content_format,
  frame_paths text[]
)
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Posts are claimed by the publisher.' using errcode = 'P0001';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 50 then
    raise exception 'Claim between 1 and 50 posts at a time.' using errcode = 'P0001';
  end if;

  return query
  with ready as (
    select d.post_id
      from publish_due d
      join scheduled_posts s on s.id = d.post_id
      join client_media_assets a on a.id = s.asset_id and a.client_id = s.client_id
      join client_briefs b on b.id = a.brief_id and b.client_id = s.client_id
      join client_ideas i on i.id = b.source_idea_id and i.client_id = s.client_id
      join client_campaigns ca on ca.id = i.campaign_id and ca.client_id = s.client_id
      join content_slots slot on slot.scheduled_post_id = s.id
        and slot.client_id = s.client_id
        and slot.asset_id = s.asset_id
        and slot.brief_id = b.id
        and slot.idea_id = i.id
        and slot.platform = s.platform
        and slot.stage = 'scheduled'
     where d.blocker is null
       and d.publication_status = 'scheduled'
       and s.channel = 'organic'::public.post_channel
       and ca.acquisition_mode = 'organic'
       and ca.paid_platform is null
       and a.review_status = 'approved'::public.review_status
       and a.human_approved_at is not null
     order by d.scheduled_at
     limit p_limit
     for update of s skip locked
     for share of a, b, i, ca, slot skip locked
  ),
  claimed as (
    update scheduled_posts sp
       set publication_status = 'publishing',
           publish_claimed_at = now(),
           publish_attempts = sp.publish_attempts + 1,
           updated_at = now()
     where sp.id in (select r.post_id from ready r)
    returning sp.id, sp.publish_attempts
  )
  select
    d.post_id, d.client_id, d.platform, d.provider, d.media_type, d.media_path,
    d.asset_id, d.caption, d.hashtags, d.alt_text, d.link_url, d.first_comment,
    d.scheduled_at, cl.publish_attempts, d.content_format,
    -- Ordered by position, which 109 assigns when the frames are planned
    -- rather than when they render, so this is the order a person laid out
    -- and not the order the renders happened to finish in. Null rather than
    -- an empty array for anything that has no frames, so the runtime can tell
    -- "not a frame set" from "a frame set that lost its frames".
    (select array_agg(f.storage_path order by f.position)
       from client_media_frames f where f.asset_id = d.asset_id)
  from claimed cl
  join publish_due d on d.post_id = cl.id;
end;
$$;

comment on function public.claim_posts_for_publishing(integer) is
  'Claim only due rows whose current same-client organic chain and approved Engine slot are locked and verified in this transaction. A paid, legacy, cross-client or slotless row cannot enter the organic publisher.';

revoke execute on function public.claim_posts_for_publishing(integer)
  from public, anon, authenticated;
grant execute on function public.claim_posts_for_publishing(integer) to service_role;

select public.lock_down_definer_functions();

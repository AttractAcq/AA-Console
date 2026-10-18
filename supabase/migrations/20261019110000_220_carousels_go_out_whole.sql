-- Carousels go out whole.
--
-- Migration 219 stopped a carousel being published as its cover frame by
-- refusing to claim one at all. This is the other half: the frames reach the
-- adapter, the adapter sends all of them, and the two rows 219 wrote as
-- unsupported become supported.
--
-- WHAT WAS ACTUALLY MISSING
--
-- The frames have been in `client_media_frames` since migration 109, ordered,
-- one row per frame, with the parent asset as the unit of approval. Nothing
-- in the publishing path has ever read that table. `publish_due` carries
-- `coalesce(render_path, storage_path)` -- one file -- and the claim hands the
-- adapter exactly that. So this migration is mostly about the claim learning
-- to pass on something it was already sitting next to.
--
-- WHY THE CLAIM'S SHAPE CHANGES RATHER THAN THE RUNTIME QUERYING FRAMES
--
-- 160's comment on the claim says "everything the adapter needs comes back
-- with the claim", and that is worth keeping: a second round trip per post to
-- fetch frames would be a second thing that can fail between claiming a post
-- and publishing it, and a failure there leaves a post claimed, stranded and
-- destined for the reaper. An ordered array in the same row cannot half-fail.
--
-- This means dropping and recreating the function rather than replacing it,
-- because a `returns table` shape cannot be altered in place. The runtime's
-- ClaimedPost changes with it in the same commit.
--
-- WHAT IS STILL NOT SUPPORTED
--
-- Stories, on either platform, and carousels anywhere but Instagram and
-- Facebook. Those rows stay false and keep their sentence.

-- ---------------------------------------------------------------------------
-- A carousel that cannot be sent whole still cannot be sent
-- ---------------------------------------------------------------------------

-- 109 already refuses to let a non-single asset exist with fewer than two
-- frames, so this is a second line rather than the first. It earns its place
-- because the first line guards the asset at write time and this guards the
-- post at send time, and the gap between those two moments is where a frame
-- row can be deleted. Ten is Meta's limit on both platforms.
create or replace view publish_due with (security_invoker = true) as
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
    when a.human_approved_at is null         then 'Nobody has approved the asset.'
    when sp.platform is null                 then 'The post has no platform.'
    when pp.platform is null or not pp.supported
      then 'There is no adapter for ' || coalesce(sp.platform::text, 'this platform') || '.'
    when pfp.platform is null or not pfp.supported
      then 'A ' || a.content_format::text || ' cannot be sent to ' || sp.platform::text
           || ' yet. Publishing it now would post the first frame on its own and record it as published.'
    when a.content_format = 'carousel' and coalesce(fr.frames, 0) < 2
      then 'A carousel needs at least two frames. This one has '
           || coalesce(fr.frames, 0)::text || ' on file.'
    when a.content_format = 'carousel' and fr.frames > 10
      then 'This carousel has ' || fr.frames::text || ' frames. Ten is the most either platform takes.'
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
left join client_engine_settings ces on ces.client_id = sp.client_id
left join platform_publishing pp on pp.platform = sp.platform
left join platform_format_publishing pfp
  on pfp.platform = sp.platform and pfp.content_format = a.content_format
left join lateral (
  select count(*)::int as frames from client_media_frames f where f.asset_id = a.id
) fr on true
left join post_copy_effective pce
  on pce.scheduled_post_id = sp.id and pce.platform = sp.platform
where sp.publication_status in ('scheduled', 'publishing')
  and sp.published_at is null;

comment on view publish_due is
  'What the publisher may send, and for everything else the one sentence saying why not. A null blocker means it would go out on the next pass. Since 219 that includes the shape, and since 220 whether a carousel has a sendable number of frames.';

grant select on publish_due to authenticated;

-- ---------------------------------------------------------------------------
-- The claim hands over the frames
-- ---------------------------------------------------------------------------

drop function if exists public.claim_posts_for_publishing(integer);

create function public.claim_posts_for_publishing(p_limit integer default 5)
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
     where d.blocker is null
       and d.publication_status = 'scheduled'
     order by d.scheduled_at
     limit p_limit
     for update of s skip locked
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
  'Take up to p_limit posts that are due, approved, enabled, in a sendable shape and with copy, marking each as publishing so nothing else takes it. Everything the adapter needs comes back with the claim, frames included and in order.';

revoke all on function public.claim_posts_for_publishing(integer) from public, anon, authenticated;
grant execute on function public.claim_posts_for_publishing(integer) to service_role;

-- ---------------------------------------------------------------------------
-- The two rows this migration exists to flip
-- ---------------------------------------------------------------------------

update platform_format_publishing set supported = true, note =
  'A child container per frame, then a CAROUSEL parent, then publish. Two to ten frames.'
 where platform = 'instagram' and content_format = 'carousel';

update platform_format_publishing set supported = true, note =
  'Each frame uploaded unpublished to /photos, then one feed post with attached_media. Two to ten frames.'
 where platform = 'facebook' and content_format = 'carousel';

select lock_down_definer_functions();

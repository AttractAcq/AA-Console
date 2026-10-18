-- The publisher is told what shape it is being handed.
--
-- The content factory makes four shapes -- single, carousel, story, reel --
-- and the publisher can send two of them. Nothing anywhere said so. Migration
-- 160 carries `media_type` from the scheduled post to the adapter and never
-- once mentions `content_format`, the adapters have no notion of a frame, and
-- `platform_publishing` answers "can we post to Instagram at all" rather than
-- "can we post THIS to Instagram".
--
-- So a carousel that has been planned for Instagram, built as six frames,
-- approved by a person and put on the calendar reaches the Instagram adapter,
-- which creates one container from `coalesce(render_path, storage_path)` --
-- the cover frame -- publishes it, and returns a post id. record_post_published
-- writes published_at, the slot advances to 'published', and the board says
-- Published. Five frames are gone and nothing is wrong anywhere a person
-- looks.
--
-- That is the exact failure `publish_due` exists to make impossible: not a
-- post that fails, but a post that succeeds dishonestly. 160's own header
-- says the thing it refuses to do is let the database "write published_at and
-- move the slot to published for a post that never went out, which is a lie
-- told in the one place a person checks". A post that went out as a sixth of
-- itself is the same lie with better manners.
--
-- This migration does not teach anyone to publish a carousel. It makes the
-- queue say so. Which (platform, format) pairs an adapter can actually send
-- becomes data, the view grows the column it was missing and one more
-- sentence, and a shape with nowhere to go waits visibly instead of going out
-- wrong. The adapters come next, and when each one lands it flips a row here.
--
-- WHY THE COLUMNS ARE APPENDED AFTER `blocker`
--
-- `create or replace view` may only add columns at the end, and `drop view`
-- would be a bigger blast radius than this is worth. `content_format` would
-- read better next to `media_type`; it is at the end instead, and that is the
-- whole reason.

-- ---------------------------------------------------------------------------
-- Which shapes each adapter can actually send
-- ---------------------------------------------------------------------------

-- A table, for the same reason platform_publishing is a table: the difference
-- between "Instagram carousels are not built yet" and "Instagram carousels
-- quietly go out as one image" is a row somebody can read. Every pair is
-- listed, including the ones on platforms that have no adapter at all, so
-- that this is a complete statement rather than a list of exceptions with an
-- implied default.
create table if not exists platform_format_publishing (
  platform post_platform not null,
  content_format content_format not null,
  supported boolean not null default false,
  note text not null,
  primary key (platform, content_format)
);

comment on table platform_format_publishing is
  'Which content shapes each platform adapter can send, as opposed to which platforms have an adapter at all. A pair that is not supported is refused by publish_due with a sentence rather than published as its first frame.';

insert into platform_format_publishing (platform, content_format, supported, note) values
  -- Instagram: one container, then a publish. That is a single image or a
  -- reel, and nothing else.
  ('instagram', 'single',   true,  'One media container, then publish.'),
  ('instagram', 'reel',     true,  'A REELS container, polled until Instagram has finished processing it.'),
  ('instagram', 'carousel', false, 'Needs a child container per frame and a CAROUSEL parent. The adapter creates one container, so a carousel would publish as its cover frame.'),
  ('instagram', 'story',    false, 'Needs media_type STORIES. The adapter does not set it, so a story would publish as an ordinary feed post.'),
  -- Facebook: the page feed, through /photos and /videos.
  ('facebook',  'single',   true,  'A photo to /photos or a video to /videos on the page.'),
  ('facebook',  'reel',     true,  'Lands as a page video rather than on the Reels surface. The whole video goes out, so this is a worse placement and not a wrong post; the Reels endpoint is still outstanding.'),
  ('facebook',  'carousel', false, 'Needs attached_media with one id per frame. The adapter posts one photo, so a carousel would publish as its cover frame.'),
  ('facebook',  'story',    false, 'No story path on the page adapter.'),
  -- The three platforms with no adapter. The platform check in publish_due
  -- refuses these first; the rows exist so this table is a complete answer to
  -- "what can we send where" rather than one that has to be read alongside
  -- platform_publishing to be understood.
  ('linkedin',  'single',   false, 'No connector and no adapter.'),
  ('linkedin',  'carousel', false, 'No connector and no adapter.'),
  ('linkedin',  'story',    false, 'No connector and no adapter.'),
  ('linkedin',  'reel',     false, 'No connector and no adapter.'),
  ('tiktok',    'single',   false, 'No connector and no adapter.'),
  ('tiktok',    'carousel', false, 'No connector and no adapter.'),
  ('tiktok',    'story',    false, 'No connector and no adapter.'),
  ('tiktok',    'reel',     false, 'No connector and no adapter.'),
  ('youtube',   'single',   false, 'No connector and no adapter.'),
  ('youtube',   'carousel', false, 'No connector and no adapter.'),
  ('youtube',   'story',    false, 'No connector and no adapter.'),
  ('youtube',   'reel',     false, 'No connector and no adapter.')
on conflict (platform, content_format) do update
  set supported = excluded.supported, note = excluded.note;

alter table platform_format_publishing enable row level security;
create policy pfp_read on platform_format_publishing for select to authenticated using (true);
grant select on platform_format_publishing to authenticated;

-- ---------------------------------------------------------------------------
-- The view, with the column it was missing and the sentence it could not say
-- ---------------------------------------------------------------------------

-- Everything above `blocker` is migration 160's, unchanged and in its original
-- order, because create or replace requires it. The format case sits directly
-- after the adapter case: both answer "this cannot be sent", and both have to
-- be true before anything about switches, integrations or timing matters. A
-- carousel is just as unpublishable on a client whose publishing is switched
-- on as one whose publishing is off, and saying "publishing is off for this
-- client" to somebody whose real problem is that nobody has written carousel
-- support would send them to the wrong screen.
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
    -- The case this migration exists for. It names what WOULD happen rather
    -- than only what cannot, because "not supported" reads like a missing
    -- feature and "it would post one frame and call it published" reads like
    -- the bug it is.
    when pfp.platform is null or not pfp.supported
      then 'A ' || a.content_format::text || ' cannot be sent to ' || sp.platform::text
           || ' yet. Publishing it now would post the first frame on its own and record it as published.'
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
left join post_copy_effective pce
  on pce.scheduled_post_id = sp.id and pce.platform = sp.platform
where sp.publication_status in ('scheduled', 'publishing')
  and sp.published_at is null;

comment on view publish_due is
  'What the publisher may send, and for everything else the one sentence saying why not. A null blocker means it would go out on the next pass. Since migration 219 that includes the shape: a format no adapter can send is refused here rather than published as its cover frame.';

grant select on publish_due to authenticated;

-- claim_posts_for_publishing already takes only `where d.blocker is null`, so
-- it stops claiming these without being touched. Its returned columns are
-- deliberately left alone: handing the adapter a content_format it does not
-- yet branch on would mean changing the function's return shape, and the
-- runtime's ClaimedPost with it, for something nothing reads. That belongs
-- with the first adapter that needs it.

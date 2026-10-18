-- The four that were left.
--
-- 219 made the queue honest about shapes, 220 sent carousels whole, 221 sent
-- stories as the several posts they are. What remained was a short list, and
-- this closes it:
--
--   * A Facebook video story, which 221 refused outright.
--   * A Facebook reel, which went to /videos and landed in the page feed --
--     the whole video, published, in a place nobody chose.
--   * A first comment on a Facebook post, which the adapter accepted and
--     silently dropped. Instagram has honoured it since M2.
--   * An Instagram permalink, so the board can link to what went out.
--
-- Only the first changes what the queue will claim, so it is the only one
-- that needs a row flipped. The other three change what the adapters do with
-- posts they were already sending, and need no migration at all -- the notes
-- are rewritten anyway, because a note that describes a worse behaviour than
-- the code now has is how the next person is misled.
--
-- A CAVEAT THAT BELONGS IN THE DATA
--
-- The photo story path is two ordinary Graph calls and the tests exercise
-- the shape of them. The video path -- Reels and video stories both -- is
-- Meta's three-phase upload, and its middle phase talks to rupload, a host
-- nothing else in this system has ever called. It is written from the
-- documented flow and it has never run against a real page.
--
-- That is worth saying in the row rather than only in a commit message,
-- because the row is what somebody reads at two in the morning when a reel
-- has not gone out. The switches mean nothing publishes anywhere until a
-- person turns them on for a client, so "supported, and the first use of it
-- will be the first proof" is the honest state rather than a risky one.

update platform_format_publishing set supported = true, note =
  'Three-phase upload to the video_stories surface: start on the Graph host, the media fetched by rupload, then finish. WRITTEN FROM THE DOCUMENTED FLOW AND NOT YET EXERCISED AGAINST A REAL PAGE -- the photo story path beside it has been.'
 where platform = 'facebook' and content_format = 'story' and media_type = 'video';

update platform_format_publishing set note =
  'Three-phase upload to the video_reels surface, so it lands as a Reel rather than as a page video in the feed. WRITTEN FROM THE DOCUMENTED FLOW AND NOT YET EXERCISED AGAINST A REAL PAGE.'
 where platform = 'facebook' and content_format = 'reel' and media_type is null;

-- Facebook's own note mentioned neither the first comment it was dropping nor
-- the carousel path 220 added.
update platform_publishing set note =
  'Page feed through the page token on the meta integration. Photos, videos, carousels, reels and photo stories, each with its own surface, and a first comment where one is written.'
 where platform = 'facebook';

update platform_publishing set note =
  'Instagram Graph API: a container, then a publish. Needs an IG user id on the integration. The permalink is read back after publishing so a person can go and look at it.'
 where platform = 'instagram';

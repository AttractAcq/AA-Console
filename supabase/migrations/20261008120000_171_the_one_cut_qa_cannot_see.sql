-- The only reel ever cut is the one asset QA cannot check.
--
-- Migration 158 added width, height and duration_sec so QA could test aspect
-- ratio and length, and said a null means "not recorded, which QA treats as
-- nothing to check rather than as a fault". That is the right rule, and it
-- leaves one row stranded: the cut on production rendered on 5 October and
-- 158 landed on the 6th, so it has a render_path and three nulls. The check
-- written to police reels cannot see the only reel there is.
--
-- WHERE THESE NUMBERS COME FROM
--
-- Width and height are not a measurement, they are an invariant. video_edit
-- renders through `buildRenderPlan`, which scales and crops every clip to
-- OUTPUT_WIDTH x OUTPUT_HEIGHT -- 1080 x 1920 in render.ts, constants, not
-- parameters. Any cut video_edit has ever produced is 1080 x 1920, so this
-- can be set for every such row without probing any of them.
--
-- Duration cannot be derived that way: it is the sum of the EDL's segments.
-- It was read with ffprobe from the stored object, and the object was
-- confirmed to be the file probed by comparing byte length against
-- storage.objects.metadata->>'size': 6,251,047 both sides, exactly. The
-- result was 1080x1920, 25.10s.
--
-- Guarded on `width is null` so it is idempotent and cannot touch a row
-- video_edit filled in itself. Nothing here runs on staging, which has no
-- such row.

-- The invariant, for any cut that predates the columns.
update client_media_assets
   set width = 1080, height = 1920
 where render_path is not null
   and content_format = 'reel'
   and width is null;

-- The measurement, for the one row it was taken from.
update client_media_assets
   set duration_sec = 25.10
 where id = '3e167b1b-269d-40a9-b3e9-c05e1e2d63b8'
   and duration_sec is null
   and render_path = 'e4b4b001-81f6-4997-8429-ff21f4ee1fbe/reels/3e167b1b-269d-40a9-b3e9-c05e1e2d63b8/cut.mp4';

-- A cut whose duration is still unknown after this is one nobody has probed.
-- It is not an error -- QA will treat the null as nothing to check, as 158
-- intended -- but it is worth being able to find.
comment on column client_media_assets.duration_sec is
  'Length of a video asset in seconds. Null for a still, and null for a cut that predates migration 158 and has not been probed. video_edit records it at render time, which is the only moment it is known for certain.';

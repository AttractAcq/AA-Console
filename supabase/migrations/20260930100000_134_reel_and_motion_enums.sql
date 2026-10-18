-- Reel, and the motion stage that sits between a still and a finished clip.
--
-- content_format has been single | carousel | story since migration 109.
-- A generated reel is a fourth shape: ordered shots, not one file and not a
-- swipe of stills. creative_stage has been concept | render | done | failed
-- since migration 39. Motion is the stage after the still exists and before
-- the clip is done.
--
-- ALTER TYPE ... ADD VALUE only. Postgres allows the add inside a
-- transaction and refuses to use the new value until that transaction
-- commits, so nothing in this file mentions 'reel' or 'motion' as data.
-- The columns, the format check, and the video_build agent are migration 135.

alter type content_format add value if not exists 'reel';

alter type creative_stage add value if not exists 'motion' before 'done';

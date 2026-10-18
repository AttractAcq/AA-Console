-- A reel has a state the engine could not express: waiting for footage.
--
-- `slot_pipeline` has `building/reel -> video_build` and nothing after it.
-- video_build makes the stills, submits the Higgsfield clips, and finishes by
-- calling handOffToSlot, which advances the slot to `copywriting` whether or
-- not anything was cut. So an engine-driven reel goes
--
--   building -> copywriting -> qa -> awaiting_approval
--
-- with `render_path` still null, and a person is asked to approve a reel with
-- no video in it. QA cannot catch it either: the aspect-ratio and duration
-- checks read width/height/duration_sec, which only video_edit writes, and
-- migration 158 deliberately treats a null as "not recorded, nothing to check
-- rather than a fault". An uncut reel therefore scores 100 and passes.
--
-- A second row on `building/reel` is not possible -- slot_pipeline is unique
-- on (stage, format) -- and queueing the cut as a follow-up from video_build
-- would hide the part worth seeing. Higgsfield is asynchronous and its clips
-- take minutes, so the slot genuinely rests somewhere the current model has
-- no name for. On 4 October that showed up as a video_edit job failing with
-- "shot 1..6 never submitted" when the truthful answer was "not back yet".
--
-- So: a stage. `editing` sits between building and copywriting, a reel waits
-- there visibly, and the board can tell a wait from a breakage.
--
-- The value only, in its own migration: Postgres will not let a new enum
-- value be used in the transaction that adds it, which 163 had to learn too.

alter type slot_stage add value if not exists 'editing' after 'building';

comment on type slot_stage is
  'Where a slot has got to. planned through published is the path; editing is where a reel waits for its clips and then its cut; failed and rejected are side exits.';

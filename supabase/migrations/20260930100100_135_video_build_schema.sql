-- Generated video, Phase 1 schema. F6 and F7 only: generated shots, no
-- client assets, no clearance halt. Enum values added in migration 134
-- are usable here because that migration has committed.
--
-- Shot source spelling. The wiring spec says "generated" or "client_asset".
-- Cockpit's integrity guard says ai_generated or source_asset, and that is
-- the check Phase 2 will enforce (a proof shot must be source_asset, never
-- ai_generated). One spelling, the Cockpit one, so the later guard does not
-- need a translation table. Phase 1 writes ai_generated only.
--
-- Clearance. client_proof_assets already has usage_rights
-- (approved | restricted | not_cleared) and expires_on. That is the
-- clearance record: approved and unexpired is what usable_proof() offers.
-- client_briefs.proof_asset_id already points at it. A shot that animates
-- proof points at the same row via client_media_frames.proof_asset_id.
-- customer_cleared_at is not added. A second timestamp would be a second
-- answer to "may we use this", and the two would drift.
--
-- business_type lives on client_business_context, which is already one row
-- per client. clients has sector and tier and does not get a duplicate.
-- Nothing in Phase 1 reads the column; Phase 3 routing will.
--
-- format_code is the piece (F1–F10). slot_role is the quota bucket and is
-- left null on purpose: Phase 3 fills it. Phase 1 only writes F6 or F7.

-- A reel is a video. A carousel stays images. A story stays a still or a
-- clip. Single still carries anything, including text. Replacing the
-- function is enough: the check constraints on ideas, briefs and assets
-- already call it, and every row on file is single, carousel or story.
create or replace function format_fits_media(
  p_format content_format,
  p_media  media_type
)
returns boolean
language sql
immutable
set search_path = public
as $$
  select case p_format
    when 'carousel' then p_media = 'image'
    when 'story'    then p_media in ('image', 'video')
    when 'reel'     then p_media = 'video'
    else true
  end;
$$;

comment on function format_fits_media(content_format, media_type) is
  'Whether a content format can carry a media type. A carousel is images; a story is a still or a clip; a reel is a video; single carries anything.';

comment on column client_briefs.content_format is
  'The shape this brief is written for. Carousel and story are ordered frames. A reel is ordered generated or source shots. Single is everything else.';

alter table client_business_context
  add column if not exists business_type text;

comment on column client_business_context.business_type is
  'What the business is, for format routing. One row per client already lives here, so this is not also stored on clients. Phase 3 reads it; Phase 1 does not require a value.';

alter table client_briefs
  add column if not exists format_code text,
  add column if not exists slot_role text;

alter table client_briefs
  drop constraint if exists client_briefs_format_code_known;

alter table client_briefs
  add constraint client_briefs_format_code_known
  check (format_code is null or format_code ~ '^F([1-9]|10)$');

comment on column client_briefs.format_code is
  'Generated-video format, F1–F10. Phase 1 writes F6 (mechanism explainer) or F7 (problem cold-open). Null on a static brief.';

comment on column client_briefs.slot_role is
  'Which quota bucket this piece fills. Phase 3 routing writes it. Phase 1 leaves it null.';

-- The motion stage's columns, on the shot row that already exists.
-- All nullable: a carousel frame has none of this, and a reel shot does not
-- have a clip until Higgsfield returns one.
alter table client_media_frames
  add column if not exists shot_source_kind text,
  add column if not exists beat text,
  add column if not exists duration_sec numeric,
  add column if not exists motion_preset text,
  add column if not exists clip_path text,
  add column if not exists provider_job_id text,
  add column if not exists proof_asset_id uuid references client_proof_assets (id) on delete set null;

alter table client_media_frames
  drop constraint if exists client_media_frames_shot_source_known,
  drop constraint if exists client_media_frames_duration_positive,
  drop constraint if exists client_media_frames_beat_not_blank;

alter table client_media_frames
  add constraint client_media_frames_shot_source_known
    check (shot_source_kind is null or shot_source_kind in ('ai_generated', 'source_asset')),
  add constraint client_media_frames_duration_positive
    check (duration_sec is null or duration_sec > 0),
  add constraint client_media_frames_beat_not_blank
    check (beat is null or length(btrim(beat)) > 0);

comment on column client_media_frames.shot_source_kind is
  'ai_generated or source_asset. Phase 1 F6/F7 shots are ai_generated. A source_asset shot must reference proof_asset_id; clearance is usage_rights and expires_on on that proof row, not a timestamp on the frame.';

comment on column client_media_frames.beat is
  'What this shot does in the reel. One line.';

comment on column client_media_frames.duration_sec is
  'Shot length in seconds. Null until the shot plan names one.';

comment on column client_media_frames.motion_preset is
  'Higgsfield motion id, stored as text. "pending" until a catalog id is chosen. Not sent anywhere while credentials are absent.';

comment on column client_media_frames.clip_path is
  'Where the returned clip was copied. Higgsfield CDN retention is short, so the clip has to land in our storage. Null until motion completes.';

comment on column client_media_frames.provider_job_id is
  'Higgsfield request id, the handle the worker polls. Null until a submit actually happens.';

comment on column client_media_frames.proof_asset_id is
  'The proof asset this shot animates, when shot_source_kind is source_asset. Clearance is that row''s usage_rights and expires_on. Phase 1 generated shots leave this null.';

create index if not exists client_media_frames_provider_job_idx
  on client_media_frames (provider_job_id)
  where provider_job_id is not null;

-- requires_input keeps it out of "Run all agents": a master run has no brief
-- to hand it. requires_upstream names brief, so a client with no completed
-- brief cannot start one. Config holds placeholders only. Nothing in the
-- runtime reads these values into an HTTP call in Phase 1. paused stays
-- false; the motion stage pauses itself when Higgsfield credentials are
-- missing, which is a job outcome rather than a kill switch on the agent.
insert into agents (
  agent_key, name, initials, domain, description,
  requires_upstream, requires_input, config, paused
)
values (
  'video_build',
  'Video Build',
  'VB',
  'content',
  'Builds an F6 or F7 reel from a brief. Reads the shot plan, leaves stills to creative_build, and pauses motion until Higgsfield credentials exist. Does not call Higgsfield. Assembly is an editor handoff.',
  '{brief}',
  true,
  jsonb_build_object(
    'provider', 'higgsfield',
    'model_draft', null,
    'model_final', null,
    'model_draft_env', 'HIGGSFIELD_MODEL_DRAFT',
    'model_final_env', 'HIGGSFIELD_MODEL_FINAL',
    'quality', 'draft',
    'motion_preset', 'pending',
    'motion_strength', 1,
    'stills_agent', 'creative_build',
    'assembly', 'brief_dispatch',
    'phase', 1
  ),
  false
)
on conflict (agent_key) do nothing;

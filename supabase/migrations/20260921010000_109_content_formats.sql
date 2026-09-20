-- Story and carousel as content formats.
--
-- media_type says what a file IS — an image, a video, a piece of text.
-- Story and carousel say what shape it runs in, and that is a different
-- question: a story can be a still or a clip, and a carousel is one thing
-- made of several images. Adding them to media_type would make "video
-- story" unsayable, and a carousel's own frames would have nowhere to go.
--
-- So a second column rather than more values on the first.
--
-- Three values, not ten. The repurpose menu lists eight derivatives — reel,
-- short, quote graphic and the rest — and those are already covered by
-- media_type: a reel is a video, a quote graphic is an image. Only carousel
-- and story need production to behave differently, because only they are
-- made of ordered frames. A format that changes nothing about how a thing
-- is produced does not need to exist here, and repurpose_format keeps
-- meaning what it already means.
--
-- 'single' is the default and covers everything on file: one image, one
-- video, one piece of copy.

create type content_format as enum ('single', 'carousel', 'story');

alter table client_briefs
  add column content_format content_format not null default 'single';

alter table client_media_assets
  add column content_format content_format not null default 'single';

comment on column client_briefs.content_format is
  'The shape this brief is written for. Carousel and story are made of ordered frames and are briefed and produced differently; single is everything else.';
comment on column client_media_assets.content_format is
  'The shape of the finished asset. Frames live in client_media_frames; storage_path holds the first of them so every existing preview keeps working.';

create index client_briefs_format_idx on client_briefs (client_id, content_format)
  where content_format <> 'single';
create index client_media_assets_format_idx on client_media_assets (client_id, content_format)
  where content_format <> 'single';

-- The frames of one multi-frame asset.
--
-- A child table rather than one asset row per frame. Approval, the human
-- gate, distribution and regeneration are all built around one asset being
-- one decision and one scheduled post — five rows would make approving a
-- carousel five decisions in the queue, five human_approved_at stamps, and
-- five entries in Distribution for something that goes out once. It would
-- also need five decisions logged to satisfy cma_decision_recorded, whose
-- whole point is one decision per thing decided.
create table client_media_frames (
  id           uuid primary key default gen_random_uuid(),
  asset_id     uuid not null references client_media_assets (id) on delete cascade,
  -- Assigned when the frames are planned, not when they finish rendering: a
  -- frame that fails and is retried must come back in its own slot rather
  -- than at the end.
  position     integer not null check (position >= 1),
  storage_path text not null,
  -- Per-frame copy, where the format carries any. A carousel frame usually
  -- does; a story frame usually does not.
  caption      text,
  created_at   timestamptz not null default now(),
  unique (asset_id, position)
);

create index client_media_frames_asset_idx
  on client_media_frames (asset_id, position);

comment on table client_media_frames is
  'The ordered frames of a carousel or story. One row per frame, position starting at 1. The parent asset is the unit of approval and distribution.';

alter table client_media_frames enable row level security;

create policy cmf_admin_all on client_media_frames
  for all to authenticated using (is_admin()) with check (is_admin());
create policy cmf_scoped_read on client_media_frames
  for select to authenticated using (
    exists (
      select 1 from client_media_assets a
       where a.id = asset_id and can_access_client(a.client_id)
    )
  );

-- A single-format asset has no frames, and a multi-frame one is not finished
-- until it has at least two. Deferred to commit because the asset row is
-- written before its frames are.
create or replace function assert_frames_match_format()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_frames integer;
begin
  select count(*) into v_frames from client_media_frames where asset_id = new.id;

  if new.content_format = 'single' and v_frames > 0 then
    raise exception 'A single asset cannot have frames. Set its format to carousel or story.';
  end if;
  if new.content_format <> 'single' and v_frames < 2 then
    raise exception 'A % needs at least two frames; this one has %.', new.content_format, v_frames;
  end if;
  return null;
end;
$$;

create constraint trigger cma_frames_match_format
  after insert or update of content_format on client_media_assets
  deferrable initially deferred
  for each row execute function assert_frames_match_format();

comment on function assert_frames_match_format() is
  'Refuses a carousel or story with fewer than two frames, and a single asset carrying any. Deferred to commit because the asset is written before its frames.';

-- A format and a media type that disagree.
--
-- mediaTypesFor() in the console says a carousel is images — a swipeable set
-- of clips is a story, not a carousel — and that text has no frames at all.
-- Nothing said it here. ('carousel', 'video') has been storable since 109,
-- and buildRoute() sends anything that is not an image down the text route,
-- so a video carousel would have been briefed as a carousel, filed as a
-- carousel, and quietly produced as a piece of copy.
--
-- The rule was already written down twice in TypeScript and zero times where
-- it is enforced. This is the third writing and the only one that holds.
--
-- Every one of the 416 rows on file is 'single', so nothing needs fixing
-- first: the constraint is added to tables that already satisfy it.

-- 'single' imposes nothing: one image, one video, one piece of copy are all
-- single. The two framed formats are the ones with something to say.
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
    else true
  end;
$$;

comment on function format_fits_media(content_format, media_type) is
  'Whether a content format can carry a media type. A carousel is images; a story is a still or a clip; single carries anything. Immutable so it can be used in a check constraint.';

alter table client_ideas
  add constraint client_ideas_format_fits_media
  check (format_fits_media(content_format, media_type));

alter table client_briefs
  add constraint client_briefs_format_fits_media
  check (format_fits_media(content_format, media_type));

alter table client_media_assets
  add constraint client_media_assets_format_fits_media
  check (format_fits_media(content_format, media_type));

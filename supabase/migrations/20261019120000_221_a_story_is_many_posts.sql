-- A story is many posts, and the database has to be able to say so.
--
-- A carousel is one post made of frames: one container, one publish, one id.
-- A story is not. There is no multi-frame story container on either platform,
-- so a five-frame story is five publishes and five platform ids, and
-- `scheduled_posts` holds exactly one `external_id`.
--
-- That gap is not a tidiness problem. It is the same problem migrations 219
-- and 220 were about, one level down: if the only states available are
-- "published" and "failed", then a story that got three frames out and then
-- hit an expired token has to be recorded as one or the other, and both are
-- lies. "Published" loses two frames the same way a carousel used to lose
-- five. "Failed" says nothing went out while three of them are live on a
-- client's account, and a retry then sends the first three again.
--
-- So this migration adds the only honest answer: a row per frame that went
-- out, written as each one lands. A retry reads it and sends the rest. That
-- also turns `retryable` from dangerous into useful for stories, because
-- trying again no longer means posting the beginning twice.
--
-- WHAT FACEBOOK CAN AND CANNOT DO
--
-- A page photo story is two calls. A page VIDEO story needs a resumable
-- upload session -- start, transfer, finish -- which is a different shape of
-- integration, and writing it blind against an API nobody here can exercise
-- is how you ship something that fails the first time a client uses it.
--
-- That makes "can Facebook send a story" a question with two answers
-- depending on what the story is made of, which the support table could not
-- express: it was keyed on platform and shape alone. So it grows a media type
-- that is null for "any", and the view prefers a specific row over the
-- general one. Same idiom as slot_pipeline in migration 150, and for the same
-- reason: a primary key forbids nulls, and "this row applies to any media
-- type" is exactly a null.

-- ---------------------------------------------------------------------------
-- What of a frame set has actually gone out
-- ---------------------------------------------------------------------------

create table if not exists post_frame_publications (
  post_id uuid not null references scheduled_posts(id) on delete cascade,
  client_id uuid not null references clients(id) on delete cascade,
  position integer not null check (position >= 1),
  external_id text not null,
  external_url text,
  published_at timestamptz not null default now(),
  primary key (post_id, position)
);

comment on table post_frame_publications is
  'One row per frame of a story that reached the platform, written as it lands. The only record that can distinguish "three of five went out" from "it published" and from "it failed", and what a retry reads to send the rest instead of the lot.';

alter table post_frame_publications enable row level security;
create policy pfpub_read on post_frame_publications
  for select to authenticated using (can_access_client(client_id));
grant select on post_frame_publications to authenticated;

create or replace function public.record_frame_published(
  p_post_id uuid,
  p_position integer,
  p_external_id text,
  p_external_url text default null
)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_post scheduled_posts;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Publication is recorded by the publisher.' using errcode = 'P0001';
  end if;
  select * into v_post from scheduled_posts where id = p_post_id for update;
  if not found then
    raise exception 'No such scheduled post: %.', p_post_id using errcode = 'P0001';
  end if;
  if v_post.publication_status <> 'publishing' then
    raise exception 'Post % is %, not being published. Claim it first.', p_post_id, v_post.publication_status
      using errcode = 'P0001';
  end if;
  if p_external_id is null or btrim(p_external_id) = '' then
    raise exception 'A frame that went out has an id. Record it.' using errcode = 'P0001';
  end if;

  -- Recording the same frame twice is a crashed runtime telling the truth
  -- again, exactly as in record_post_published. The first record stands,
  -- because it is the one whose id matches what is on the platform.
  insert into post_frame_publications (post_id, client_id, position, external_id, external_url)
  values (p_post_id, v_post.client_id, p_position, btrim(p_external_id), p_external_url)
  on conflict (post_id, position) do nothing;
end;
$$;

comment on function public.record_frame_published(uuid, integer, text, text) is
  'Record that one frame of a story reached the platform. Called as each frame lands rather than once at the end, so a failure halfway through leaves a true account of what is live.';

revoke all on function public.record_frame_published(uuid, integer, text, text)
  from public, anon, authenticated;
grant execute on function public.record_frame_published(uuid, integer, text, text) to service_role;

-- ---------------------------------------------------------------------------
-- Support, now that "can this go out" depends on what it is made of
-- ---------------------------------------------------------------------------

alter table platform_format_publishing add column if not exists media_type media_type;

comment on column platform_format_publishing.media_type is
  'Null means the row covers any media type. A row naming one wins over the general row, which is how "Facebook can send a photo story but not a video story" is said without two tables.';

-- A primary key forbids nulls, so the general rows could not exist under one.
-- nulls not distinct keeps the rule that a pair has at most one general row.
alter table platform_format_publishing drop constraint if exists platform_format_publishing_pkey;
create unique index if not exists platform_format_publishing_key
  on platform_format_publishing (platform, content_format, media_type) nulls not distinct;

-- Instagram sends a story as one STORIES container per frame, stills or
-- clips, so the general row covers both.
update platform_format_publishing set supported = true, note =
  'One STORIES container per frame, then a publish each. Stills or clips. A frame set is several posts, not one.'
 where platform = 'instagram' and content_format = 'story' and media_type is null;

-- Facebook: the general row is the photo path, and the video path says no.
update platform_format_publishing set supported = true, note =
  'Each frame uploaded unpublished to /photos, then /photo_stories. One story post per frame.'
 where platform = 'facebook' and content_format = 'story' and media_type is null;

insert into platform_format_publishing (platform, content_format, media_type, supported, note) values
  ('facebook', 'story', 'video', false,
   'Page video stories need a resumable upload session the adapter does not do. The photo path is unaffected.')
on conflict (platform, content_format, media_type) do update
  set supported = excluded.supported, note = excluded.note;

-- ---------------------------------------------------------------------------
-- The view picks the most specific answer it has
-- ---------------------------------------------------------------------------

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

comment on view publish_due is
  'What the publisher may send, and for everything else the one sentence saying why not. A null blocker means it would go out on the next pass. Since 219 that includes the shape, since 220 whether a carousel has a sendable number of frames, and since 221 what the shape is made of.';

grant select on publish_due to authenticated;

select lock_down_definer_functions();

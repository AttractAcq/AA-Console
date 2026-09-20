-- The words that go on an ad, and where the image lives once Meta has it.
--
-- An approved asset is a picture. A Meta ad is a picture plus primary text, a
-- headline, an optional description, a destination and a button — and none of
-- those five had anywhere to live. The brief holds hook, script and
-- call_to_action, which is where the copy comes FROM, but a brief is one
-- piece of production guidance and an asset may be cut from it more than
-- once. The words that ran are a property of the ad, not of the brief.
--
-- meta_image_hash is a cache, not a record of intent. Meta dedupes uploads by
-- content, so re-uploading the same bytes returns the same hash; keeping it
-- saves the round trip and, more usefully, makes a rebuild after a partial
-- failure cheap. It is cleared when the file changes, because a hash that
-- points at the previous image is worse than no hash at all.

alter table client_media_assets
  add column ad_primary_text text,
  add column ad_headline     text,
  add column ad_description  text,
  add column ad_link_url     text,
  add column ad_cta          text,
  add column meta_image_hash text;

comment on column client_media_assets.ad_primary_text is
  'The body copy above the image. Meta calls this message.';
comment on column client_media_assets.ad_headline is
  'The bold line under the image. Meta calls this name.';
comment on column client_media_assets.ad_description is
  'The optional line under the headline. Often not shown, depending on placement.';
comment on column client_media_assets.ad_link_url is
  'Where the ad sends people. Also the link the call-to-action button carries.';
comment on column client_media_assets.ad_cta is
  'The Meta call-to-action button value, e.g. BOOK_NOW. Must be one the campaign template''s destination can serve.';
comment on column client_media_assets.meta_image_hash is
  'The hash Meta returned when this image was uploaded to the ad account. A cache of the upload, cleared whenever storage_path changes.';

-- A hash that points at the previous image is worse than no hash: the ad
-- would build cleanly and run the wrong picture.
create or replace function clear_meta_hash_on_new_file()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.storage_path is distinct from old.storage_path then
    new.meta_image_hash := null;
  end if;
  return new;
end;
$$;

create trigger cma_clear_meta_hash before update on client_media_assets
  for each row execute function clear_meta_hash_on_new_file();

-- Archiving and ending a piece of content production.
--
-- Two verbs, deliberately not one function with a flag, because they are not
-- variations of each other.
--
-- ARCHIVE takes a record out of the working list and does nothing else.
-- Migration 118 already does this automatically -- an idea is stamped when
-- its brief appears, a brief when its asset appears -- which is what makes a
-- piece show in one place at a time while the Archive still shows every stage
-- it passed through. What was missing is the manual version, for when a
-- person decides something is finished before the records do. An idea and a
-- brief already have somewhere to put that stamp. An asset does not, so this
-- adds the column 118 never needed.
--
-- DELETE is the end of the thing: the asset, its frames, its captions, its
-- place on the calendar, its reviews and its files in the bucket. It leaves
-- the Archive too, because the Archive is a view over these same rows rather
-- than a copy of them -- there is no second place to clean up.
--
-- WHAT A TERMINATION WILL NOT DO
--
-- Some references to an asset are `on delete restrict`, and they are right to
-- be. A proof placement names the exact asset it put somewhere public, and a
-- proof production request names the asset it was derived from. Cascading
-- through those would quietly destroy the record of something that is still
-- live on a client's website or profile.
--
-- So those are refused by name, with the reason, rather than cascaded or left
-- to surface as a foreign key violation. "Delete everything" is the promise
-- for the content factory's own records; it was never a promise to forget
-- that a testimonial is on a Google Business Profile.

-- ---------------------------------------------------------------------------
-- An asset gains the stamp an idea and a brief already had
-- ---------------------------------------------------------------------------

alter table client_media_assets add column if not exists archived_at timestamptz;

comment on column client_media_assets.archived_at is
  'When a person archived this asset by hand. Ideas and briefs are stamped automatically by migration 118 when their successor appears; an asset is the end of the chain and has no successor, so this is only ever set deliberately.';

create index if not exists client_media_assets_archived_idx
  on client_media_assets (client_id, archived_at);

-- ---------------------------------------------------------------------------
-- Archive, by hand, at any stage
-- ---------------------------------------------------------------------------

-- One function with an allowlist rather than three near-identical ones. The
-- allowlist is a check on a literal, not a table name taken on trust: this is
-- security definer, and a function that interpolates whatever it is handed
-- into `update %s` is a different and much worse function.
create or replace function public.set_content_archived_v6(
  p_record text,
  p_id uuid,
  p_archived boolean default true
)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_client uuid;
  v_when timestamptz := case when p_archived then now() else null end;
begin
  if p_record not in ('idea', 'brief', 'asset') then
    raise exception 'Unknown record type: %.', p_record using errcode = 'P0001';
  end if;

  if p_record = 'idea' then
    select client_id into v_client from client_ideas where id = p_id;
  elsif p_record = 'brief' then
    select client_id into v_client from client_briefs where id = p_id;
  else
    select client_id into v_client from client_media_assets where id = p_id;
  end if;
  if v_client is null then
    raise exception 'No such %.', p_record using errcode = 'P0001';
  end if;
  if not can_access_client(v_client) then
    raise exception 'Not permitted for this client' using errcode = 'P0001';
  end if;

  if p_record = 'idea' then
    update client_ideas set archived_at = v_when where id = p_id;
  elsif p_record = 'brief' then
    update client_briefs set archived_at = v_when where id = p_id;
  else
    update client_media_assets set archived_at = v_when where id = p_id;
  end if;
end;
$$;

comment on function public.set_content_archived_v6(text, uuid, boolean) is
  'Archive or restore one idea, brief or asset by hand. Reversible, loses nothing, and leaves the record exactly where the Archive can still show it.';

revoke all on function public.set_content_archived_v6(text, uuid, boolean) from public, anon;
grant execute on function public.set_content_archived_v6(text, uuid, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- The end of an asset
-- ---------------------------------------------------------------------------

create or replace function public.delete_content_asset_v6(p_asset_id uuid)
returns table (
  deleted_frames integer,
  deleted_copy integer,
  deleted_posts integer,
  deleted_files integer
)
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_asset client_media_assets;
  v_paths text[];
  v_held text;
begin
  select * into v_asset from client_media_assets where id = p_asset_id;
  if v_asset.id is null then
    raise exception 'No such asset.' using errcode = 'P0001';
  end if;
  if not can_access_client(v_asset.client_id) then
    raise exception 'Not permitted for this client' using errcode = 'P0001';
  end if;

  -- The holds that are right to refuse. Named, with the reason, rather than
  -- left to arrive as a foreign key violation nobody can act on.
  if to_regclass('public.proof_placements') is not null then
    execute 'select ''a proof placement'' from proof_placements where asset_id = $1 limit 1'
      into v_held using p_asset_id;
    if v_held is not null then
      raise exception 'This asset is named by % and may be live somewhere public. Retract the placement first.', v_held
        using errcode = 'P0001';
    end if;
  end if;
  if to_regclass('public.proof_production_requests') is not null then
    execute 'select ''a proof production request'' from proof_production_requests where source_asset_id = $1 limit 1'
      into v_held using p_asset_id;
    if v_held is not null then
      raise exception 'This asset is the source of % and cannot be deleted while that record stands.', v_held
        using errcode = 'P0001';
    end if;
  end if;

  -- Every file this asset owns: its own, its render, and each frame's.
  select array_remove(array_agg(path), null) into v_paths from (
    select v_asset.storage_path as path
    union all select v_asset.render_path
    union all select f.storage_path from client_media_frames f where f.asset_id = p_asset_id
  ) files;

  with gone as (delete from client_media_frames where asset_id = p_asset_id returning 1)
    select count(*)::int into deleted_frames from gone;
  with gone as (delete from post_copy where asset_id = p_asset_id returning 1)
    select count(*)::int into deleted_copy from gone;
  with gone as (delete from scheduled_posts where asset_id = p_asset_id returning 1)
    select count(*)::int into deleted_posts from gone;
  delete from client_asset_reviews where asset_id = p_asset_id;

  -- The bucket. Guarded because the storage schema belongs to Supabase and is
  -- absent in a bare test database; a termination that cannot reach it should
  -- still remove the rows rather than fail halfway.
  deleted_files := 0;
  if to_regclass('storage.objects') is not null and coalesce(array_length(v_paths, 1), 0) > 0 then
    execute 'with gone as (delete from storage.objects where bucket_id = ''client-media'' and name = any($1) returning 1) select count(*)::int from gone'
      into deleted_files using v_paths;
  end if;

  delete from client_media_assets where id = p_asset_id;
  return next;
end;
$$;

comment on function public.delete_content_asset_v6(uuid) is
  'End one asset: its frames, captions, scheduled posts, reviews and its files in the bucket, and the asset itself. Refuses while a proof placement or proof production request names it, because those may describe something still live in public.';

revoke all on function public.delete_content_asset_v6(uuid) from public, anon;
grant execute on function public.delete_content_asset_v6(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- The end of a brief, and everything made from it
-- ---------------------------------------------------------------------------

-- Same scope as delete_client_idea, one stage down: a brief is not a record
-- worth keeping once the thing it described is gone, and leaving its assets
-- behind would orphan files nobody can find from any screen.
create or replace function public.delete_content_brief_v6(p_brief_id uuid)
returns table (
  deleted_frames integer,
  deleted_copy integer,
  deleted_posts integer,
  deleted_files integer
)
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_client uuid;
  v_asset uuid;
  v_one record;
begin
  select client_id into v_client from client_briefs where id = p_brief_id;
  if v_client is null then
    raise exception 'No such brief.' using errcode = 'P0001';
  end if;
  if not can_access_client(v_client) then
    raise exception 'Not permitted for this client' using errcode = 'P0001';
  end if;

  deleted_frames := 0; deleted_copy := 0; deleted_posts := 0; deleted_files := 0;
  for v_asset in select id from client_media_assets where brief_id = p_brief_id loop
    -- Each asset goes through the same door, so a held one refuses the whole
    -- delete rather than leaving a brief with one asset still attached.
    select * into v_one from public.delete_content_asset_v6(v_asset);
    deleted_frames := deleted_frames + v_one.deleted_frames;
    deleted_copy := deleted_copy + v_one.deleted_copy;
    deleted_posts := deleted_posts + v_one.deleted_posts;
    deleted_files := deleted_files + v_one.deleted_files;
  end loop;

  delete from client_briefs where id = p_brief_id;
  return next;
end;
$$;

comment on function public.delete_content_brief_v6(uuid) is
  'End one brief and every asset made from it, each through delete_content_asset_v6 so the same holds and the same cleanup apply.';

revoke all on function public.delete_content_brief_v6(uuid) from public, anon;
grant execute on function public.delete_content_brief_v6(uuid) to authenticated;

select lock_down_definer_functions();

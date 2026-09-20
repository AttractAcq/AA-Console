-- Filing a multi-frame asset and its frames together.
--
-- cma_frames_match_format refuses a carousel or story with fewer than two
-- frames, and it is deferred to commit. That is what makes the asset and its
-- frames one write: the client library issues one statement per call, so an
-- asset inserted on its own would reach commit with no frames and be
-- refused. Correctly — a carousel with nothing in it is not a carousel.
--
-- Runtime only. Everything that reaches here has already been rendered and
-- paid for, and the console has no reason to file frames by hand.

create or replace function save_framed_asset(
  p_client_id  uuid,
  p_brief_id   uuid,
  p_format     content_format,
  p_media_type media_type,
  p_title      text,
  p_frames     jsonb
)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_asset_id uuid;
  v_count    integer;
  v_first    text;
  frame      jsonb;
  v_pos      integer;
  v_path     text;
  seen       integer[] := '{}';
begin
  if auth.role() <> 'service_role' then
    raise exception 'Only the agent runtime may file a framed asset.';
  end if;
  if p_format = 'single' then
    raise exception 'save_framed_asset is for carousels and stories. A single asset is filed directly.';
  end if;

  v_count := coalesce(jsonb_array_length(p_frames), 0);
  if v_count < 2 then
    raise exception 'A % needs at least two frames; got %.', p_format, v_count;
  end if;

  -- Frame one is the cover, and it goes on the asset itself so every
  -- existing preview, signed-URL helper and approvals card keeps working
  -- without knowing frames exist at all.
  select f->>'storage_path' into v_first
    from jsonb_array_elements(p_frames) f
   where (f->>'position')::integer = 1;
  if v_first is null then
    raise exception 'The frames do not include a position 1, so there is no cover.';
  end if;

  insert into client_media_assets
    (client_id, brief_id, media_type, title, storage_path, review_status, content_format)
  values (p_client_id, p_brief_id, p_media_type, p_title, v_first, 'pending', p_format)
  returning id into v_asset_id;

  for frame in select * from jsonb_array_elements(p_frames) loop
    v_pos  := (frame->>'position')::integer;
    v_path := btrim(coalesce(frame->>'storage_path', ''));
    if v_pos is null or v_pos < 1 then
      raise exception 'Frame positions start at 1; got %.', frame->>'position';
    end if;
    if v_path = '' then
      raise exception 'Frame % has no stored file.', v_pos;
    end if;
    if v_pos = any (seen) then
      raise exception 'Two frames both claim position %.', v_pos;
    end if;
    seen := seen || v_pos;

    insert into client_media_frames (asset_id, position, storage_path, caption)
    values (v_asset_id, v_pos, v_path, nullif(btrim(coalesce(frame->>'caption', '')), ''));
  end loop;

  return v_asset_id;
end;
$$;

revoke all on function save_framed_asset(uuid, uuid, content_format, media_type, text, jsonb)
  from public, anon, authenticated;
grant execute on function save_framed_asset(uuid, uuid, content_format, media_type, text, jsonb)
  to service_role;

comment on function save_framed_asset(uuid, uuid, content_format, media_type, text, jsonb) is
  'Runtime-only. Files a carousel or story and its frames in one transaction, because the frames-match-format trigger is deferred and an asset written alone would reach commit with none. Frame one becomes the asset''s storage_path so existing previews are untouched.';

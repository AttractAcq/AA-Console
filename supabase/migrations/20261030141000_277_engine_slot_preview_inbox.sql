-- B008 / 277: expose every Engine approval entry in the canonical Inbox.
-- The slot event is the durable request epoch: a regenerated slot gets a new
-- event even if its asset, copy and schedule happen to be identical.
-- This is deliberately a blocked preview adapter. Storage paths can be
-- overwritten today, so hashing the path or a DB manifest would falsely
-- claim that the reviewer saw the media bytes that the publisher will send.
-- No owning decision or external-effect switch is changed here.

create or replace function public.can_review_approval_request_v6(
  p_client_id uuid, p_owner_role text
) returns boolean language sql stable security definer
set search_path = pg_catalog, public as $$
  select coalesce(public.is_admin(), false) or coalesce((
    p_client_id is not null and case
      when p_owner_role = 'admin_or_active_client_manager' then
        auth.uid() = public.active_video_approval_manager(p_client_id)
      when p_owner_role = 'client_media_reviewer' then
        public.can_access_client(p_client_id)
      else false
    end
  ), false);
$$;
revoke all on function public.can_review_approval_request_v6(uuid,text)
  from public, anon, service_role;
grant execute on function public.can_review_approval_request_v6(uuid,text)
  to authenticated;

create function public.engine_slot_inbox_payload_v6(p_event public.slot_events)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public set timezone = 'UTC' as $$
declare
  v_slot public.content_slots%rowtype;
  v_asset public.client_media_assets%rowtype;
  v_copy jsonb;
  v_snapshot jsonb;
  v_scope jsonb;
begin
  select * into v_slot from public.content_slots where id = p_event.slot_id;
  if not found or p_event.to_stage::text <> 'awaiting_approval' then
    raise exception 'The source is not an Engine approval entry.' using errcode = '23514';
  end if;
  if v_slot.asset_id is not null then
    select * into v_asset from public.client_media_assets
      where id = v_slot.asset_id and client_id = v_slot.client_id;
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', pc.id, 'platform', pc.platform, 'version', pc.version,
    'caption', pc.caption, 'hashtags', pc.hashtags,
    'alt_text', pc.alt_text, 'link_url', pc.link_url,
    'first_comment', pc.first_comment, 'cta', pc.cta
  ) order by pc.platform::text, pc.id), '[]'::jsonb)
    into v_copy from public.post_copy pc where pc.asset_id = v_slot.asset_id;
  v_scope := jsonb_build_object(
    'client_id', v_slot.client_id, 'slot_id', v_slot.id,
    'asset_id', v_slot.asset_id, 'platform', v_slot.platform,
    'scheduled_at', v_slot.scheduled_at, 'format', v_slot.format,
    'approval_entry_id', p_event.id);
  v_snapshot := jsonb_build_object(
    'slot', jsonb_build_object(
      'id', v_slot.id, 'platform', v_slot.platform,
      'scheduled_at', v_slot.scheduled_at, 'format', v_slot.format,
      'attempts', v_slot.attempts, 'brief_id', v_slot.brief_id,
      'idea_id', v_slot.idea_id),
    'asset', case when v_asset.id is null then null else jsonb_build_object(
      'id', v_asset.id, 'title', v_asset.title,
      'media_type', v_asset.media_type,
      'content_format', v_asset.content_format,
      'storage_path', v_asset.storage_path,
      'render_path', v_asset.render_path,
      'review_status', v_asset.review_status,
      'updated_at', v_asset.updated_at) end,
    'post_copy', v_copy,
    'approval_entry_id', p_event.id,
    'approval_entered_at', p_event.created_at);
  return jsonb_build_object(
    'client_id', v_slot.client_id,
    'source_system', 'aa_console',
    'source_kind', 'engine_slot',
    'source_id', v_slot.id,
    'source_version', p_event.id,
    'title', 'Engine slot: ' || coalesce(v_asset.title, v_slot.platform::text),
    'artifact_hash', null,
    'preview', v_snapshot || jsonb_build_object(
      'database_snapshot_sha256',
      encode(sha256(convert_to(v_snapshot::text, 'UTF8')), 'hex')),
    'destination', 'organic:' || v_slot.platform::text,
    'account_ref', null,
    'budget', null,
    'scope', v_scope,
    'owner_role', 'client_media_reviewer',
    'expires_at', least(v_slot.scheduled_at, p_event.created_at + interval '7 days'),
    'preview_blocker', case when v_asset.id is null then
      'The slot has no client-matched asset. Media bytes, copy and destination cannot be approved.'
      else
      'The media byte SHA-256 and immutable storage object version are not attested; the publisher account and last-moment copy check are also missing.' end,
    'owning_path', '/clients/' || v_slot.client_id::text ||
      '/delivery/approval-inbox?tab=engine');
end;
$$;
revoke all on function public.engine_slot_inbox_payload_v6(public.slot_events)
  from public, anon, authenticated, service_role;

create function public.register_engine_slot_inbox_v6()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public as $$
begin
  if new.to_stage::text = 'awaiting_approval' then
    perform public.register_approval_request_v6(
      public.engine_slot_inbox_payload_v6(new));
  end if;
  return new;
end;
$$;
revoke all on function public.register_engine_slot_inbox_v6()
  from public, anon, authenticated, service_role;
create trigger slot_events_inbox_register_v6
  after insert on public.slot_events
  for each row execute function public.register_engine_slot_inbox_v6();

-- Existing waiting slots are visible without fabricating a human decision.
-- A corrupt legacy slot without its entry event is visibly blocked as such.
do $$
declare
  v_slot public.content_slots%rowtype;
  v_event public.slot_events%rowtype;
begin
  for v_slot in select * from public.content_slots
    where stage::text = 'awaiting_approval'
  loop
    select * into v_event from public.slot_events
      where slot_id = v_slot.id and to_stage::text = 'awaiting_approval'
      order by created_at desc, id desc limit 1;
    if found then
      perform public.register_approval_request_v6(
        public.engine_slot_inbox_payload_v6(v_event));
    else
      perform public.register_approval_request_v6(jsonb_build_object(
        'client_id', v_slot.client_id,
        'source_system', 'aa_console', 'source_kind', 'engine_slot',
        'source_id', v_slot.id, 'source_version', 'legacy-missing-entry-event',
        'title', 'Engine slot with missing approval event',
        'preview', jsonb_build_object('slot_id', v_slot.id,
          'asset_id', v_slot.asset_id, 'scheduled_at', v_slot.scheduled_at),
        'destination', 'organic:' || v_slot.platform::text,
        'scope', jsonb_build_object('slot_id', v_slot.id,
          'client_id', v_slot.client_id),
        'owner_role', 'client_media_reviewer',
        'expires_at', v_slot.scheduled_at,
        'preview_blocker',
          'The append-only approval entry event is missing; the source epoch and media bytes cannot be verified.',
        'owning_path', '/clients/' || v_slot.client_id::text ||
          '/delivery/approval-inbox?tab=engine'));
    end if;
  end loop;
end;
$$;

select public.lock_down_definer_functions();

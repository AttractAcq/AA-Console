-- B008 / 278: one exact Google review reply and destination per approval.
-- The original reply RPC remains the owner. These triggers register its
-- candidate, then record the human AAL2 event in the same transaction as the
-- source status transition. This does not activate a Google write executor.

create function public.google_reply_inbox_payload_v6(
  p_reply public.google_review_replies
) returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public set timezone = 'UTC' as $$
declare
  v_review public.google_reviews%rowtype;
  v_location public.client_google_locations%rowtype;
  v_manifest jsonb;
  v_hash text;
  v_blocker text;
begin
  select * into v_review from public.google_reviews where id = p_reply.review_id;
  if v_review.id is not null then
    select * into v_location from public.client_google_locations
      where id = v_review.location_id;
  end if;
  v_manifest := jsonb_build_object(
    'reply_body', p_reply.body, 'reply_body_sha256', p_reply.body_hash,
    'review_id', p_reply.review_id,
    'review_ref', v_review.review_ref,
    'review_author', v_review.author_name,
    'review_stars', v_review.star_rating,
    'review_comment', v_review.comment,
    'review_url', v_review.review_url,
    'location_id', v_location.id,
    'location_ref', v_location.location_ref,
    'location_title', v_location.title);
  v_hash := encode(sha256(convert_to(v_manifest::text, 'UTF8')), 'hex');
  v_blocker := case
    when v_review.id is null or v_location.id is null
      then 'The source review or Google location is missing.'
    when v_review.client_id <> p_reply.client_id
      or v_location.client_id <> p_reply.client_id
      then 'The reply, review and location do not belong to one client.'
    when v_review.gone_at is not null
      then 'The source review is no longer present on Google.'
    when p_reply.body_hash <> encode(sha256(convert_to(p_reply.body, 'UTF8')), 'hex')
      then 'The reply words do not match their draft SHA-256.'
    else null end;
  return jsonb_build_object(
    'client_id', p_reply.client_id,
    'source_system', 'aa_console',
    'source_kind', 'google_review_reply',
    'source_id', p_reply.id,
    'source_version', v_hash,
    'title', 'Google review reply: ' || coalesce(v_location.title, 'missing location'),
    'artifact_hash', v_hash,
    'preview', v_manifest,
    'destination', case when v_location.location_ref is null
      or v_review.review_ref is null then null else
      'google_business:' || v_location.location_ref || '/reviews/' ||
      v_review.review_ref || '/reply' end,
    'account_ref', v_location.location_ref,
    'budget', null,
    'scope', jsonb_build_object(
      'client_id', p_reply.client_id, 'reply_id', p_reply.id,
      'review_id', p_reply.review_id, 'review_ref', v_review.review_ref,
      'location_id', v_location.id, 'location_ref', v_location.location_ref,
      'body_hash', p_reply.body_hash),
    'owner_role', 'admin_or_active_client_manager',
    'expires_at', p_reply.created_at + interval '7 days',
    'preview_blocker', v_blocker,
    'owning_path', '/clients/' || p_reply.client_id::text ||
      '/google-profile?tab=reviews');
end;
$$;
revoke all on function public.google_reply_inbox_payload_v6(
  public.google_review_replies) from public, anon, authenticated, service_role;

create function public.register_google_reply_inbox_v6()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public as $$
begin
  if new.status in ('drafted', 'awaiting_approval') then
    perform public.register_approval_request_v6(
      public.google_reply_inbox_payload_v6(new));
  end if;
  return new;
end;
$$;
revoke all on function public.register_google_reply_inbox_v6()
  from public, anon, authenticated, service_role;
create trigger google_reply_inbox_request_v6
  after insert or update of body, body_hash, review_id
  on public.google_review_replies
  for each row execute function public.register_google_reply_inbox_v6();

create function public.record_google_reply_inbox_decision_v6()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public as $$
declare
  v_payload jsonb;
  v_request public.approval_requests_v6%rowtype;
begin
  if old.status in ('drafted', 'awaiting_approval')
    and new.status in ('posting', 'posted') then
    raise exception 'A Google reply cannot be sent before its exact approval.'
      using errcode = '23514';
  end if;
  if old.status in ('drafted', 'awaiting_approval')
    and new.status in ('approved', 'rejected') then
    if (new.client_id, new.review_id, new.body, new.body_hash)
       is distinct from (old.client_id, old.review_id, old.body, old.body_hash) then
      raise exception 'Decide the exact draft already shown in the Inbox.'
        using errcode = '23514';
    end if;
    if new.status = 'approved'
      and (new.approved_by is distinct from auth.uid()
        or new.approved_at is null) then
      raise exception 'The source approval must identify the signed-in human.'
        using errcode = '42501';
    end if;
    v_payload := public.google_reply_inbox_payload_v6(old);
    if new.status = 'approved' and v_payload->>'preview_blocker' is not null then
      raise exception 'The Google reply is no longer decision-ready: %',
        v_payload->>'preview_blocker' using errcode = '23514';
    end if;
    select * into v_request from public.approval_requests_v6
      where source_system = 'aa_console'
        and source_kind = 'google_review_reply'
        and source_id = old.id::text
        and source_version = v_payload->>'source_version';
    if not found or v_request.artifact_hash is distinct from v_payload->>'artifact_hash'
      or v_request.preview is distinct from v_payload->'preview'
      or v_request.destination is distinct from v_payload->>'destination'
      or v_request.account_ref is distinct from v_payload->>'account_ref'
      or v_request.scope is distinct from v_payload->'scope'
      or v_request.preview_blocker is distinct from v_payload->>'preview_blocker' then
      raise exception 'The Google reply or target changed; draft a new approval.'
        using errcode = '23514';
    end if;
    perform public.record_approval_decision_v6(
      v_request.id, new.status, v_payload->>'artifact_hash',
      'google_review_replies:' || old.id::text,
      new.rejection_reason);
  end if;
  return new;
end;
$$;
revoke all on function public.record_google_reply_inbox_decision_v6()
  from public, anon, authenticated, service_role;
create trigger google_reply_inbox_decision_v6
  after update of status on public.google_review_replies
  for each row execute function public.record_google_reply_inbox_decision_v6();

-- Historical approved rows are source facts, not fabricated AAL2 events.
do $$
declare v_reply public.google_review_replies%rowtype;
begin
  for v_reply in select * from public.google_review_replies
    where status in ('drafted', 'awaiting_approval')
  loop
    perform public.register_approval_request_v6(
      public.google_reply_inbox_payload_v6(v_reply));
  end loop;
end;
$$;

select public.lock_down_definer_functions();

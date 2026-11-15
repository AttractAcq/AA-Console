-- A newly captured third-party review must still exist and carry a citable source.
-- Existing captures remain idempotent so historical references can be inspected.
create or replace function public.capture_google_review_as_proof_v6(p_review_id uuid)
returns uuid language plpgsql security definer
set search_path = pg_catalog, public as $$
declare v_review public.google_reviews%rowtype; v_proof uuid;
begin
  select * into v_review from public.google_reviews where id = p_review_id for update;
  if not found then raise exception 'No such review.' using errcode = 'P0001'; end if;
  if not (coalesce(public.is_admin(), false)
          or coalesce(auth.uid() = public.active_video_approval_manager(v_review.client_id), false)) then
    raise exception 'Only an admin or the assigned client manager can capture proof.'
      using errcode = 'P0001';
  end if;
  if v_review.captured_proof_id is not null then
    return v_review.captured_proof_id;
  end if;
  if v_review.gone_at is not null then
    raise exception 'That review has been removed from Google.' using errcode = 'P0001';
  end if;
  if nullif(btrim(coalesce(v_review.comment, '')), '') is null then
    raise exception 'That review has no words in it to use as evidence.' using errcode = 'P0001';
  end if;
  if nullif(btrim(coalesce(v_review.review_url, '')), '') is null or v_review.reviewed_at is null then
    raise exception 'That review needs its original URL and date before capture.' using errcode = 'P0001';
  end if;

  insert into public.client_proof_assets (
    client_id, media_type, title, body, proof_type, source, usage_rights, captured_on)
  values (
    v_review.client_id, 'text',
    coalesce(v_review.author_name, 'A Google reviewer') || ' · ' ||
      coalesce(v_review.star_rating::text || ' stars', 'review'),
    v_review.comment, 'review', v_review.review_url, 'not_cleared', v_review.reviewed_at::date)
  returning id into v_proof;

  update public.google_reviews set captured_proof_id = v_proof where id = p_review_id;
  return v_proof;
end $$;

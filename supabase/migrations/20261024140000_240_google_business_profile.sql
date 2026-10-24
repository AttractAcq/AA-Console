-- Google Business Profile: the location, its reviews, and what we may change.
--
-- The transport already exists. Migration 231 brought up the proof placement
-- sweep and the runtime's local-posts adapter, so a cleared proof derivative
-- can already reach a real profile once a credential exists. What has never
-- existed is any record of the profile itself: which location, whether it is
-- verified, what is missing from it, and what its reviews say.
--
-- THE REVIEW LOOP IS THE POINT
--
-- Proof Bank's whole premise is genuine customer evidence, and its first
-- named source is "online reviews". Today those are typed in by hand from a
-- browser tab, which means the author, the URL and the date are whatever
-- somebody copied, and a review that gets edited or deleted leaves a proof
-- asset quoting something that no longer exists.
--
-- So reviews are ingested with their provider id, their author, their star
-- rating, their text and their time, and `captured_proof_id` records when one
-- has become evidence. A review that disappears from the profile is marked
-- gone rather than deleted, because a proof asset may be resting on it.
--
-- WHAT THIS DOES NOT DO
--
-- It changes nothing on a profile. A reply is drafted and waits for a person;
-- a profile field change is recorded as a proposal with its before and after.
-- Both need the same exact-version approval every other external effect does,
-- and the ingest itself needs a `google_business` credential that no client
-- has yet — so applying this leaves every profile untouched and every list
-- empty, with the due view saying which of those it is.

-- ---------------------------------------------------------------------------
-- The location
-- ---------------------------------------------------------------------------

create table public.client_google_locations (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,

  -- Google's own name for it: accounts/{account}/locations/{location}. The
  -- same handle `client_proof_destinations.account_ref` carries, because a
  -- proof placement and a profile read are talking about one place.
  location_ref text not null check (location_ref ~ '^accounts/[A-Za-z0-9_-]+/locations/[A-Za-z0-9_-]+$'),
  title text not null check (length(btrim(title)) between 1 and 300),
  address text,
  primary_phone text,
  website_url text,

  verification_state text not null default 'unknown' check (verification_state in (
    'unknown', 'verified', 'unverified', 'suspended', 'no_access')),

  -- What the last read saw. A snapshot rather than a set of columns per
  -- field: Google changes its shape faster than this schema should.
  profile_snapshot jsonb not null default '{}'::jsonb,
  /** Fields the snapshot shows as empty, named so the screen is not a diff. */
  missing_fields text[] not null default '{}',

  last_read_at timestamptz,
  last_read_error text,

  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (client_id, location_ref),
  unique (id, client_id)
);

comment on table public.client_google_locations is
  'One Google Business Profile location this client has connected, as the last read saw it. Reading is not changing: nothing here edits a profile.';

create trigger client_google_locations_updated_at before update on public.client_google_locations
  for each row execute function public.set_updated_at();

alter table public.client_google_locations enable row level security;
create policy client_google_locations_read on public.client_google_locations
  for select to authenticated using (public.can_access_client(client_id));
create policy client_google_locations_write on public.client_google_locations
  for all to authenticated
  using (public.is_admin() or auth.uid() = public.active_video_approval_manager(client_id))
  with check (public.is_admin() or auth.uid() = public.active_video_approval_manager(client_id));
grant select, insert, update, delete on public.client_google_locations to authenticated;
grant all on public.client_google_locations to service_role;

-- ---------------------------------------------------------------------------
-- The reviews
-- ---------------------------------------------------------------------------

create table public.google_reviews (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  location_id uuid not null references public.client_google_locations(id) on delete cascade,

  -- Google's id for the review, which is what makes a second ingest an
  -- update rather than a duplicate.
  review_ref text not null,
  author_name text,
  star_rating integer check (star_rating between 1 and 5),
  comment text,
  review_url text,
  reviewed_at timestamptz,

  -- A review that vanishes from the profile is marked, never deleted: a proof
  -- asset may be resting on it, and "the evidence is gone" is a thing
  -- somebody needs to be told rather than a row that silently disappears.
  seen_at timestamptz not null default now(),
  gone_at timestamptz,

  -- Set when this review has been captured into the Proof Bank.
  captured_proof_id uuid references public.client_proof_assets(id) on delete set null,

  created_at timestamptz not null default now(),
  unique (location_id, review_ref)
);

comment on table public.google_reviews is
  'Genuine reviews as they appear on the profile, with their author, rating, text, url and time. Proof Bank''s first named source, arriving as evidence instead of being retyped from a browser tab.';

create index google_reviews_client_idx
  on public.google_reviews (client_id, reviewed_at desc);
create index google_reviews_unanswered_idx
  on public.google_reviews (location_id) where gone_at is null;

alter table public.google_reviews enable row level security;
create policy google_reviews_read on public.google_reviews
  for select to authenticated using (public.can_access_client(client_id));
grant select on public.google_reviews to authenticated;
grant all on public.google_reviews to service_role;

-- ---------------------------------------------------------------------------
-- Replying, which is an external effect
-- ---------------------------------------------------------------------------

create table public.google_review_replies (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  review_id uuid not null references public.google_reviews(id) on delete cascade,

  body text not null check (length(btrim(body)) between 1 and 4000),
  -- The exact words, hashed, so editing the draft after approval invalidates
  -- it rather than posting something nobody read.
  body_hash text not null check (body_hash ~ '^[0-9a-f]{64}$'),
  drafted_by_job_id uuid references public.agent_jobs(id) on delete set null,

  status text not null default 'drafted' check (status in (
    'drafted', 'awaiting_approval', 'approved', 'posting', 'posted', 'failed', 'rejected')),
  approved_by uuid references public.profiles(id) on delete set null,
  approved_at timestamptz,
  rejection_reason text,

  attempts integer not null default 0,
  lease_until timestamptz,
  external_ref text,
  posted_at timestamptz,
  last_error text,

  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One live reply per review. Google keeps one reply per review, so a second
-- approved draft is two people answering the same customer.
create unique index google_review_reply_live_idx
  on public.google_review_replies (review_id)
  where status in ('drafted', 'awaiting_approval', 'approved', 'posting', 'posted');

create trigger google_review_replies_updated_at before update on public.google_review_replies
  for each row execute function public.set_updated_at();

alter table public.google_review_replies enable row level security;
create policy google_review_replies_read on public.google_review_replies
  for select to authenticated using (public.can_access_client(client_id));
grant select on public.google_review_replies to authenticated;
grant all on public.google_review_replies to service_role;

-- ---------------------------------------------------------------------------
-- Proposed profile changes
-- ---------------------------------------------------------------------------

-- A before and an after, per field. Not a patch: somebody has to be able to
-- see what the profile says today beside what we would make it say, and a
-- patch hides the first half.
create table public.google_profile_changes (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  location_id uuid not null references public.client_google_locations(id) on delete cascade,

  field text not null check (field in (
    'title', 'description', 'primary_phone', 'website_url', 'hours', 'services', 'categories', 'photos')),
  current_value text,
  proposed_value text not null check (length(btrim(proposed_value)) between 1 and 4000),
  reason text,

  status text not null default 'drafted' check (status in (
    'drafted', 'awaiting_approval', 'approved', 'applied', 'failed', 'rejected')),
  approved_by uuid references public.profiles(id) on delete set null,
  approved_at timestamptz,
  rejection_reason text,
  applied_at timestamptz,
  last_error text,

  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger google_profile_changes_updated_at before update on public.google_profile_changes
  for each row execute function public.set_updated_at();

alter table public.google_profile_changes enable row level security;
create policy google_profile_changes_read on public.google_profile_changes
  for select to authenticated using (public.can_access_client(client_id));
grant select on public.google_profile_changes to authenticated;
grant all on public.google_profile_changes to service_role;

-- ---------------------------------------------------------------------------
-- Drafting and deciding a reply
-- ---------------------------------------------------------------------------

create function public.draft_google_review_reply_v6(p_review_id uuid, p_body text)
returns uuid language plpgsql security definer
set search_path = pg_catalog, public as $$
declare v_review public.google_reviews%rowtype; v_id uuid;
begin
  select * into v_review from public.google_reviews where id = p_review_id;
  if not found then raise exception 'No such review.' using errcode = 'P0001'; end if;
  if coalesce(auth.role(), '') <> 'service_role'
     and not (coalesce(public.is_admin(), false)
              or coalesce(auth.uid() = public.active_video_approval_manager(v_review.client_id), false)) then
    raise exception 'Only an admin or the assigned client manager can draft a reply.'
      using errcode = 'P0001';
  end if;
  if v_review.gone_at is not null then
    raise exception 'That review is no longer on the profile, so there is nothing to reply to.'
      using errcode = 'P0001';
  end if;

  insert into public.google_review_replies (client_id, review_id, body, body_hash, created_by)
  values (v_review.client_id, p_review_id, btrim(p_body),
          encode(sha256(convert_to(btrim(p_body), 'UTF8')), 'hex'),
          nullif(auth.uid(), null))
  returning id into v_id;
  return v_id;
end $$;

revoke all on function public.draft_google_review_reply_v6(uuid, text) from public, anon;
grant execute on function public.draft_google_review_reply_v6(uuid, text) to authenticated, service_role;

create function public.decide_google_review_reply_v6(
  p_reply_id uuid, p_approved boolean, p_reason text default null)
returns public.google_review_replies language plpgsql security definer
set search_path = pg_catalog, public as $$
declare v_reply public.google_review_replies%rowtype;
begin
  select * into v_reply from public.google_review_replies where id = p_reply_id for update;
  if not found then raise exception 'No such reply.' using errcode = 'P0001'; end if;
  if auth.role() is distinct from 'authenticated'
     or not (coalesce(public.is_admin(), false)
             or coalesce(auth.uid() = public.active_video_approval_manager(v_reply.client_id), false)) then
    raise exception 'A signed-in admin or the assigned client manager must decide this.'
      using errcode = 'P0001';
  end if;
  if v_reply.status not in ('drafted', 'awaiting_approval') then
    raise exception 'That reply is %, not waiting for a decision.', v_reply.status
      using errcode = 'P0001';
  end if;
  -- The words may have been edited since they were read.
  if v_reply.body_hash <> encode(sha256(convert_to(v_reply.body, 'UTF8')), 'hex') then
    raise exception 'This reply was edited after it was read. Draft it again.' using errcode = 'P0001';
  end if;

  if not coalesce(p_approved, false) then
    if nullif(btrim(coalesce(p_reason, '')), '') is null then
      raise exception 'Say why it was rejected.' using errcode = 'P0001';
    end if;
    update public.google_review_replies
       set status = 'rejected', rejection_reason = btrim(p_reason)
     where id = p_reply_id returning * into v_reply;
    return v_reply;
  end if;

  update public.google_review_replies
     set status = 'approved', approved_by = auth.uid(), approved_at = now()
   where id = p_reply_id returning * into v_reply;
  return v_reply;
end $$;

revoke all on function public.decide_google_review_reply_v6(uuid, boolean, text) from public, anon;
grant execute on function public.decide_google_review_reply_v6(uuid, boolean, text) to authenticated;

-- ---------------------------------------------------------------------------
-- A review becomes proof
-- ---------------------------------------------------------------------------

-- The loop Proof Bank was built for. The review's own author, text, url and
-- date travel with it, so the proof asset cites the thing itself rather than
-- somebody's transcription — and the review records that it has been used,
-- so a later disappearance can be traced to the proof resting on it.
create function public.capture_google_review_as_proof_v6(p_review_id uuid)
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
  if nullif(btrim(coalesce(v_review.comment, '')), '') is null then
    raise exception 'That review has no words in it to use as evidence.' using errcode = 'P0001';
  end if;

  -- Uncleared, like every other raw source: a public review is not a blanket
  -- permission to republish it, which migration 218's note about third-party
  -- visibility makes explicit.
  -- `media_type` is required and the url column is `source`: a review is text
  -- proof, and its body lives in the table rather than in Storage.
  insert into public.client_proof_assets (
    client_id, media_type, title, body, proof_type, source, usage_rights, captured_on)
  values (
    v_review.client_id,
    'text',
    coalesce(v_review.author_name, 'A Google reviewer') || ' · ' ||
      coalesce(v_review.star_rating::text || ' stars', 'review'),
    v_review.comment,
    'review',
    v_review.review_url,
    'not_cleared',
    coalesce(v_review.reviewed_at::date, current_date))
  returning id into v_proof;

  update public.google_reviews set captured_proof_id = v_proof where id = p_review_id;
  return v_proof;
end $$;

revoke all on function public.capture_google_review_as_proof_v6(uuid) from public, anon;
grant execute on function public.capture_google_review_as_proof_v6(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- What the profile looks like, and what is stopping anything
-- ---------------------------------------------------------------------------

create or replace view google_profile_due with (security_invoker = true) as
select
  l.id as location_id,
  l.client_id,
  l.location_ref,
  l.title,
  l.verification_state,
  l.missing_fields,
  l.last_read_at,
  l.last_read_error,
  (select count(*) from public.google_reviews r
    where r.location_id = l.id and r.gone_at is null) as reviews,
  (select count(*) from public.google_reviews r
    where r.location_id = l.id and r.gone_at is null
      and not exists (select 1 from public.google_review_replies p
                       where p.review_id = r.id and p.status = 'posted')) as unanswered,
  (select count(*) from public.google_reviews r
    where r.location_id = l.id and r.captured_proof_id is not null) as captured_as_proof,
  (select count(*) from public.google_reviews r
    where r.location_id = l.id and r.gone_at is not null
      and r.captured_proof_id is not null) as gone_but_cited,
  case
    when l.verification_state = 'no_access'
      then 'This credential cannot see the location any more.'
    when l.verification_state = 'suspended' then 'Google has suspended this profile.'
    when l.verification_state = 'unverified'
      then 'The location is not verified, so changes and posts will be refused.'
    when not public.integration_usable(l.client_id, 'google_business')
      then 'No usable google_business integration for this client.'
    when l.last_read_at is null
      then 'Nothing has been read from this profile yet.'
    when l.last_read_error is not null then 'The last read failed: ' || l.last_read_error
    else null
  end as blocker
from public.client_google_locations l;

comment on view google_profile_due is
  'Each connected location, what the last read saw, and the one sentence saying why nothing can be read or changed. "gone_but_cited" is the count that matters: reviews that have left the profile while a proof asset still rests on them.';

grant select on google_profile_due to authenticated;

select lock_down_definer_functions();

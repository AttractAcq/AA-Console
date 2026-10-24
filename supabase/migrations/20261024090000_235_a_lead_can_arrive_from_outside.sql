-- Nothing in this system has ever created a lead from outside the building.
--
-- `client_leads` is four years of careful thinking about what happens to a
-- lead once it exists: nine stages, an owner, a next action, an appointment
-- lifecycle, sale and cash values, and five attribution columns so revenue
-- can be traced back to the post that caused it. All of it reachable only by
-- a signed-in person typing a name into a form in the Console.
--
-- So the two acceptance gates that matter most cannot be reached. Lead Magnet
-- Studio's gate is "a real user submits an opt-in, receives the exact
-- promised magnet once, and is recorded as a consented, attributed lead".
-- Website Studio's is "a real test submission reaches Sales OS with
-- campaign, source and consent". Both wait on the same missing piece, and it
-- is not a page: it is a way for a stranger to become a row.
--
-- This is that piece, and it is deliberately not the Lead Magnet. A magnet,
-- a campaign landing page and a sales-agent widget are three things that all
-- need one public intake with one consent record and one deduplication rule.
-- Building it inside whichever page happens to go first is how you end up
-- with three.
--
-- WHAT A LEAD FROM OUTSIDE NEEDS THAT AN INTERNAL ONE DOES NOT
--
-- Consent. There is no consent column anywhere in this database today, which
-- is survivable while every lead was typed by an employee and indefensible
-- the moment one arrives from a form. What is stored is the wording the
-- person actually saw, not a boolean: "they ticked a box" is not a record of
-- what they agreed to, and the box's wording changes.
--
-- The operational campaign. `source_campaign_id` points at `campaigns`,
-- which is the ad-spend tracker. A v6 campaign is `client_campaigns`, and
-- the two have never been bridged for leads. Both columns exist here,
-- because a paid lead genuinely has both and conflating them is how
-- attribution stops reconciling.
--
-- A click id. `gclid` and `fbclid` are the only durable link between a lead
-- and the ad that produced it, and they arrive on the URL or not at all.
--
-- A deduplication rule. The same person filling in two forms is one lead
-- with two touches, not two leads. Generated from the email, falling back to
-- the phone, so the rule lives in the column rather than in each caller.
--
-- WHAT THIS DOES NOT DO
--
-- It accepts nothing yet. `capture_lead_v6` is service-role only, the public
-- route that calls it arrives with the runtime in the same release, and
-- every endpoint is created disabled with an expiry and a submission ceiling.
-- Applying this migration changes no client's public surface.

-- ---------------------------------------------------------------------------
-- What a lead now carries
-- ---------------------------------------------------------------------------

alter table public.client_leads
  -- The wording shown, verbatim, and when they agreed to it. Nullable,
  -- because a lead an employee typed in from a phone call never saw a form
  -- and pretending otherwise would be the worst kind of tidy.
  add column if not exists consent_given_at timestamptz,
  add column if not exists consent_wording text,
  -- Where the agreement happened and what we can prove about it: the
  -- endpoint, a hashed ip, a hashed user agent. Never a raw ip: it is
  -- personal data and a hash answers every question we actually ask of it.
  add column if not exists consent_evidence jsonb,

  -- The v6 campaign, beside the legacy spend row rather than instead of it.
  add column if not exists source_client_campaign_id uuid
    references public.client_campaigns(id) on delete set null,
  -- gclid, fbclid, or whatever the platform calls it next.
  add column if not exists source_click_id text,
  add column if not exists source_utm jsonb,

  add constraint client_leads_consent_is_whole check (
    (consent_given_at is null and consent_wording is null)
    or (consent_given_at is not null
        and nullif(btrim(consent_wording), '') is not null));

comment on column public.client_leads.consent_wording is
  'The exact words this person agreed to, stored because "they ticked a box" is not a record of what they consented to and the box changes.';
comment on column public.client_leads.source_client_campaign_id is
  'The operational v6 campaign. Beside source_campaign_id, which is the ad-spend row, because a paid lead has both and conflating them stops attribution reconciling.';

-- One rule for "the same person twice", in one place, used by both the
-- stored column and the lookup that reads it. Two copies of this expression
-- is exactly the drift worth avoiding: the day they disagree, a lead
-- deduplicates on write and not on read, or the reverse.
--
-- Email is matched exactly, lowercased. It is what a magnet is delivered to,
-- and two addresses that differ are two addresses.
--
-- Phone is matched on its last nine digits, which is the part that does not
-- change between the ways people write the same number: 07700 900123 and
-- +44 7700 900123 are one customer, and a plain digit strip calls them two.
-- Nine rather than all of them because the country code and the trunk zero
-- are precisely what varies; nine rather than seven because merging two
-- strangers is worse than missing a merge, and nine digits make a collision
-- vanishingly unlikely while seven do not.
create function public.lead_dedupe_key(p_email text, p_phone text)
returns text language sql immutable
set search_path = pg_catalog, public as $$
  select coalesce(
    nullif(lower(btrim(p_email)), ''),
    nullif(right(regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g'), 9), ''));
$$;

comment on function public.lead_dedupe_key(text, text) is
  'The single rule for whether two contacts are the same person: exact on email, last nine digits on phone. Changing it does not rewrite the stored keys on client_leads, so a change needs a backfill.';

revoke all on function public.lead_dedupe_key(text, text) from public, anon;
grant execute on function public.lead_dedupe_key(text, text) to authenticated, service_role;

alter table public.client_leads
  add column if not exists dedupe_key text
    generated always as (public.lead_dedupe_key(email, phone)) stored;

create index if not exists client_leads_dedupe_idx
  on public.client_leads (client_id, dedupe_key) where dedupe_key is not null;

-- ---------------------------------------------------------------------------
-- Where a stranger can post
-- ---------------------------------------------------------------------------

-- Modelled on `proof_capture_links` (migration 216), which is the working
-- precedent in this database for letting the outside world write something:
-- a hashed token, an expiry, a submission ceiling, revocation, and a client
-- that every row is scoped to.
create table public.lead_capture_endpoints (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,

  -- What this endpoint is for. The lifecycle differs: a magnet opt-in owes
  -- the person a file, a page form owes them a call back.
  purpose text not null check (purpose in ('magnet_optin', 'page_form', 'agent_handoff')),

  -- Never the token. Only its hash, so a leaked table is not a set of live
  -- endpoints. Same reasoning as 216.
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),

  -- What a lead captured here is attributed to. All optional: a general
  -- enquiry form belongs to no campaign and saying otherwise would be a lie
  -- the attribution layer then has to live with.
  campaign_id uuid references public.client_campaigns(id) on delete set null,
  page_id uuid references public.client_pages(id) on delete set null,
  source_channel text,

  -- The words every person submitting here will have agreed to, frozen on
  -- the endpoint. Changing them is a new endpoint, because leads already
  -- captured agreed to the old ones.
  consent_wording text not null check (length(btrim(consent_wording)) between 10 and 2000),

  enabled boolean not null default false,
  expires_at timestamptz not null,
  max_submissions integer not null default 500 check (max_submissions > 0),
  submissions integer not null default 0 check (submissions >= 0),
  revoked_at timestamptz,

  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, client_id)
);

comment on table public.lead_capture_endpoints is
  'Where the outside world may create a lead for one client, and under what wording. Disabled, expiring and quota-capped by default: the three things that make a public write path survivable.';

create index lead_capture_endpoints_client_idx
  on public.lead_capture_endpoints (client_id, purpose, created_at desc);

create trigger lead_capture_endpoints_updated_at
  before update on public.lead_capture_endpoints
  for each row execute function public.set_updated_at();

alter table public.lead_capture_endpoints enable row level security;
create policy lead_capture_endpoints_read on public.lead_capture_endpoints
  for select to authenticated using (public.can_access_client(client_id));
grant select on public.lead_capture_endpoints to authenticated;
grant all on public.lead_capture_endpoints to service_role;

-- ---------------------------------------------------------------------------
-- What they posted
-- ---------------------------------------------------------------------------

-- Kept separately from the lead, and kept even when it does not become one.
-- A submission is what happened; a lead is what we decided it meant. The day
-- somebody asks "did this person ever contact us" the answer has to survive
-- a deduplication that merged them into an existing row.
create table public.lead_submissions (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  endpoint_id uuid not null references public.lead_capture_endpoints(id) on delete restrict,

  name text check (name is null or length(btrim(name)) between 1 and 200),
  email text check (email is null or length(btrim(email)) between 3 and 320),
  phone text check (phone is null or length(btrim(phone)) between 5 and 40),
  message text check (message is null or length(btrim(message)) <= 4000),

  -- A submission with neither is unanswerable, so it is refused at capture
  -- rather than stored as a lead nobody can contact.
  constraint lead_submission_is_contactable
    check (nullif(btrim(coalesce(email, '')), '') is not null
        or nullif(btrim(coalesce(phone, '')), '') is not null),

  -- The consent, snapshotted from the endpoint at the moment of submission.
  consent_wording text not null,
  consent_given_at timestamptz not null,
  consent_evidence jsonb not null default '{}'::jsonb,

  click_id text,
  utm jsonb,

  -- The same form posted twice by an impatient person is one submission.
  idempotency_key text not null check (length(btrim(idempotency_key)) between 1 and 160),

  status text not null default 'received' check (status in ('received', 'promoted', 'rejected')),
  lead_id uuid references public.client_leads(id) on delete set null,
  rejected_reason text,

  created_at timestamptz not null default now(),
  unique (client_id, idempotency_key)
);

comment on table public.lead_submissions is
  'Every public submission, kept whether or not it became a lead. A deduplicated submission still happened, and merging it into an existing lead must not erase that it did.';

create index lead_submissions_client_idx
  on public.lead_submissions (client_id, created_at desc);
create index lead_submissions_endpoint_idx
  on public.lead_submissions (endpoint_id, created_at desc);

alter table public.lead_submissions enable row level security;
create policy lead_submissions_read on public.lead_submissions
  for select to authenticated using (public.can_access_client(client_id));
grant select on public.lead_submissions to authenticated;
grant all on public.lead_submissions to service_role;

-- ---------------------------------------------------------------------------
-- Creating the endpoint
-- ---------------------------------------------------------------------------

-- The token is returned once, here, and never stored. Whoever calls this is
-- responsible for putting it somewhere useful; the database keeps only the
-- hash, so losing it means issuing a new one rather than reading the old one
-- back out.
create function public.create_lead_capture_endpoint_v6(
  p_client_id uuid,
  p_purpose text,
  p_token_hash text,
  p_consent_wording text,
  p_campaign_id uuid default null,
  p_page_id uuid default null,
  p_source_channel text default null,
  p_days integer default 90,
  p_max_submissions integer default 500
) returns public.lead_capture_endpoints
language plpgsql security definer
set search_path = pg_catalog, public as $$
declare v_row public.lead_capture_endpoints%rowtype;
begin
  if coalesce(auth.role(), '') <> 'service_role'
     and not (coalesce(public.is_admin(), false)
              or coalesce(auth.uid() = public.active_video_approval_manager(p_client_id), false)) then
    raise exception 'Only an admin or the assigned client manager can open a capture endpoint.'
      using errcode = 'P0001';
  end if;
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'A hashed token is required.' using errcode = 'P0001';
  end if;
  -- The campaign has to belong to the client, or an endpoint could attribute
  -- one client's leads to another's campaign.
  if p_campaign_id is not null and not exists (
    select 1 from public.client_campaigns
     where id = p_campaign_id and client_id = p_client_id) then
    raise exception 'That campaign does not belong to this client.' using errcode = 'P0001';
  end if;
  if p_page_id is not null and not exists (
    select 1 from public.client_pages where id = p_page_id and client_id = p_client_id) then
    raise exception 'That page does not belong to this client.' using errcode = 'P0001';
  end if;

  insert into public.lead_capture_endpoints (
    client_id, purpose, token_hash, campaign_id, page_id, source_channel,
    consent_wording, expires_at, max_submissions, created_by)
  values (
    p_client_id, p_purpose, p_token_hash, p_campaign_id, p_page_id, p_source_channel,
    btrim(p_consent_wording),
    now() + make_interval(days => greatest(coalesce(p_days, 90), 1)),
    greatest(coalesce(p_max_submissions, 500), 1),
    nullif(auth.uid(), null))
  returning * into v_row;
  return v_row;
end $$;

revoke all on function public.create_lead_capture_endpoint_v6(
  uuid, text, text, text, uuid, uuid, text, integer, integer) from public, anon;
grant execute on function public.create_lead_capture_endpoint_v6(
  uuid, text, text, text, uuid, uuid, text, integer, integer) to authenticated, service_role;

create function public.set_lead_capture_enabled_v6(p_endpoint_id uuid, p_enabled boolean)
returns public.lead_capture_endpoints
language plpgsql security definer
set search_path = pg_catalog, public as $$
declare v_row public.lead_capture_endpoints%rowtype;
begin
  select * into v_row from public.lead_capture_endpoints where id = p_endpoint_id;
  if not found then raise exception 'No such endpoint.' using errcode = 'P0001'; end if;
  if not (coalesce(public.is_admin(), false)
          or coalesce(auth.uid() = public.active_video_approval_manager(v_row.client_id), false)) then
    raise exception 'Only an admin or the assigned client manager can change this.'
      using errcode = 'P0001';
  end if;
  update public.lead_capture_endpoints
     set enabled = coalesce(p_enabled, false)
   where id = p_endpoint_id
   returning * into v_row;
  return v_row;
end $$;

revoke all on function public.set_lead_capture_enabled_v6(uuid, boolean) from public, anon;
grant execute on function public.set_lead_capture_enabled_v6(uuid, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- A stranger becomes a row
-- ---------------------------------------------------------------------------

-- Service role only. The public route in the runtime holds the service key,
-- validates nothing itself beyond shape, and lets this function make every
-- decision that matters — so there is one place where "may this become a
-- lead" is answered.
create function public.capture_lead_v6(
  p_token_hash text,
  p_idempotency_key text,
  p_name text default null,
  p_email text default null,
  p_phone text default null,
  p_message text default null,
  p_consented boolean default false,
  p_evidence jsonb default '{}'::jsonb,
  p_click_id text default null,
  p_utm jsonb default null
) returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public as $$
declare
  v_endpoint public.lead_capture_endpoints%rowtype;
  v_existing public.lead_submissions%rowtype;
  v_submission public.lead_submissions%rowtype;
  v_lead public.client_leads%rowtype;
  v_key text := btrim(coalesce(p_idempotency_key, ''));
  v_dedupe text;
  v_created boolean := false;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Only the internal service may capture a lead.';
  end if;

  select * into v_endpoint from public.lead_capture_endpoints
   where token_hash = p_token_hash;
  -- One sentence for every refusal, and the same sentence whether the token
  -- is wrong or the endpoint is off: a public caller learns nothing about
  -- which it was.
  if not found or not v_endpoint.enabled
     or v_endpoint.revoked_at is not null
     or v_endpoint.expires_at < now() then
    return jsonb_build_object('ok', false, 'reason', 'This form is not accepting submissions.');
  end if;
  if v_endpoint.submissions >= v_endpoint.max_submissions then
    return jsonb_build_object('ok', false, 'reason', 'This form has reached its limit.');
  end if;
  if not coalesce(p_consented, false) then
    return jsonb_build_object('ok', false, 'reason', 'Consent is required.');
  end if;
  if nullif(btrim(coalesce(p_email, '')), '') is null
     and nullif(btrim(coalesce(p_phone, '')), '') is null then
    return jsonb_build_object('ok', false, 'reason', 'An email address or a phone number is required.');
  end if;
  if v_key = '' then
    return jsonb_build_object('ok', false, 'reason', 'A submission reference is required.');
  end if;

  -- The same form posted twice is one submission. Taken on the client and
  -- key rather than globally, so two clients cannot collide.
  perform pg_advisory_xact_lock(hashtextextended(v_endpoint.client_id::text || ':lead:' || v_key, 0));
  select * into v_existing from public.lead_submissions
   where client_id = v_endpoint.client_id and idempotency_key = v_key;
  if found then
    return jsonb_build_object(
      'ok', true, 'submission_id', v_existing.id, 'lead_id', v_existing.lead_id,
      'created', false, 'repeat', true);
  end if;

  insert into public.lead_submissions (
    client_id, endpoint_id, name, email, phone, message,
    consent_wording, consent_given_at, consent_evidence,
    click_id, utm, idempotency_key)
  values (
    v_endpoint.client_id, v_endpoint.id,
    nullif(btrim(coalesce(p_name, '')), ''),
    nullif(btrim(coalesce(p_email, '')), ''),
    nullif(btrim(coalesce(p_phone, '')), ''),
    nullif(btrim(coalesce(p_message, '')), ''),
    -- Snapshotted, not referenced. The endpoint's wording may change; what
    -- this person agreed to may not.
    v_endpoint.consent_wording, now(),
    coalesce(p_evidence, '{}'::jsonb) || jsonb_build_object('endpoint_id', v_endpoint.id),
    nullif(btrim(coalesce(p_click_id, '')), ''), p_utm, v_key)
  returning * into v_submission;

  update public.lead_capture_endpoints
     set submissions = submissions + 1 where id = v_endpoint.id;

  -- Deduplicate into an existing lead where one matches, and record the
  -- touch either way. A returning customer is one lead with a history, not a
  -- second row with half of it.
  v_dedupe := public.lead_dedupe_key(p_email, p_phone);

  select * into v_lead from public.client_leads
   where client_id = v_endpoint.client_id and dedupe_key = v_dedupe
   order by created_at limit 1;

  if not found then
    insert into public.client_leads (
      client_id, name, email, phone, contact, notes, source, source_channel,
      consent_given_at, consent_wording, consent_evidence,
      source_client_campaign_id, source_page_id, source_click_id, source_utm)
    values (
      v_endpoint.client_id,
      nullif(btrim(coalesce(p_name, '')), ''),
      nullif(btrim(coalesce(p_email, '')), ''),
      nullif(btrim(coalesce(p_phone, '')), ''),
      coalesce(nullif(btrim(coalesce(p_email, '')), ''), nullif(btrim(coalesce(p_phone, '')), '')),
      nullif(btrim(coalesce(p_message, '')), ''),
      v_endpoint.purpose,
      coalesce(v_endpoint.source_channel, v_endpoint.purpose),
      v_submission.consent_given_at, v_submission.consent_wording, v_submission.consent_evidence,
      v_endpoint.campaign_id, v_endpoint.page_id,
      v_submission.click_id, v_submission.utm)
    returning * into v_lead;
    v_created := true;
  end if;

  update public.lead_submissions
     set status = 'promoted', lead_id = v_lead.id where id = v_submission.id;

  insert into public.lead_events (lead_id, client_id, kind, body)
  values (
    v_lead.id, v_endpoint.client_id, 'note',
    case when v_created then 'Captured from ' else 'Returned through ' end
      || replace(v_endpoint.purpose, '_', ' ')
      || '. Consent recorded.');

  return jsonb_build_object(
    'ok', true, 'submission_id', v_submission.id, 'lead_id', v_lead.id,
    'created', v_created, 'repeat', false);
end $$;

revoke all on function public.capture_lead_v6(
  text, text, text, text, text, text, boolean, jsonb, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.capture_lead_v6(
  text, text, text, text, text, text, boolean, jsonb, text, jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- What an operator sees
-- ---------------------------------------------------------------------------

-- Every endpoint and the one sentence saying why it is not taking anything.
-- The same discipline as publish_due and proof_placement_due: a form that
-- silently accepts nothing and a form that is deliberately off look
-- identical from a screen until this view exists.
create or replace view lead_capture_due with (security_invoker = true) as
select
  e.id as endpoint_id,
  e.client_id,
  e.purpose,
  e.campaign_id,
  e.page_id,
  e.enabled,
  e.expires_at,
  e.submissions,
  e.max_submissions,
  (select count(*) from public.lead_submissions s where s.endpoint_id = e.id) as received,
  (select count(*) from public.lead_submissions s
    where s.endpoint_id = e.id and s.status = 'promoted') as became_leads,
  case
    when e.revoked_at is not null then 'Revoked on ' || e.revoked_at::date::text || '.'
    when not e.enabled then 'Switched off. Nothing posted here is accepted.'
    when e.expires_at < now() then 'Expired on ' || e.expires_at::date::text || '.'
    when e.submissions >= e.max_submissions
      then 'Reached its limit of ' || e.max_submissions::text || ' submissions.'
    else null
  end as blocker
from public.lead_capture_endpoints e;

comment on view lead_capture_due is
  'Every capture endpoint and why it is not accepting anything. A null blocker means a stranger could create a lead here right now.';

grant select on lead_capture_due to authenticated;

select lock_down_definer_functions();

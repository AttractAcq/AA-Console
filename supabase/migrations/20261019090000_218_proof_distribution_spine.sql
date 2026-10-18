-- Proof Distribution: the spine. Nothing leaves the building.
--
-- The Proof Production Factory can clear a testimonial, record who gave
-- permission, turn it into a GEO answer and have a person sign off that the
-- claim is true. Then it stops. There is no record anywhere in this database
-- of a piece of proof being *present* somewhere — not on the website, not on
-- a Google Business Profile, not in a proposal. So "where is this testimonial
-- used" has no answer, and "this permission expired, what do we pull" has no
-- answer either. That second one is the expensive question.
--
-- This migration adds the missing noun (a placement), the list of places a
-- placement can be (data, not a CASE), the one sentence that says why a
-- placement has not happened, and the lifecycle that gets it from drafted to
-- verified. It adds no transport whatsoever. Every destination ships
-- `supported = false`, every client switch is off, and the claim function is
-- service_role only with nothing in the runtime calling it. Applying this
-- changes no client's public presence in any way.
--
-- FOUR MODES, NOT TEN ADAPTERS
--
-- The ten destinations in the Proof Production Factory playbook are not ten
-- integrations. They are four shapes:
--
--   api       we call an external API and own the lifecycle   (GBP, Meta)
--   embed     proof is bound into something another module publishes
--             (website, SEO/GEO content, campaign landing pages)
--   assisted  no write API exists; we render the payload, a person places it
--             (directories, proposals)
--   reference proof is released to a live system that cites it
--             (sales conversations, email/SMS nurture)
--
-- `mode` is on the destination rather than inferred, because the lifecycle
-- genuinely differs: an assisted placement is never claimed by a sweep, and
-- an embed placement is marked placed by the page pipeline rather than here.
--
-- TWO THINGS A HUMAN APPROVES, AND THEY ARE NOT THE SAME THING
--
-- Migration 209 already has `proof_artifact_signoffs`: a person saying the
-- claim is true and comes from the source. That is not permission to put it
-- on a client's Google Business Profile. The second decision -- this exact
-- content, at this exact destination -- is what `proof_placement_approvals`
-- records, and like migration 206 it names an exact version hash, so that
-- editing the payload after approval invalidates the approval rather than
-- silently shipping something nobody read.
--
-- RIGHTS ARE CHECKED AT PLACEMENT, NOT AT REQUEST
--
-- A placement approved in March must not go out in July with expired
-- permission. The blocker list in `proof_placement_due` re-checks clearance,
-- expiry and permission basis every time it is read, and migration 209's
-- `proof_rights_events` finally gets a consumer: rights coming off a proof
-- move every live placement of it to `retraction_required`.
--
-- WHAT THIS DELIBERATELY DOES NOT DO
--
-- It does not alter `proof_production_requests`. That table is being changed
-- on another branch right now, and the provenance link this module needs
-- (`proof_placements.production_request_id`) does not require touching it.
-- Reading the requested destination back off that table -- so the board can
-- show "produced for Google Business Profile, placed on Organic Social" --
-- is a later migration, after that work lands.
--
-- It also schedules nothing. The expiry sweep is defined and left unwired;
-- it gets a cron entry in the migration that brings up the first adapter,
-- because a schedule that has never run is not evidence that it works.

-- ---------------------------------------------------------------------------
-- The switch
-- ---------------------------------------------------------------------------

-- Separate from `publishing_enabled` on purpose, and this is not fussiness.
-- That flag means "the engine may post on this client's own social accounts".
-- Editing a client's Google Business Profile, or putting a customer's words
-- on their website, is a different promise to have made, and a client can
-- reasonably have said yes to one and not the other.
alter table client_engine_settings
  add column if not exists proof_publishing_enabled boolean not null default false,
  add column if not exists proof_publishing_enabled_at timestamptz,
  add column if not exists proof_publishing_enabled_by uuid references public.profiles(id) on delete set null;

comment on column client_engine_settings.proof_publishing_enabled is
  'Whether cleared proof may be placed at external destinations for this client. Off for every client until somebody turns it on for that client, and distinct from publishing_enabled: posting on a client''s feed and editing their business profile are different permissions.';

-- ---------------------------------------------------------------------------
-- The ten destinations, as data
-- ---------------------------------------------------------------------------

-- A table rather than a CASE in four places, for the reason migration 160
-- gives about platform_publishing: a destination with no adapter must be
-- visibly unsupported rather than silently never claimed. "Third Party
-- Directories has no adapter yet" and "proof quietly never reaches
-- directories" look identical from the outside until this row exists.
create table public.proof_destinations (
  destination_key text primary key check (destination_key in (
    'main_website', 'seo_geo_content', 'google_business_profile', 'organic_social',
    'paid_advertising', 'campaign_landing_page', 'sales_conversation',
    'email_sms_nurture', 'third_party_directory', 'proposal_quotation')),
  -- Byte-identical to PROOF_DESTINATIONS in src/lib/proofFactory.ts and to the
  -- p_destination check in request_proof_production_v2, so that a destination
  -- chosen at production time resolves to a key at distribution time. A test
  -- asserts the three lists agree.
  label text not null unique,
  mode text not null check (mode in ('api', 'embed', 'assisted', 'reference')),
  provider text,
  executor_module text not null,
  supported boolean not null default false,
  requires_integration boolean not null default false,
  note text not null
);

comment on table public.proof_destinations is
  'Where cleared proof can be placed, how that placement is performed, and whether anything can perform it yet. Data, so the board can say "no adapter" instead of staying silent.';

insert into public.proof_destinations
  (destination_key, label, mode, provider, executor_module, supported, requires_integration, note) values
  ('main_website', 'Main Website', 'embed', null, 'website_studio', false, false,
   'Bound into a page revision; the page pipeline publishes it. Blocked until migration 212''s exact-version executor exists.'),
  ('seo_geo_content', 'SEO / GEO Content', 'embed', null, 'website_studio', false, false,
   'What geo_answer and seo_case_study artifacts were made for. Same executor as the main website.'),
  ('google_business_profile', 'Google Business Profile', 'api', 'google_business', 'google_profile', false, true,
   'The one genuinely new adapter: posts, photos and review replies through the Business Profile API.'),
  ('organic_social', 'Organic Social Media', 'api', 'meta', 'content_distribution', false, false,
   'Already executes: a proof-derived asset goes out through scheduled_posts and the Meta adapters. Unsupported here until placements are recorded against those posts.'),
  ('paid_advertising', 'Paid Advertising', 'api', 'meta', 'meta_ads_studio', false, false,
   'Already executes through Meta Ads Studio. Unsupported here until placements are recorded against the ad creative.'),
  ('campaign_landing_page', 'Campaign Landing Pages', 'embed', null, 'website_studio', false, false,
   'Bound to the approved page revision a campaign deploys. Same block as the main website.'),
  ('sales_conversation', 'Sales Conversations', 'reference', null, 'sales_os', false, false,
   'The sales agent already refuses to cite uncleared proof. What is missing is which proof is released to it, and a record each time one is cited.'),
  ('email_sms_nurture', 'Email / SMS Nurturing', 'reference', null, 'sales_os', false, false,
   'A placement is the template version that carries the proof, not each send.'),
  ('third_party_directory', 'Third Party Directories', 'assisted', null, 'proof_distribution', false, false,
   'No write API exists for most directories. The payload is rendered here and a person places it.'),
  ('proposal_quotation', 'Proposals & Quotations', 'assisted', null, 'proof_distribution', false, false,
   'A proof pack rendered into the document a salesperson sends. The placement is the document version.')
on conflict (destination_key) do update
  set label = excluded.label, mode = excluded.mode, provider = excluded.provider,
      executor_module = excluded.executor_module, supported = excluded.supported,
      requires_integration = excluded.requires_integration, note = excluded.note;

alter table public.proof_destinations enable row level security;
create policy proof_destinations_read on public.proof_destinations
  for select to authenticated using (true);
grant select on public.proof_destinations to authenticated;
grant all on public.proof_destinations to service_role;

-- ---------------------------------------------------------------------------
-- Which destinations a client has agreed to
-- ---------------------------------------------------------------------------

create table public.client_proof_destinations (
  client_id uuid not null references public.clients(id) on delete cascade,
  destination_key text not null references public.proof_destinations(destination_key),
  enabled boolean not null default false,
  -- The client's own handle at that destination: a Business Profile location
  -- id, a directory profile URL. Never a credential; tokens stay in the Vault.
  account_ref text check (account_ref is null or length(btrim(account_ref)) between 1 and 500),
  enabled_at timestamptz,
  enabled_by uuid references public.profiles(id) on delete set null,
  primary key (client_id, destination_key)
);

comment on table public.client_proof_destinations is
  'Per client, per destination consent. The third of four switches: runtime flag, client flag, destination support, and this.';

alter table public.client_proof_destinations enable row level security;
create policy client_proof_destinations_read on public.client_proof_destinations
  for select to authenticated using (public.can_access_client(client_id));
create policy client_proof_destinations_write on public.client_proof_destinations
  for all to authenticated
  using (public.is_admin() or auth.uid() = public.active_video_approval_manager(client_id))
  with check (public.is_admin() or auth.uid() = public.active_video_approval_manager(client_id));
grant select, insert, update, delete on public.client_proof_destinations to authenticated;
grant all on public.client_proof_destinations to service_role;

-- ---------------------------------------------------------------------------
-- The placement
-- ---------------------------------------------------------------------------

create table public.proof_placements (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  destination_key text not null references public.proof_destinations(destination_key),

  -- Exactly one payload, the campaign_artifacts rule: a row pointing at two
  -- things, or at none, is a row nobody can act on.
  artifact_version_id uuid references public.proof_artifact_versions(id) on delete restrict,
  proof_id uuid references public.client_proof_assets(id) on delete restrict,
  asset_id uuid references public.client_media_assets(id) on delete restrict,
  constraint proof_placement_one_payload
    check (num_nonnulls(artifact_version_id, proof_id, asset_id) = 1),

  -- The proof everything above ultimately rests on, resolved once and stored.
  -- Denormalised deliberately: this column is what makes "this permission
  -- expired, what is live" a single indexed query, which is the entire reason
  -- this table exists.
  source_proof_id uuid not null references public.client_proof_assets(id) on delete restrict,

  production_request_id uuid references public.proof_production_requests(id) on delete set null,
  campaign_id uuid references public.client_campaigns(id) on delete set null,

  -- The exact version that was approved. Migration 206's discipline: an
  -- approval names a hash, and a payload that no longer hashes to it is a
  -- different thing that nobody approved.
  payload_hash text not null check (payload_hash ~ '^[0-9a-f]{64}$'),
  approval_id uuid,

  status text not null default 'drafted' check (status in (
    'drafted', 'awaiting_approval', 'approved', 'queued', 'placing',
    'awaiting_manual_placement', 'bound', 'placed', 'verified',
    'failed', 'rejected', 'retraction_required', 'retracted')),

  external_id text,
  external_url text,
  -- Mode embed: which page revision carries this proof, and its hash.
  bound_revision_id uuid references public.client_page_revisions(id) on delete restrict,
  bound_version_hash text,
  -- Mode assisted: who actually did it.
  placed_by uuid references public.profiles(id) on delete set null,

  attempts integer not null default 0,
  claimed_at timestamptz,
  lease_until timestamptz,
  placed_at timestamptz,
  verified_at timestamptz,
  retracted_at timestamptz,
  last_error text,

  idempotency_key text not null check (length(btrim(idempotency_key)) between 1 and 160),
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (client_id, idempotency_key),
  unique (id, client_id)
);

comment on table public.proof_placements is
  'One cleared piece of proof, present (or due to be present) at one destination. The record that makes "where is this used" and "what do we pull when permission ends" answerable.';

create index proof_placements_rights_idx
  on public.proof_placements (source_proof_id, status);
create index proof_placements_client_idx
  on public.proof_placements (client_id, destination_key, created_at desc);

-- ---------------------------------------------------------------------------
-- Which moves are legal
-- ---------------------------------------------------------------------------

-- Data, like slot_transitions in migration 147, so the lifecycle can be read
-- and rendered rather than transcribed into a function and then into a
-- comment and then into a panel. The move this table exists to forbid is
-- drafted -> placed: placing without the approval step in between.
create table public.proof_placement_transitions (
  from_status text not null,
  to_status text not null,
  note text,
  primary key (from_status, to_status)
);

insert into public.proof_placement_transitions (from_status, to_status, note) values
  ('drafted',                   'awaiting_approval',         'Sent for the placement decision.'),
  ('drafted',                   'rejected',                  'Abandoned before anyone looked.'),
  ('awaiting_approval',         'approved',                  'A person approved this payload for this destination.'),
  ('awaiting_approval',         'rejected',                  'A person said no.'),
  ('approved',                  'queued',                    'An api destination: waiting for the sweep.'),
  ('approved',                  'awaiting_manual_placement', 'An assisted destination: waiting for a person.'),
  ('approved',                  'bound',                     'An embed destination: attached to a page revision.'),
  ('queued',                    'placing',                   'Claimed by the sweep.'),
  ('placing',                   'placed',                    'It is out there.'),
  ('placing',                   'failed',                    'The attempt failed. last_error says how.'),
  ('awaiting_manual_placement', 'placed',                    'A person placed it and recorded where.'),
  ('bound',                     'placed',                    'The page carrying it was published.'),
  ('failed',                    'queued',                    'Being tried again.'),
  ('failed',                    'rejected',                  'Abandoned after failing.'),
  ('placed',                    'verified',                  'Somebody confirmed it is really there.'),
  -- A client asking for something to come down is not a rights event, and
  -- making them wait for one would be a strange way to honour the request.
  ('placed',                    'retracted',                 'Taken down by request.'),
  ('verified',                  'retracted',                 'Taken down by request.'),
  ('placed',                    'retraction_required',       'Permission ended while it was live.'),
  ('verified',                  'retraction_required',       'Permission ended while it was live.'),
  ('approved',                  'retraction_required',       'Permission ended before it went out.'),
  ('queued',                    'retraction_required',       'Permission ended before it went out.'),
  ('awaiting_manual_placement', 'retraction_required',       'Permission ended before it went out.'),
  ('bound',                     'retraction_required',       'Permission ended before the page shipped.'),
  ('retraction_required',       'retracted',                 'It has been taken down.')
on conflict (from_status, to_status) do nothing;

create function public.guard_proof_placement_status()
returns trigger language plpgsql
set search_path = pg_catalog, public as $$
begin
  if new.client_id <> old.client_id then
    raise exception 'A placement cannot move between clients.';
  end if;
  if new.destination_key <> old.destination_key then
    raise exception 'A placement cannot change destination. Draft a new one.';
  end if;
  if new.status is distinct from old.status
     and not exists (select 1 from public.proof_placement_transitions t
                     where t.from_status = old.status and t.to_status = new.status) then
    raise exception 'A placement cannot go from % to %.', old.status, new.status;
  end if;
  -- An approved payload that changes is a different payload. Rather than
  -- letting it ship under the old decision, the approval is dropped and the
  -- placement goes back for one.
  if new.payload_hash is distinct from old.payload_hash and old.status <> 'drafted' then
    raise exception 'This payload is already under review. Draft a new placement for a new version.';
  end if;
  new.updated_at := now();
  return new;
end $$;

create trigger proof_placement_status_guard before update on public.proof_placements
  for each row execute function public.guard_proof_placement_status();

alter table public.proof_placement_transitions enable row level security;
create policy proof_placement_transitions_read on public.proof_placement_transitions
  for select to authenticated using (true);
grant select on public.proof_placement_transitions to authenticated;
grant all on public.proof_placement_transitions to service_role;

alter table public.proof_placements enable row level security;
create policy proof_placements_read on public.proof_placements
  for select to authenticated using (public.can_access_client(client_id));
grant select on public.proof_placements to authenticated;
grant all on public.proof_placements to service_role;

-- ---------------------------------------------------------------------------
-- The second human decision
-- ---------------------------------------------------------------------------

-- Shaped like campaign_action_approvals (migration 206) and deliberately not
-- that table: a placement is continuous work, not campaign work. An evergreen
-- testimonial on a website belongs to no campaign and has no manifest, and
-- request_campaign_action_approval_v6 rejects anything whose package has been
-- superseded -- correct for a campaign launch, wrong for a review that has
-- been on a profile for a year.
--
-- `campaign_action_approval_id` is the bridge for placements that ARE part of
-- a campaign: migration 206 already reserves action_key 'proof_publish' for
-- exactly this, and the manifest already marks proof_distribution required.
-- It is nullable and unused until that executor exists.
create table public.proof_placement_approvals (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  placement_id uuid not null references public.proof_placements(id) on delete cascade,
  destination_key text not null references public.proof_destinations(destination_key),
  payload_hash text not null check (payload_hash ~ '^[0-9a-f]{64}$'),
  scope jsonb not null check (jsonb_typeof(scope) = 'object'),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  campaign_action_approval_id uuid references public.campaign_action_approvals(id) on delete set null,
  requested_at timestamptz not null default now(),
  requested_by uuid references public.profiles(id) on delete set null,
  decided_at timestamptz,
  decided_by uuid references public.profiles(id) on delete set null,
  rejection_reason text,
  check (
    (status = 'pending' and decided_at is null and decided_by is null and rejection_reason is null)
    or (status = 'approved' and decided_at is not null and decided_by is not null and rejection_reason is null)
    or (status = 'rejected' and decided_at is not null and decided_by is not null
        and nullif(btrim(rejection_reason), '') is not null)
  )
);

-- One live decision per placement. A second pending request for the same
-- placement is two people being asked the same question.
create unique index proof_placement_approval_pending_idx
  on public.proof_placement_approvals (placement_id) where status = 'pending';

alter table public.proof_placements
  add constraint proof_placement_approval_fk
  foreign key (approval_id) references public.proof_placement_approvals(id) on delete set null;

alter table public.proof_placement_approvals enable row level security;
create policy proof_placement_approvals_read on public.proof_placement_approvals
  for select to authenticated using (public.can_access_client(client_id));
grant select on public.proof_placement_approvals to authenticated;
grant all on public.proof_placement_approvals to service_role;

-- ---------------------------------------------------------------------------
-- What happened, in order
-- ---------------------------------------------------------------------------

create table public.proof_placement_events (
  id uuid primary key default gen_random_uuid(),
  placement_id uuid not null references public.proof_placements(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  event text not null check (event in (
    'drafted', 'requested', 'approved', 'rejected', 'queued', 'claimed', 'placed',
    'verified', 'cited', 'failed', 'retraction_required', 'retracted')),
  actor text not null check (actor in ('human', 'agent', 'system')),
  detail text,
  external_ref text,
  occurred_at timestamptz not null default now()
);

comment on column public.proof_placement_events.event is
  'Append-only. ''cited'' is what makes a reference destination work: the sales agent quoting a proof writes an event against the existing placement rather than creating a new one. One placement, many citations.';

create index proof_placement_events_idx
  on public.proof_placement_events (placement_id, occurred_at desc);

create function public.guard_proof_placement_event_append_only()
returns trigger language plpgsql as $$
begin
  raise exception 'Placement events are a record of what happened. They are not edited.';
end $$;

create trigger proof_placement_events_append_only
  before update or delete on public.proof_placement_events
  for each row execute function public.guard_proof_placement_event_append_only();

alter table public.proof_placement_events enable row level security;
create policy proof_placement_events_read on public.proof_placement_events
  for select to authenticated using (public.can_access_client(client_id));
grant select on public.proof_placement_events to authenticated;
grant all on public.proof_placement_events to service_role;

-- ---------------------------------------------------------------------------
-- The hash
-- ---------------------------------------------------------------------------

-- What "this exact version" means for each payload shape. An artifact hashes
-- its content, because that is the thing being published. A raw proof or a
-- produced asset hashes the identity plus the words that would carry it, so
-- that re-clearing a proof with different evidence text invalidates a
-- placement approved against the old wording.
create function public.proof_placement_payload_hash_v6(
  p_artifact_version_id uuid, p_proof_id uuid, p_asset_id uuid, p_destination_key text)
returns text language sql stable set search_path = pg_catalog, public as $$
  select encode(sha256(convert_to(coalesce(
    (select v.content_hash || ':' || v.supported_claim
       from public.proof_artifact_versions v where v.id = p_artifact_version_id),
    (select p.id::text || ':' || coalesce(p.claim, '') || ':' || coalesce(p.evidence, p.body, '')
       from public.client_proof_assets p where p.id = p_proof_id),
    (select a.id::text || ':' || coalesce(a.render_path, a.storage_path, '')
       from public.client_media_assets a where a.id = p_asset_id)
  ) || '@' || p_destination_key, 'UTF8')), 'hex');
$$;

-- ---------------------------------------------------------------------------
-- Drafting a placement
-- ---------------------------------------------------------------------------

create function public.create_proof_placement_v6(
  p_idempotency_key text,
  p_client_id uuid,
  p_destination_key text,
  p_artifact_version_id uuid default null,
  p_proof_id uuid default null,
  p_asset_id uuid default null,
  p_production_request_id uuid default null,
  p_campaign_id uuid default null
) returns uuid language plpgsql security definer
set search_path = pg_catalog, public as $$
declare
  v_source uuid;
  v_proof public.client_proof_assets%rowtype;
  v_existing public.proof_placements%rowtype;
  v_hash text;
  v_id uuid;
begin
  if auth.role() is distinct from 'authenticated'
     or not (coalesce(public.is_admin(), false)
             or coalesce(auth.uid() = public.active_video_approval_manager(p_client_id), false)) then
    raise exception 'Only an admin or assigned client manager can place proof.';
  end if;
  if p_idempotency_key is null or length(btrim(p_idempotency_key)) not between 1 and 160 then
    raise exception 'An idempotency key is required.';
  end if;
  if num_nonnulls(p_artifact_version_id, p_proof_id, p_asset_id) <> 1 then
    raise exception 'Choose exactly one thing to place.';
  end if;
  if not exists (select 1 from public.proof_destinations where destination_key = p_destination_key) then
    raise exception 'Choose a known destination.';
  end if;

  -- Resolve what this ultimately rests on, and refuse anything that does not
  -- belong to this client. A placement that cites another client's proof is
  -- the worst bug this module could have.
  select coalesce(
    (select v.source_proof_id from public.proof_artifact_versions v
      where v.id = p_artifact_version_id and v.client_id = p_client_id),
    (select p.id from public.client_proof_assets p
      where p.id = p_proof_id and p.client_id = p_client_id),
    (select b.proof_asset_id from public.client_media_assets a
       join public.client_briefs b on b.id = a.brief_id and b.client_id = a.client_id
      where a.id = p_asset_id and a.client_id = p_client_id))
    into v_source;
  if v_source is null then
    raise exception 'That payload does not belong to this client, or carries no proof source.';
  end if;

  select * into v_proof from public.client_proof_assets where id = v_source;
  if v_proof.usage_rights <> 'approved'
     or (v_proof.expires_on is not null and v_proof.expires_on < current_date)
     or nullif(btrim(v_proof.permission_basis), '') is null then
    raise exception 'Clear this proof and record permission before placing it.';
  end if;

  -- A produced asset nobody approved is not ready to be anywhere public.
  if p_asset_id is not null and not exists (
    select 1 from public.client_media_assets a
     where a.id = p_asset_id and a.review_status = 'approved' and a.human_approved_at is not null) then
    raise exception 'That asset has not been approved by a person yet.';
  end if;

  v_hash := public.proof_placement_payload_hash_v6(
    p_artifact_version_id, p_proof_id, p_asset_id, p_destination_key);

  perform pg_advisory_xact_lock(hashtextextended(p_client_id::text || ':' || btrim(p_idempotency_key), 0));
  select * into v_existing from public.proof_placements
   where client_id = p_client_id and idempotency_key = btrim(p_idempotency_key);
  if found then
    if v_existing.destination_key <> p_destination_key or v_existing.payload_hash <> v_hash then
      raise exception 'Idempotency key already belongs to a different placement.';
    end if;
    return v_existing.id;
  end if;

  insert into public.proof_placements (
    client_id, destination_key, artifact_version_id, proof_id, asset_id, source_proof_id,
    production_request_id, campaign_id, payload_hash, idempotency_key, created_by)
  values (
    p_client_id, p_destination_key, p_artifact_version_id, p_proof_id, p_asset_id, v_source,
    p_production_request_id, p_campaign_id, v_hash, btrim(p_idempotency_key), auth.uid())
  returning id into v_id;

  insert into public.proof_placement_events (placement_id, client_id, event, actor, detail)
  values (v_id, p_client_id, 'drafted', 'human', 'Drafted for ' || p_destination_key || '.');
  return v_id;
end $$;

revoke all on function public.create_proof_placement_v6(text, uuid, text, uuid, uuid, uuid, uuid, uuid)
  from public, anon;
grant execute on function public.create_proof_placement_v6(text, uuid, text, uuid, uuid, uuid, uuid, uuid)
  to authenticated;

-- ---------------------------------------------------------------------------
-- Asking, and deciding
-- ---------------------------------------------------------------------------

create function public.request_proof_placement_approval_v6(p_placement_id uuid, p_scope jsonb default '{}'::jsonb)
returns uuid language plpgsql security definer
set search_path = pg_catalog, public as $$
declare
  v_placement public.proof_placements%rowtype;
  v_id uuid;
begin
  select * into v_placement from public.proof_placements where id = p_placement_id for update;
  if not found then raise exception 'No such placement.'; end if;
  if auth.role() is distinct from 'authenticated'
     or not (coalesce(public.is_admin(), false)
             or coalesce(auth.uid() = public.active_video_approval_manager(v_placement.client_id), false)) then
    raise exception 'Only an admin or assigned client manager can place proof.';
  end if;
  if v_placement.status <> 'drafted' then
    raise exception 'That placement is %, not a draft.', v_placement.status;
  end if;
  -- The artifact's own claim sign-off (migration 209) is a precondition for
  -- the placement decision, not a substitute for it.
  if v_placement.artifact_version_id is not null and not exists (
    select 1 from public.proof_artifact_signoffs s
     where s.artifact_version_id = v_placement.artifact_version_id) then
    raise exception 'Approve the artifact''s source and claim before asking to place it.';
  end if;

  insert into public.proof_placement_approvals (
    client_id, placement_id, destination_key, payload_hash, scope, requested_by)
  values (
    v_placement.client_id, p_placement_id, v_placement.destination_key,
    v_placement.payload_hash,
    coalesce(p_scope, '{}'::jsonb) || jsonb_build_object(
      'destination_key', v_placement.destination_key,
      'source_proof_id', v_placement.source_proof_id),
    auth.uid())
  returning id into v_id;

  update public.proof_placements
     set status = 'awaiting_approval', approval_id = v_id
   where id = p_placement_id;
  insert into public.proof_placement_events (placement_id, client_id, event, actor)
  values (p_placement_id, v_placement.client_id, 'requested', 'human');
  return v_id;
end $$;

revoke all on function public.request_proof_placement_approval_v6(uuid, jsonb) from public, anon;
grant execute on function public.request_proof_placement_approval_v6(uuid, jsonb) to authenticated;

create function public.decide_proof_placement_approval_v6(
  p_approval_id uuid, p_approved boolean, p_reason text default null)
returns public.proof_placements language plpgsql security definer
set search_path = pg_catalog, public as $$
declare
  v_approval public.proof_placement_approvals%rowtype;
  v_placement public.proof_placements%rowtype;
  v_mode text;
  v_next text;
begin
  select * into v_approval from public.proof_placement_approvals where id = p_approval_id for update;
  if not found then raise exception 'No such approval.'; end if;
  if auth.role() is distinct from 'authenticated'
     or not (coalesce(public.is_admin(), false)
             or coalesce(auth.uid() = public.active_video_approval_manager(v_approval.client_id), false)) then
    raise exception 'Only an admin or assigned client manager can decide a placement.';
  end if;
  if v_approval.status <> 'pending' then
    raise exception 'That approval was already %.', v_approval.status;
  end if;
  select * into v_placement from public.proof_placements where id = v_approval.placement_id for update;
  -- The payload moved between asking and deciding. Approving now would sign
  -- off something nobody read.
  if v_placement.payload_hash <> v_approval.payload_hash then
    raise exception 'This payload changed after approval was requested. Ask again.';
  end if;

  if not p_approved then
    if nullif(btrim(p_reason), '') is null then raise exception 'Say why it was rejected.'; end if;
    update public.proof_placement_approvals
       set status = 'rejected', decided_at = now(), decided_by = auth.uid(), rejection_reason = btrim(p_reason)
     where id = p_approval_id;
    update public.proof_placements set status = 'rejected' where id = v_placement.id;
    insert into public.proof_placement_events (placement_id, client_id, event, actor, detail)
    values (v_placement.id, v_placement.client_id, 'rejected', 'human', btrim(p_reason));
    select * into v_placement from public.proof_placements where id = v_placement.id;
    return v_placement;
  end if;

  update public.proof_placement_approvals
     set status = 'approved', decided_at = now(), decided_by = auth.uid()
   where id = p_approval_id;
  update public.proof_placements set status = 'approved' where id = v_placement.id;
  insert into public.proof_placement_events (placement_id, client_id, event, actor)
  values (v_placement.id, v_placement.client_id, 'approved', 'human');

  -- Where it waits next depends on who performs the act. An assisted
  -- destination has no sweep to wait for; an embed one waits for a page.
  select mode into v_mode from public.proof_destinations where destination_key = v_placement.destination_key;
  v_next := case v_mode
              when 'api' then 'queued'
              when 'reference' then 'queued'
              when 'assisted' then 'awaiting_manual_placement'
              else 'bound' end;
  update public.proof_placements set status = v_next where id = v_placement.id;
  if v_next = 'queued' then
    insert into public.proof_placement_events (placement_id, client_id, event, actor)
    values (v_placement.id, v_placement.client_id, 'queued', 'system');
  end if;

  select * into v_placement from public.proof_placements where id = v_placement.id;
  return v_placement;
end $$;

revoke all on function public.decide_proof_placement_approval_v6(uuid, boolean, text) from public, anon;
grant execute on function public.decide_proof_placement_approval_v6(uuid, boolean, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Why nothing has gone out
-- ---------------------------------------------------------------------------

-- publish_due, for proof. One sentence per placement, and a null blocker
-- means it would be acted on next. The order of the cases is the order a
-- person should hear them: facts about the proof first, because those are
-- the ones that make the placement wrong rather than merely waiting.
create or replace view proof_placement_due with (security_invoker = true) as
select
  pl.id as placement_id,
  pl.client_id,
  pl.destination_key,
  d.label as destination_label,
  d.mode,
  pl.status,
  pl.attempts,
  pl.payload_hash,
  pl.source_proof_id,
  p.title as source_title,
  p.expires_on,
  case
    when p.id is null
      then 'The source proof is gone. This placement can never be made.'
    when p.usage_rights <> 'approved'
      then 'The source proof is not cleared for use.'
    when p.expires_on is not null and p.expires_on < current_date
      then 'Permission for this proof expired on ' || p.expires_on::text || '.'
    when nullif(btrim(p.permission_basis), '') is null
      then 'No permission basis is recorded for the source proof.'
    when pl.artifact_version_id is not null and not exists (
      select 1 from public.proof_artifact_signoffs s
       where s.artifact_version_id = pl.artifact_version_id)
      then 'Nobody has approved this artifact''s source and claim.'
    when d.supported is not true
      then 'There is no adapter for ' || d.label || '.'
    when not coalesce(cpd.enabled, false)
      then d.label || ' is not switched on for this client.'
    when d.requires_integration and not public.integration_usable(pl.client_id, d.provider)
      then 'No usable ' || d.provider || ' integration for this client.'
    when not coalesce(ces.proof_publishing_enabled, false)
      then 'Proof distribution is off for this client.'
    when pl.approval_id is null
      then 'Nobody has approved this placement.'
    when a.status <> 'approved'
      then 'The placement approval is ' || a.status || '.'
    when a.payload_hash <> pl.payload_hash
      then 'The approved version is not the current one. Ask for approval again.'
    when d.mode <> 'api'
      then 'This destination is placed by ' || d.executor_module || ', not by the sweep.'
    else null
  end as blocker
from public.proof_placements pl
join public.proof_destinations d on d.destination_key = pl.destination_key
left join public.client_proof_assets p on p.id = pl.source_proof_id
left join public.client_proof_destinations cpd
  on cpd.client_id = pl.client_id and cpd.destination_key = pl.destination_key
left join public.client_engine_settings ces on ces.client_id = pl.client_id
left join public.proof_placement_approvals a on a.id = pl.approval_id
where pl.status in ('approved', 'queued', 'placing', 'awaiting_manual_placement', 'bound');

comment on view proof_placement_due is
  'What proof distribution may act on, and for everything else the one sentence saying why not. A null blocker means the sweep would take it next.';

grant select on proof_placement_due to authenticated;

-- ---------------------------------------------------------------------------
-- Claiming, recording, failing
-- ---------------------------------------------------------------------------

-- Nothing calls this. It exists so the spine is complete and testable before
-- any adapter is written, and so the first adapter is a transport and not a
-- transport plus a lifecycle.
create function public.claim_proof_placements(p_limit integer default 5)
returns table (
  placement_id uuid, client_id uuid, destination_key text, provider text,
  artifact_version_id uuid, proof_id uuid, asset_id uuid,
  payload_hash text, account_ref text, attempt integer)
language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  if auth.role() <> 'service_role' then
    raise exception 'Only the internal service may claim placements.';
  end if;
  return query
  -- The lock is taken on the table rather than through the view: the view is
  -- a join and cannot be locked, and the rows worth locking are the ones the
  -- view has already said are unblocked.
  with ready as (
    select pl.id as placement_id from public.proof_placements pl
     where pl.status = 'queued'
       and pl.id in (select d.placement_id from public.proof_placement_due d where d.blocker is null)
     order by pl.created_at
     limit greatest(coalesce(p_limit, 5), 1)
     for update skip locked
  ), claimed as (
    update public.proof_placements pl
       set status = 'placing', claimed_at = now(),
           lease_until = now() + interval '15 minutes', attempts = pl.attempts + 1
     where pl.id in (select r.placement_id from ready r)
     returning pl.*
  )
  select c.id, c.client_id, c.destination_key, d.provider,
         c.artifact_version_id, c.proof_id, c.asset_id, c.payload_hash,
         cpd.account_ref, c.attempts
    from claimed c
    join public.proof_destinations d on d.destination_key = c.destination_key
    left join public.client_proof_destinations cpd
      on cpd.client_id = c.client_id and cpd.destination_key = c.destination_key;
end $$;

revoke all on function public.claim_proof_placements(integer) from public, anon, authenticated;
grant execute on function public.claim_proof_placements(integer) to service_role;

create function public.record_proof_placed(
  p_placement_id uuid, p_external_id text, p_external_url text default null)
returns void language plpgsql security definer set search_path = pg_catalog, public as $$
declare v public.proof_placements%rowtype;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Only the internal service may record a placement.';
  end if;
  update public.proof_placements
     set status = 'placed', external_id = p_external_id, external_url = p_external_url,
         placed_at = now(), lease_until = null, last_error = null
   where id = p_placement_id and status = 'placing'
   returning * into v;
  if not found then raise exception 'That placement is not being placed.'; end if;
  insert into public.proof_placement_events (placement_id, client_id, event, actor, external_ref)
  values (p_placement_id, v.client_id, 'placed', 'agent', coalesce(p_external_url, p_external_id));
end $$;

revoke all on function public.record_proof_placed(uuid, text, text) from public, anon, authenticated;
grant execute on function public.record_proof_placed(uuid, text, text) to service_role;

-- A failure that did not obviously fail stays failed. Migration 160's
-- reasoning applies with more force here: a retried review reply posts twice
-- on a client's public profile, and there is no unsending it.
create function public.record_proof_placement_failure(
  p_placement_id uuid, p_reason text, p_retryable boolean default false)
returns void language plpgsql security definer set search_path = pg_catalog, public as $$
declare v public.proof_placements%rowtype;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Only the internal service may record a failure.';
  end if;
  update public.proof_placements
     set status = 'failed', last_error = p_reason, lease_until = null
   where id = p_placement_id and status = 'placing'
   returning * into v;
  if not found then raise exception 'That placement is not being placed.'; end if;
  insert into public.proof_placement_events (placement_id, client_id, event, actor, detail)
  values (p_placement_id, v.client_id, 'failed', 'agent', p_reason);
  if coalesce(p_retryable, false) then
    update public.proof_placements set status = 'queued' where id = p_placement_id;
    insert into public.proof_placement_events (placement_id, client_id, event, actor)
    values (p_placement_id, v.client_id, 'queued', 'system');
  end if;
end $$;

revoke all on function public.record_proof_placement_failure(uuid, text, boolean) from public, anon, authenticated;
grant execute on function public.record_proof_placement_failure(uuid, text, boolean) to service_role;

-- ---------------------------------------------------------------------------
-- The destinations a person performs
-- ---------------------------------------------------------------------------

-- An assisted destination has no adapter and never will. The system renders
-- the payload, a person puts it where it goes, and this is them saying so.
-- The URL is required: a placement nobody can go and look at is not a record
-- of anything, and in a year's time it is the only way to retract.
create function public.mark_proof_placement_placed_v6(p_placement_id uuid, p_external_url text)
returns void language plpgsql security definer set search_path = pg_catalog, public as $$
declare v public.proof_placements%rowtype; v_mode text;
begin
  select * into v from public.proof_placements where id = p_placement_id for update;
  if not found then raise exception 'No such placement.'; end if;
  if auth.role() is distinct from 'authenticated'
     or not (coalesce(public.is_admin(), false)
             or coalesce(auth.uid() = public.active_video_approval_manager(v.client_id), false)) then
    raise exception 'Only an admin or assigned client manager can record a placement.';
  end if;
  select mode into v_mode from public.proof_destinations where destination_key = v.destination_key;
  if v_mode <> 'assisted' then
    raise exception 'Only an assisted destination is placed by hand.';
  end if;
  if v.status <> 'awaiting_manual_placement' then
    raise exception 'That placement is %, not waiting for a person.', v.status;
  end if;
  if p_external_url is null or p_external_url !~ '^https?://' then
    raise exception 'Record the URL where it was placed.';
  end if;
  update public.proof_placements
     set status = 'placed', external_url = p_external_url, placed_at = now(), placed_by = auth.uid()
   where id = p_placement_id;
  insert into public.proof_placement_events (placement_id, client_id, event, actor, external_ref)
  values (p_placement_id, v.client_id, 'placed', 'human', p_external_url);
end $$;

revoke all on function public.mark_proof_placement_placed_v6(uuid, text) from public, anon;
grant execute on function public.mark_proof_placement_placed_v6(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Rights ending, and what that means for what is already out there
-- ---------------------------------------------------------------------------

-- Migration 209 records every rights change in proof_rights_events and
-- nothing has ever read them. This is the consumer: permission coming off a
-- proof is not a filing change, it is a list of things to take down.
create function public.flag_proof_placements_for_retraction_v6()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public as $$
begin
  if new.usage_rights = 'approved'
     and (new.expires_on is null or new.expires_on >= current_date)
     and nullif(btrim(new.permission_basis), '') is not null then
    return new;
  end if;
  with flagged as (
    update public.proof_placements
       set status = 'retraction_required'
     where source_proof_id = new.id
       and status in ('approved', 'queued', 'awaiting_manual_placement', 'bound', 'placed', 'verified')
     returning id, client_id)
  insert into public.proof_placement_events (placement_id, client_id, event, actor, detail)
  select f.id, f.client_id, 'retraction_required', 'system',
         'Permission for the source proof ended.'
    from flagged f;
  return new;
end $$;

create trigger proof_rights_retraction after update of usage_rights, expires_on, permission_basis
  on public.client_proof_assets
  for each row execute function public.flag_proof_placements_for_retraction_v6();

-- Expiry by the calendar writes no row, so a date passing needs a sweep.
-- Deliberately not scheduled here: it gets its cron entry in the migration
-- that brings up the first adapter, because a schedule that has never run is
-- not evidence that it works.
create function public.sweep_expired_proof_placements()
returns integer language plpgsql security definer
set search_path = pg_catalog, public as $$
declare v_count integer;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Only the internal service may sweep placements.';
  end if;
  with flagged as (
    update public.proof_placements pl
       set status = 'retraction_required'
      from public.client_proof_assets p
     where p.id = pl.source_proof_id
       and p.expires_on is not null and p.expires_on < current_date
       and pl.status in ('approved', 'queued', 'awaiting_manual_placement', 'bound', 'placed', 'verified')
     returning pl.id, pl.client_id)
  insert into public.proof_placement_events (placement_id, client_id, event, actor, detail)
  select f.id, f.client_id, 'retraction_required', 'system', 'Permission expired.'
    from flagged f;
  get diagnostics v_count = row_count;
  return v_count;
end $$;

revoke all on function public.sweep_expired_proof_placements() from public, anon, authenticated;
grant execute on function public.sweep_expired_proof_placements() to service_role;

create function public.record_proof_retracted_v6(p_placement_id uuid, p_detail text default null)
returns void language plpgsql security definer set search_path = pg_catalog, public as $$
declare v public.proof_placements%rowtype;
begin
  select * into v from public.proof_placements where id = p_placement_id for update;
  if not found then raise exception 'No such placement.'; end if;
  if auth.role() is distinct from 'service_role'
     and not (coalesce(public.is_admin(), false)
              or coalesce(auth.uid() = public.active_video_approval_manager(v.client_id), false)) then
    raise exception 'Only an admin, assigned client manager or the internal service may retract.';
  end if;
  update public.proof_placements
     set status = 'retracted', retracted_at = now() where id = p_placement_id;
  insert into public.proof_placement_events (placement_id, client_id, event, actor, detail)
  values (p_placement_id, v.client_id, 'retracted',
          case when auth.role() = 'service_role' then 'agent' else 'human' end, p_detail);
end $$;

revoke all on function public.record_proof_retracted_v6(uuid, text) from public, anon;
grant execute on function public.record_proof_retracted_v6(uuid, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- The sweep that Supabase's default grants make necessary
-- ---------------------------------------------------------------------------

-- `revoke all on function x from public` above removes the PUBLIC pseudo-role
-- grant and leaves Supabase's grants to anon, authenticated and service_role
-- exactly where they were. Migration 161 exists because of that, and every
-- migration adding a SECURITY DEFINER function has to end here.
select lock_down_definer_functions();

-- The thing the opt-in promised.
--
-- Migration 235 lets a stranger become a consented, attributed lead. This is
-- the other half of the bargain: they were told they would get something, and
-- exactly one copy of exactly the file somebody approved has to reach them.
--
-- THREE THINGS THAT LOOK LIKE ONE
--
-- A magnet (what we offer), a version of it (the actual bytes), and a
-- delivery (one send to one person). Collapsing any two of them breaks
-- something real: re-exporting the PDF after approval has to invalidate the
-- approval, and a retry after a provider timeout must not send twice.
--
-- THE GATE IS ON THE VERSION, NOT THE SEND
--
-- Proof placements approve one payload at one destination; campaign actions
-- approve one package. A magnet is neither: nobody can approve forty
-- individual emails, and nobody should have to. What a person approves is
-- this file, going out by this route, to whoever opts in — the hash of the
-- bytes and the delivery path together. Each send then checks that the
-- approval still matches the file before it goes, so re-exporting the PDF
-- stops the queue rather than quietly sending a different document.
--
-- FOUR SWITCHES, AS EVERYWHERE ELSE
--
--   1. LEAD_MAGNET_DELIVERY_ENABLED in the runtime
--   2. client_engine_settings.lead_magnet_delivery_enabled
--   3. the capture endpoint being enabled at all (235)
--   4. the human approval of this version and path
--
-- Applying this sends nothing: every switch is off, no magnet exists, and no
-- endpoint has a version bound to it.

alter table client_engine_settings
  add column if not exists lead_magnet_delivery_enabled boolean not null default false,
  add column if not exists lead_magnet_delivery_enabled_at timestamptz,
  add column if not exists lead_magnet_delivery_enabled_by uuid
    references public.profiles(id) on delete set null;

comment on column client_engine_settings.lead_magnet_delivery_enabled is
  'Whether approved lead magnets may actually be sent for this client. Off until somebody turns it on, and distinct from the other three delivery switches: emailing a stranger a file is its own promise.';

create or replace function public.set_lead_magnet_delivery_enabled(
  p_client_id uuid, p_enabled boolean)
returns client_engine_settings
language plpgsql security definer
set search_path to 'public' as $$
declare v_row client_engine_settings;
begin
  if not can_access_client(p_client_id) then
    raise exception 'Not permitted for this client' using errcode = 'P0001';
  end if;
  if not (coalesce(public.is_admin(), false)
          or coalesce(auth.uid() = public.active_video_approval_manager(p_client_id), false)) then
    raise exception 'Only an admin or the active client manager may change this.'
      using errcode = 'P0001';
  end if;
  insert into client_engine_settings (client_id, lead_magnet_delivery_enabled,
    lead_magnet_delivery_enabled_at, lead_magnet_delivery_enabled_by)
  values (p_client_id, p_enabled, case when p_enabled then now() end,
          case when p_enabled then auth.uid() end)
  on conflict (client_id) do update
    set lead_magnet_delivery_enabled = excluded.lead_magnet_delivery_enabled,
        lead_magnet_delivery_enabled_at = case when excluded.lead_magnet_delivery_enabled
          then now() else client_engine_settings.lead_magnet_delivery_enabled_at end,
        lead_magnet_delivery_enabled_by = case when excluded.lead_magnet_delivery_enabled
          then auth.uid() else client_engine_settings.lead_magnet_delivery_enabled_by end
  returning * into v_row;
  return v_row;
end $$;

revoke all on function public.set_lead_magnet_delivery_enabled(uuid, boolean) from public, anon;
grant execute on function public.set_lead_magnet_delivery_enabled(uuid, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- The magnet
-- ---------------------------------------------------------------------------

create table public.lead_magnets (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 200),

  -- Why it exists, in the words of the person who asked for it. Required,
  -- because a magnet without a stated objective is a PDF.
  objective text not null check (length(btrim(objective)) between 1 and 2000),
  audience text check (audience is null or length(btrim(audience)) <= 2000),

  format text not null check (format in ('pdf_guide', 'checklist', 'template', 'video', 'email_course')),

  -- What it is for and what it may claim. A magnet bound to a campaign is
  -- scoped by that campaign's package; one without is an evergreen asset,
  -- which is a legitimate thing to have.
  campaign_id uuid references public.client_campaigns(id) on delete set null,
  offer_version_id uuid,

  archived_at timestamptz,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, client_id),
  foreign key (offer_version_id, client_id)
    references public.service_offer_versions(id, client_id) on delete restrict
);

comment on table public.lead_magnets is
  'What a client offers in exchange for contact details. The offering, not the file: the bytes live in lead_magnet_versions because replacing them has to invalidate an approval.';

create index lead_magnets_client_idx
  on public.lead_magnets (client_id, created_at desc) where archived_at is null;

create trigger lead_magnets_updated_at before update on public.lead_magnets
  for each row execute function public.set_updated_at();

alter table public.lead_magnets enable row level security;
create policy lead_magnets_read on public.lead_magnets
  for select to authenticated using (public.can_access_client(client_id));
grant select on public.lead_magnets to authenticated;
grant all on public.lead_magnets to service_role;

-- ---------------------------------------------------------------------------
-- The bytes
-- ---------------------------------------------------------------------------

create table public.lead_magnet_versions (
  id uuid primary key default gen_random_uuid(),
  magnet_id uuid not null,
  client_id uuid not null references public.clients(id) on delete cascade,
  version integer not null check (version > 0),

  -- Where the file is, and what it is. The hash is the whole point: it is
  -- what an approval is given against, and what each send re-checks.
  storage_path text not null check (length(btrim(storage_path)) between 1 and 500),
  content_sha256 text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  file_bytes bigint not null check (file_bytes > 0),
  media_type text not null check (length(btrim(media_type)) between 3 and 150),

  -- How it reaches somebody, frozen with the version because "this file by
  -- this route" is the single thing a person signs off.
  delivery_channel text not null check (delivery_channel in ('email', 'download_link')),
  delivery_subject text check (delivery_subject is null or length(btrim(delivery_subject)) <= 300),
  delivery_body text check (delivery_body is null or length(btrim(delivery_body)) <= 8000),

  created_by_job_id uuid references public.agent_jobs(id) on delete set null,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (magnet_id, version),
  unique (id, client_id),
  foreign key (magnet_id, client_id) references public.lead_magnets(id, client_id) on delete cascade
);

comment on table public.lead_magnet_versions is
  'One immutable candidate file plus the route it would travel. A new export is a new version, never an edit, because the hash is what an approval names.';

-- Immutable, for the reason every other versioned table here is: an approval
-- that names a hash is worth nothing if the row can be rewritten under it.
create function public.guard_lead_magnet_version_immutable()
returns trigger language plpgsql
set search_path = pg_catalog, public as $$
begin
  raise exception 'A magnet version is immutable. Create a new version.';
end $$;

create trigger lead_magnet_versions_immutable before update on public.lead_magnet_versions
  for each row execute function public.guard_lead_magnet_version_immutable();

alter table public.lead_magnet_versions enable row level security;
create policy lead_magnet_versions_read on public.lead_magnet_versions
  for select to authenticated using (public.can_access_client(client_id));
grant select on public.lead_magnet_versions to authenticated;
grant all on public.lead_magnet_versions to service_role;

-- ---------------------------------------------------------------------------
-- The one human decision
-- ---------------------------------------------------------------------------

create table public.lead_magnet_approvals (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  magnet_version_id uuid not null references public.lead_magnet_versions(id) on delete cascade,

  -- The file and the route together. Either changing is a different promise.
  payload_hash text not null check (payload_hash ~ '^[0-9a-f]{64}$'),
  scope jsonb not null check (jsonb_typeof(scope) = 'object'),

  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'revoked')),
  requested_at timestamptz not null default now(),
  requested_by uuid references public.profiles(id) on delete set null,
  decided_at timestamptz,
  decided_by uuid references public.profiles(id) on delete set null,
  rejection_reason text,
  revoked_at timestamptz,
  revoked_reason text,
  check (
    (status = 'pending' and decided_at is null and rejection_reason is null)
    or (status = 'approved' and decided_at is not null and decided_by is not null)
    or (status = 'rejected' and decided_at is not null and decided_by is not null
        and nullif(btrim(rejection_reason), '') is not null)
    or (status = 'revoked' and revoked_at is not null
        and nullif(btrim(revoked_reason), '') is not null))
);

-- One live decision per version. A second pending request is two people being
-- asked the same question.
create unique index lead_magnet_approval_pending_idx
  on public.lead_magnet_approvals (magnet_version_id) where status = 'pending';
create unique index lead_magnet_approval_live_idx
  on public.lead_magnet_approvals (magnet_version_id) where status = 'approved';

alter table public.lead_magnet_approvals enable row level security;
create policy lead_magnet_approvals_read on public.lead_magnet_approvals
  for select to authenticated using (public.can_access_client(client_id));
grant select on public.lead_magnet_approvals to authenticated;
grant all on public.lead_magnet_approvals to service_role;

-- The hash a person is agreeing to: these bytes, by this route, with these
-- words. Computed in the database so the screen, the approval and the sender
-- cannot disagree about what was approved.
create function public.lead_magnet_payload_hash_v6(p_version_id uuid)
returns text language sql stable
set search_path = pg_catalog, public as $$
  select encode(sha256(convert_to(
    v.content_sha256 || '|' || v.delivery_channel || '|' ||
    coalesce(v.delivery_subject, '') || '|' || coalesce(v.delivery_body, ''), 'UTF8')), 'hex')
    from public.lead_magnet_versions v where v.id = p_version_id;
$$;

revoke all on function public.lead_magnet_payload_hash_v6(uuid) from public, anon;
grant execute on function public.lead_magnet_payload_hash_v6(uuid) to authenticated, service_role;

create function public.request_lead_magnet_approval_v6(p_version_id uuid)
returns uuid language plpgsql security definer
set search_path = pg_catalog, public as $$
declare v_version public.lead_magnet_versions%rowtype; v_id uuid;
begin
  select * into v_version from public.lead_magnet_versions where id = p_version_id;
  if not found then raise exception 'No such magnet version.' using errcode = 'P0001'; end if;
  if not (coalesce(public.is_admin(), false)
          or coalesce(auth.uid() = public.active_video_approval_manager(v_version.client_id), false)) then
    raise exception 'Only an admin or the assigned client manager can ask for this.'
      using errcode = 'P0001';
  end if;
  -- A version that is already live has nothing left to ask about: it is
  -- immutable, so a second request would be the same question about the same
  -- bytes. Refused here rather than at the decision, because a unique index
  -- firing on somebody pressing Approve is a confusing place to learn this.
  if exists (select 1 from public.lead_magnet_approvals
              where magnet_version_id = p_version_id and status = 'approved') then
    raise exception 'This magnet version is already approved. Revoke it, or create a new version.'
      using errcode = 'P0001';
  end if;

  insert into public.lead_magnet_approvals (
    client_id, magnet_version_id, payload_hash, scope, requested_by)
  values (
    v_version.client_id, p_version_id,
    public.lead_magnet_payload_hash_v6(p_version_id),
    jsonb_build_object(
      'file', v_version.storage_path,
      'bytes', v_version.file_bytes,
      'media_type', v_version.media_type,
      'channel', v_version.delivery_channel,
      'subject', v_version.delivery_subject),
    auth.uid())
  returning id into v_id;
  return v_id;
end $$;

revoke all on function public.request_lead_magnet_approval_v6(uuid) from public, anon;
grant execute on function public.request_lead_magnet_approval_v6(uuid) to authenticated;

create function public.decide_lead_magnet_approval_v6(
  p_approval_id uuid, p_approved boolean, p_reason text default null)
returns public.lead_magnet_approvals language plpgsql security definer
set search_path = pg_catalog, public as $$
declare v_approval public.lead_magnet_approvals%rowtype; v_current text;
begin
  select * into v_approval from public.lead_magnet_approvals where id = p_approval_id for update;
  if not found then raise exception 'No such approval.' using errcode = 'P0001'; end if;
  if auth.role() is distinct from 'authenticated'
     or not (coalesce(public.is_admin(), false)
             or coalesce(auth.uid() = public.active_video_approval_manager(v_approval.client_id), false)) then
    raise exception 'A signed-in admin or the assigned client manager must decide this.'
      using errcode = 'P0001';
  end if;
  if v_approval.status <> 'pending' then
    raise exception 'That approval was already %.', v_approval.status using errcode = 'P0001';
  end if;

  -- The file may have been re-exported between asking and deciding, which
  -- would make this a decision about something nobody read.
  v_current := public.lead_magnet_payload_hash_v6(v_approval.magnet_version_id);
  if v_current <> v_approval.payload_hash then
    raise exception 'This magnet changed after approval was requested. Ask again.'
      using errcode = 'P0001';
  end if;

  if not coalesce(p_approved, false) then
    if nullif(btrim(coalesce(p_reason, '')), '') is null then
      raise exception 'Say why it was rejected.' using errcode = 'P0001';
    end if;
    update public.lead_magnet_approvals
       set status = 'rejected', decided_at = now(), decided_by = auth.uid(),
           rejection_reason = btrim(p_reason)
     where id = p_approval_id returning * into v_approval;
    return v_approval;
  end if;

  update public.lead_magnet_approvals
     set status = 'approved', decided_at = now(), decided_by = auth.uid()
   where id = p_approval_id returning * into v_approval;
  return v_approval;
end $$;

revoke all on function public.decide_lead_magnet_approval_v6(uuid, boolean, text) from public, anon;
grant execute on function public.decide_lead_magnet_approval_v6(uuid, boolean, text) to authenticated;

-- Taking it back. A magnet that turns out to be wrong has to stop going out
-- without waiting for somebody to delete rows.
create function public.revoke_lead_magnet_approval_v6(p_approval_id uuid, p_reason text)
returns void language plpgsql security definer
set search_path = pg_catalog, public as $$
declare v_approval public.lead_magnet_approvals%rowtype;
begin
  select * into v_approval from public.lead_magnet_approvals where id = p_approval_id for update;
  if not found then raise exception 'No such approval.' using errcode = 'P0001'; end if;
  if not (coalesce(public.is_admin(), false)
          or coalesce(auth.uid() = public.active_video_approval_manager(v_approval.client_id), false)) then
    raise exception 'Only an admin or the assigned client manager can revoke this.'
      using errcode = 'P0001';
  end if;
  if v_approval.status <> 'approved' then
    raise exception 'Only an approved magnet can be revoked.' using errcode = 'P0001';
  end if;
  if nullif(btrim(coalesce(p_reason, '')), '') is null then
    raise exception 'Say why it is being revoked.' using errcode = 'P0001';
  end if;
  update public.lead_magnet_approvals
     set status = 'revoked', revoked_at = now(), revoked_reason = btrim(p_reason)
   where id = p_approval_id;
  -- Anything not yet sent stops. Anything already sent cannot be unsent, and
  -- is left alone rather than rewritten to look as though it never happened.
  update public.lead_magnet_deliveries
     set status = 'cancelled', last_error = 'The magnet approval was revoked: ' || btrim(p_reason)
   where magnet_version_id = v_approval.magnet_version_id
     and status in ('queued', 'failed');
end $$;

-- ---------------------------------------------------------------------------
-- One send to one person
-- ---------------------------------------------------------------------------

create table public.lead_magnet_deliveries (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  -- One delivery per submission, enforced by the database rather than by the
  -- worker remembering. This single constraint is what "receives it once"
  -- rests on.
  submission_id uuid not null unique references public.lead_submissions(id) on delete cascade,
  lead_id uuid references public.client_leads(id) on delete set null,
  magnet_version_id uuid not null references public.lead_magnet_versions(id) on delete restrict,

  channel text not null check (channel in ('email', 'download_link')),
  recipient text not null check (length(btrim(recipient)) between 3 and 320),

  status text not null default 'queued' check (status in (
    'queued', 'sending', 'sent', 'failed', 'cancelled')),
  attempts integer not null default 0,
  claimed_at timestamptz,
  lease_until timestamptz,
  sent_at timestamptz,
  provider_ref text,
  last_error text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.lead_magnet_deliveries is
  'One send of one magnet version to one person who opted in. Unique on the submission, because "they receive it once" is a promise a worker cannot be trusted to keep by itself.';

create index lead_magnet_deliveries_claim_idx
  on public.lead_magnet_deliveries (status, lease_until);
create index lead_magnet_deliveries_client_idx
  on public.lead_magnet_deliveries (client_id, created_at desc);

create trigger lead_magnet_deliveries_updated_at before update on public.lead_magnet_deliveries
  for each row execute function public.set_updated_at();

alter table public.lead_magnet_deliveries enable row level security;
create policy lead_magnet_deliveries_read on public.lead_magnet_deliveries
  for select to authenticated using (public.can_access_client(client_id));
grant select on public.lead_magnet_deliveries to authenticated;
grant all on public.lead_magnet_deliveries to service_role;

revoke all on function public.revoke_lead_magnet_approval_v6(uuid, text) from public, anon;
grant execute on function public.revoke_lead_magnet_approval_v6(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Binding a magnet to the form that promises it
-- ---------------------------------------------------------------------------

alter table public.lead_capture_endpoints
  add column if not exists magnet_version_id uuid
    references public.lead_magnet_versions(id) on delete restrict;

comment on column public.lead_capture_endpoints.magnet_version_id is
  'Which exact magnet version this form promises. A magnet_optin endpoint without one promises something nobody can deliver, which the due view says in words.';

-- The queue fills itself. A promoted submission on an endpoint that promises
-- a magnet owes that person a file, and leaving that to a separate step is
-- how somebody opts in and hears nothing.
create function public.queue_lead_magnet_delivery_v6()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public as $$
declare v_endpoint public.lead_capture_endpoints%rowtype; v_version public.lead_magnet_versions%rowtype;
begin
  if new.status <> 'promoted' or coalesce(old.status, '') = 'promoted' then
    return new;
  end if;
  select * into v_endpoint from public.lead_capture_endpoints where id = new.endpoint_id;
  if v_endpoint.magnet_version_id is null then return new; end if;
  select * into v_version from public.lead_magnet_versions where id = v_endpoint.magnet_version_id;

  -- Email is the only channel that needs an address; a download link is
  -- handed back by the page itself.
  if v_version.delivery_channel = 'email'
     and nullif(btrim(coalesce(new.email, '')), '') is null then
    return new;
  end if;

  insert into public.lead_magnet_deliveries (
    client_id, submission_id, lead_id, magnet_version_id, channel, recipient)
  values (
    new.client_id, new.id, new.lead_id, v_version.id, v_version.delivery_channel,
    coalesce(nullif(btrim(coalesce(new.email, '')), ''), new.phone))
  on conflict (submission_id) do nothing;
  return new;
end $$;

create trigger lead_submission_queues_magnet
  after update of status on public.lead_submissions
  for each row execute function public.queue_lead_magnet_delivery_v6();

-- ---------------------------------------------------------------------------
-- Why nothing has been sent
-- ---------------------------------------------------------------------------

create or replace view lead_magnet_due with (security_invoker = true) as
select
  d.id as delivery_id,
  d.client_id,
  d.submission_id,
  d.lead_id,
  d.magnet_version_id,
  m.name as magnet_name,
  d.channel,
  d.recipient,
  d.status,
  d.attempts,
  d.provider_ref,
  d.last_error,
  case
    when a.id is null
      then 'Nobody has approved this magnet.'
    when a.status = 'revoked'
      then 'The approval was revoked: ' || coalesce(a.revoked_reason, 'no reason recorded') || '.'
    when a.status <> 'approved'
      then 'The approval is ' || a.status || '.'
    when a.payload_hash <> public.lead_magnet_payload_hash_v6(d.magnet_version_id)
      then 'The file or the message changed after approval. Ask again.'
    when not coalesce(ces.lead_magnet_delivery_enabled, false)
      then 'Magnet delivery is off for this client.'
    when d.status = 'sent' then 'Already sent.'
    when d.status = 'cancelled' then 'Cancelled.'
    when d.status = 'sending' and d.lease_until > now() then 'Being sent now.'
    when d.attempts >= 5
      then 'Failed ' || d.attempts::text || ' times. Last error: '
           || coalesce(d.last_error, 'none recorded') || '.'
    else null
  end as blocker
from public.lead_magnet_deliveries d
join public.lead_magnet_versions v on v.id = d.magnet_version_id
join public.lead_magnets m on m.id = v.magnet_id
left join public.lead_magnet_approvals a
  on a.magnet_version_id = d.magnet_version_id and a.status in ('approved', 'revoked')
left join public.client_engine_settings ces on ces.client_id = d.client_id;

comment on view lead_magnet_due is
  'Every owed magnet and the one sentence saying why it has not gone. A null blocker means the courier would take it next.';

grant select on lead_magnet_due to authenticated;

-- ---------------------------------------------------------------------------
-- Sending
-- ---------------------------------------------------------------------------

create function public.claim_lead_magnet_deliveries(p_limit integer default 5)
returns table (
  delivery_id uuid, client_id uuid, magnet_version_id uuid, channel text,
  recipient text, storage_path text, media_type text, content_sha256 text,
  delivery_subject text, delivery_body text, magnet_name text, attempt integer)
language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  if auth.role() <> 'service_role' then
    raise exception 'Only the internal service may claim a delivery.';
  end if;
  return query
  with ready as (
    select d.id from public.lead_magnet_deliveries d
     where d.status in ('queued', 'failed')
       and d.id in (select u.delivery_id from public.lead_magnet_due u where u.blocker is null)
     order by d.created_at
     limit greatest(coalesce(p_limit, 5), 1)
     for update skip locked
  ), claimed as (
    update public.lead_magnet_deliveries d
       set status = 'sending', claimed_at = now(),
           lease_until = now() + interval '10 minutes', attempts = d.attempts + 1
     where d.id in (select r.id from ready r)
     returning d.*
  )
  select c.id, c.client_id, c.magnet_version_id, c.channel, c.recipient,
         v.storage_path, v.media_type, v.content_sha256,
         v.delivery_subject, v.delivery_body, m.name, c.attempts
    from claimed c
    join public.lead_magnet_versions v on v.id = c.magnet_version_id
    join public.lead_magnets m on m.id = v.magnet_id;
end $$;

revoke all on function public.claim_lead_magnet_deliveries(integer) from public, anon, authenticated;
grant execute on function public.claim_lead_magnet_deliveries(integer) to service_role;

create function public.record_lead_magnet_sent(p_delivery_id uuid, p_provider_ref text)
returns void language plpgsql security definer set search_path = pg_catalog, public as $$
declare v public.lead_magnet_deliveries%rowtype;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Only the internal service may record a delivery.';
  end if;
  update public.lead_magnet_deliveries
     set status = 'sent', provider_ref = p_provider_ref, sent_at = now(),
         lease_until = null, last_error = null
   where id = p_delivery_id and status = 'sending'
   returning * into v;
  if not found then raise exception 'That delivery is not being sent.'; end if;

  -- On the lead's own history, because "did they ever get it" is a question
  -- somebody asks of the lead rather than of a delivery table.
  if v.lead_id is not null then
    insert into public.lead_events (lead_id, client_id, kind, body)
    values (v.lead_id, v.client_id, 'note',
            'Lead magnet sent by ' || v.channel || '. Provider reference ' ||
            coalesce(p_provider_ref, 'none') || '.');
  end if;
end $$;

revoke all on function public.record_lead_magnet_sent(uuid, text) from public, anon, authenticated;
grant execute on function public.record_lead_magnet_sent(uuid, text) to service_role;

-- A provider that accepted it is not a person who received it, and a failure
-- that did not obviously fail before the send stays failed. Retryable here is
-- narrower than elsewhere: sending the same file twice is a small annoyance,
-- but sending it to the wrong person twice is not, so only transport faults
-- qualify.
create function public.record_lead_magnet_failure(
  p_delivery_id uuid, p_reason text, p_retryable boolean default false)
returns void language plpgsql security definer set search_path = pg_catalog, public as $$
declare v public.lead_magnet_deliveries%rowtype;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Only the internal service may record a failure.';
  end if;
  update public.lead_magnet_deliveries
     set status = case when coalesce(p_retryable, false) then 'queued' else 'failed' end,
         last_error = p_reason, lease_until = null
   where id = p_delivery_id and status = 'sending'
   returning * into v;
  if not found then raise exception 'That delivery is not being sent.'; end if;
end $$;

revoke all on function public.record_lead_magnet_failure(uuid, text, boolean)
  from public, anon, authenticated;
grant execute on function public.record_lead_magnet_failure(uuid, text, boolean) to service_role;

create function public.reap_stale_lead_magnet_deliveries()
returns integer language plpgsql security definer
set search_path = pg_catalog, public as $$
declare v_count integer;
begin
  update public.lead_magnet_deliveries
     set status = 'failed', lease_until = null,
         last_error = 'The send stopped without recording an outcome. Check the provider before retrying.'
   where status = 'sending' and lease_until is not null and lease_until < now();
  get diagnostics v_count = row_count;
  return v_count;
end $$;

revoke all on function public.reap_stale_lead_magnet_deliveries() from public, anon, authenticated;
grant execute on function public.reap_stale_lead_magnet_deliveries() to service_role;

create function public.enqueue_lead_magnet_sweep()
returns uuid language plpgsql security definer
set search_path to 'public' as $$
declare v_job uuid;
begin
  if exists (select 1 from agent_jobs
              where agent_key = 'lead_magnet_courier'
                and status in ('queued', 'claimed', 'running')) then
    return null;
  end if;
  if not exists (select 1 from lead_magnet_due where blocker is null) then
    return null;
  end if;
  insert into agent_jobs (agent_key, params)
  values ('lead_magnet_courier', jsonb_build_object('limit', 5))
  returning id into v_job;
  return v_job;
end $$;

revoke all on function public.enqueue_lead_magnet_sweep() from public, anon;
grant execute on function public.enqueue_lead_magnet_sweep() to authenticated, service_role;

insert into agents (agent_key, name, initials, domain, description, requires_upstream) values
  ('lead_magnet_courier', 'Lead Magnet Courier', 'LM', null,
   'Sends the exact approved magnet to the people who opted in for it, once each, re-checking the approval against the file immediately before every send.',
   array[]::text[])
on conflict (agent_key) do update
  set name = excluded.name, initials = excluded.initials,
      description = excluded.description, requires_upstream = excluded.requires_upstream;

-- Every two minutes. Somebody who has just handed over their email address
-- is waiting, and ten minutes of that is a long time.
select cron.unschedule('lead-magnet-sweep')
 where exists (select 1 from cron.job where jobname = 'lead-magnet-sweep');
select cron.schedule('lead-magnet-sweep', '*/2 * * * *',
  $cron$ select public.enqueue_lead_magnet_sweep(); $cron$);

select cron.unschedule('reap-stale-lead-magnet-deliveries')
 where exists (select 1 from cron.job where jobname = 'reap-stale-lead-magnet-deliveries');
select cron.schedule('reap-stale-lead-magnet-deliveries', '45 * * * *',
  $cron$ select public.reap_stale_lead_magnet_deliveries(); $cron$);

select lock_down_definer_functions();

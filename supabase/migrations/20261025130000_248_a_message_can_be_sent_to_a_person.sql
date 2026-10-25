-- G02: a governed way to send something to one person.
--
-- The lead magnet courier can email a file, because that email is the
-- fulfilment of a thing somebody asked for. Nothing else can send anything.
-- `campaign_action_executors.lead_message` has read "No governed outbound
-- send path exists yet" since 230, and `proof_destinations.email_sms_nurture`
-- has been unsupported for the same reason.
--
-- So: R2's objection sequences cannot run, a magnet cannot be followed up, a
-- lead who went quiet cannot be reached, and the nurture layer is broadcast
-- only. Three other gaps -- the DM path, per-lead sequencing, and proof in a
-- nurture template -- are all waiting on this one.
--
-- WHAT IS APPROVED, AND WHY IT IS NOT EACH SEND
--
-- The exact-version discipline everywhere else approves one artifact going
-- to one destination. Applied literally to messaging it would mean a person
-- approving every email to every lead, which is not a policy, it is a
-- refusal to have the feature.
--
-- So the artifact is the **template version** and the approval carries a
-- **scope**: this version, on this channel, for this purpose. Each send
-- records the approval that authorised it, so the question "who said this
-- could be sent" has an answer per message, and changing a single word
-- produces a new version with no approval -- the same property the page
-- publisher gets from re-hashing bytes.
--
-- WHAT STOPS A SEND, IN ORDER
--
--   the runtime flag, then the client switch
--   the channel having a transport at all
--   a standing approval for that version, channel and purpose
--   consent recorded on the lead
--   the lead not being suppressed
--   the client's daily cap
--
-- Suppression is last in that list and absolute in effect: there is no
-- argument, no override and no function that can send to a suppressed
-- person. An unsubscribe that can be overruled by a flag is not an
-- unsubscribe.
--
-- WHAT THIS DOES NOT DO: PARSE CONSENT
--
-- A lead carries `consent_wording` -- the verbatim text somebody agreed to --
-- and nothing here reads it, because a regex that decides whether "we may
-- contact you about your quote" covers a reactivation campaign would be
-- confidently wrong. Instead the purpose is declared on the approval, the
-- consent wording and timestamp are copied onto every message at send time,
-- and the judgement stays with the person approving. The evidence travels
-- with the send so the decision can be defended later rather than
-- reconstructed.

-- ---------------------------------------------------------------------------
-- The switch
-- ---------------------------------------------------------------------------

alter table public.client_engine_settings
  add column if not exists outbound_messaging_enabled boolean not null default false,
  add column if not exists outbound_messaging_enabled_at timestamptz,
  add column if not exists outbound_messaging_enabled_by uuid references public.profiles(id),
  add column if not exists outbound_daily_cap integer not null default 200
    check (outbound_daily_cap >= 0);

comment on column public.client_engine_settings.outbound_messaging_enabled is
  'When on, approved messages to individual leads actually send. Off by default: this is the switch that starts writing to strangers.';
comment on column public.client_engine_settings.outbound_daily_cap is
  'The most messages that may leave for this client in a day. A cap rather than a rate: the failure worth preventing is a loop emailing a list twice, not a burst.';

create or replace function public.set_outbound_messaging_enabled(
  p_client_id uuid, p_enabled boolean)
returns void language plpgsql security definer
set search_path = pg_catalog, public as $$
begin
  if not coalesce(public.is_admin(), false) then
    raise exception 'Only an admin can turn outbound messaging on or off.' using errcode = 'P0001';
  end if;
  insert into public.client_engine_settings (
    client_id, outbound_messaging_enabled, outbound_messaging_enabled_at,
    outbound_messaging_enabled_by)
  values (p_client_id, coalesce(p_enabled, false),
          case when p_enabled then now() else null end,
          case when p_enabled then auth.uid() else null end)
  on conflict (client_id) do update
    set outbound_messaging_enabled = excluded.outbound_messaging_enabled,
        outbound_messaging_enabled_at = excluded.outbound_messaging_enabled_at,
        outbound_messaging_enabled_by = excluded.outbound_messaging_enabled_by;
end $$;

revoke all on function public.set_outbound_messaging_enabled(uuid, boolean) from public, anon;
grant execute on function public.set_outbound_messaging_enabled(uuid, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- Which channels can actually carry a message
-- ---------------------------------------------------------------------------

create table if not exists public.message_channels (
  channel_key text primary key check (channel_key in
    ('email', 'sms', 'whatsapp', 'instagram_dm', 'messenger')),
  transport text not null,
  supported boolean not null default false,
  -- What a person needs to know when it is not supported. Same discipline as
  -- proof_destinations: a missing adapter is a row, not a silence.
  note text not null,
  -- Whether this channel can start a conversation or only continue one.
  -- Meta's platforms do not let a business message first, which is a fact
  -- about the channel rather than about our adapter.
  can_initiate boolean not null default true
);

comment on table public.message_channels is
  'The channels a governed message can go out on, and for the rest, what is missing. can_initiate records that some channels only permit a reply.';

insert into public.message_channels (channel_key, transport, supported, note, can_initiate) values
  ('email', 'resend', true,
   'Transactional email through Resend, which the lead magnet courier already uses. The only channel with a working transport.', true),
  ('sms', 'none', false,
   'No SMS provider is configured. Needs an account, a sender identity and a per-country compliance decision before it can be switched on.', true),
  ('whatsapp', 'none', false,
   'Needs a WhatsApp Business account and template pre-approval from Meta, which is a commercial step rather than an adapter.', false),
  ('instagram_dm', 'none', false,
   'Needs the Instagram messaging adapter. Instagram only permits a reply inside a window the person opened, so this channel can never start a conversation.', false),
  ('messenger', 'none', false,
   'Needs the Messenger adapter, with the same reply-only window as Instagram.', false)
on conflict (channel_key) do update
  set transport = excluded.transport, supported = excluded.supported,
      note = excluded.note, can_initiate = excluded.can_initiate;

alter table public.message_channels enable row level security;
drop policy if exists message_channels_read on public.message_channels;
create policy message_channels_read on public.message_channels
  for select to authenticated using (true);
grant select on public.message_channels to authenticated;
grant all on public.message_channels to service_role;

-- ---------------------------------------------------------------------------
-- The artifact: a template, and immutable versions of it
-- ---------------------------------------------------------------------------

create table if not exists public.message_templates (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 200),
  -- Why this message exists. Declared, not inferred, and carried onto the
  -- approval so the person saying yes is saying yes to a purpose.
  purpose text not null check (purpose in
    ('transactional', 'magnet_follow_up', 'objection', 'reengagement', 'booking')),
  channel_key text not null references public.message_channels(channel_key),
  campaign_id uuid references public.client_campaigns(id) on delete set null,
  archived_at timestamptz,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, client_id)
);

comment on table public.message_templates is
  'A kind of message this client sends. The template is the thing named; its versions are the things approved.';

create index if not exists message_templates_client_idx
  on public.message_templates (client_id, purpose) where archived_at is null;

create table if not exists public.message_template_versions (
  id uuid primary key default gen_random_uuid(),
  template_id uuid not null references public.message_templates(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  version integer not null check (version >= 1),

  subject text check (subject is null or length(btrim(subject)) <= 300),
  body text not null check (length(btrim(body)) between 1 and 20000),
  -- Placeholders the body uses, so a send can refuse rather than post a
  -- message with {{first_name}} in it.
  placeholders text[] not null default '{}',

  payload_hash text not null,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  unique (template_id, version),
  unique (id, client_id)
);

comment on table public.message_template_versions is
  'One immutable version of a message. Changing a word is a new version with no approval, which is how the exact-version rule reaches messaging without approving every send.';

create or replace function public.guard_message_template_version_immutable()
returns trigger language plpgsql
set search_path = pg_catalog, public as $$
begin
  raise exception 'A message version cannot be edited. Add a new version instead.';
end $$;

drop trigger if exists guard_message_template_version_immutable
  on public.message_template_versions;
create trigger guard_message_template_version_immutable
  before update on public.message_template_versions
  for each row execute function public.guard_message_template_version_immutable();

create or replace function public.message_payload_hash_v6(
  p_subject text, p_body text, p_channel text)
returns text language sql immutable
set search_path = pg_catalog, public as $$
  select encode(sha256(convert_to(
    coalesce(p_channel, '') || E'\n' || coalesce(p_subject, '') || E'\n' || coalesce(p_body, ''),
    'UTF8')), 'hex');
$$;

-- ---------------------------------------------------------------------------
-- The approval: this version, this channel, this purpose
-- ---------------------------------------------------------------------------

create table if not exists public.message_template_approvals (
  id uuid primary key default gen_random_uuid(),
  template_version_id uuid not null
    references public.message_template_versions(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  channel_key text not null references public.message_channels(channel_key),
  purpose text not null,

  status text not null default 'approved' check (status in ('approved', 'revoked')),
  -- What the approver is asserting: that the consent these leads gave covers
  -- a message of this purpose. Nothing parses consent wording, so this is
  -- the record of a human judgement.
  consent_basis text not null check (length(btrim(consent_basis)) between 1 and 1000),

  approved_by uuid references public.profiles(id),
  approved_at timestamptz not null default now(),
  revoked_by uuid references public.profiles(id),
  revoked_at timestamptz,
  revoked_reason text,
  -- One standing approval per version and channel. A second would be two
  -- answers to the same question.
  unique (template_version_id, channel_key)
);

comment on table public.message_template_approvals is
  'A standing approval to send one version of one message on one channel, with the approver''s stated basis for believing consent covers it. Revoked rather than deleted, so a message sent last week still points at the decision that allowed it.';

alter table public.message_templates enable row level security;
alter table public.message_template_versions enable row level security;
alter table public.message_template_approvals enable row level security;
drop policy if exists message_templates_read on public.message_templates;
create policy message_templates_read on public.message_templates
  for select to authenticated using (public.can_access_client(client_id));
drop policy if exists message_template_versions_read on public.message_template_versions;
create policy message_template_versions_read on public.message_template_versions
  for select to authenticated using (public.can_access_client(client_id));
drop policy if exists message_template_approvals_read on public.message_template_approvals;
create policy message_template_approvals_read on public.message_template_approvals
  for select to authenticated using (public.can_access_client(client_id));
grant select on public.message_templates, public.message_template_versions,
  public.message_template_approvals to authenticated;
grant all on public.message_templates, public.message_template_versions,
  public.message_template_approvals to service_role;

-- ---------------------------------------------------------------------------
-- Suppression, which nothing can override
-- ---------------------------------------------------------------------------

create table if not exists public.lead_suppressions (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  -- Keyed the way a lead is identified, so it survives the same person
  -- arriving again through a different campaign.
  dedupe_key text not null,
  reason text not null check (reason in
    ('unsubscribed', 'complained', 'bounced', 'asked_by_client', 'manual')),
  detail text,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  unique (client_id, dedupe_key)
);

comment on table public.lead_suppressions is
  'People this client may not message, keyed on the lead dedupe key so it follows the person rather than the row. There is no function that sends to a suppressed person and no flag that overrides it: an unsubscribe that can be overruled is not an unsubscribe.';

alter table public.lead_suppressions enable row level security;
drop policy if exists lead_suppressions_read on public.lead_suppressions;
create policy lead_suppressions_read on public.lead_suppressions
  for select to authenticated using (public.can_access_client(client_id));
grant select on public.lead_suppressions to authenticated;
grant all on public.lead_suppressions to service_role;

-- Callable by the service too, because an unsubscribe arrives from a link or
-- a provider webhook rather than from somebody signed in.
create or replace function public.suppress_lead_v6(
  p_client_id uuid, p_dedupe_key text, p_reason text, p_detail text default null)
returns uuid language plpgsql security definer
set search_path = pg_catalog, public as $$
declare v_id uuid;
begin
  if coalesce(auth.role(), '') <> 'service_role'
     and not (coalesce(public.is_admin(), false)
              or coalesce(public.can_access_client(p_client_id), false)) then
    raise exception 'Not permitted for this client.' using errcode = 'P0001';
  end if;
  if nullif(btrim(coalesce(p_dedupe_key, '')), '') is null then
    raise exception 'Say who is being suppressed.' using errcode = 'P0001';
  end if;
  if p_reason not in ('unsubscribed','complained','bounced','asked_by_client','manual') then
    raise exception 'Unknown suppression reason.' using errcode = 'P0001';
  end if;

  insert into public.lead_suppressions (client_id, dedupe_key, reason, detail, created_by)
  values (p_client_id, btrim(p_dedupe_key), p_reason, p_detail,
          case when auth.role() = 'service_role' then null else auth.uid() end)
  on conflict (client_id, dedupe_key) do update
    set reason = excluded.reason, detail = coalesce(excluded.detail, lead_suppressions.detail)
  returning id into v_id;
  return v_id;
end $$;

revoke all on function public.suppress_lead_v6(uuid, text, text, text) from public, anon;
grant execute on function public.suppress_lead_v6(uuid, text, text, text)
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- The send
-- ---------------------------------------------------------------------------

create table if not exists public.outbound_messages (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  lead_id uuid not null references public.client_leads(id) on delete cascade,
  template_version_id uuid not null
    references public.message_template_versions(id) on delete restrict,
  approval_id uuid not null
    references public.message_template_approvals(id) on delete restrict,
  channel_key text not null references public.message_channels(channel_key),
  campaign_id uuid references public.client_campaigns(id) on delete set null,

  -- Where it went, as resolved at queue time. Kept because a lead's address
  -- can change and the question later is where this message actually went.
  address text not null,
  rendered_subject text,
  rendered_body text not null,

  -- The consent that was on the lead when this was queued, copied rather
  -- than joined. The evidence has to travel with the send; a join would
  -- show today's consent for a message sent in March.
  consent_given_at timestamptz,
  consent_wording text,

  status text not null default 'queued' check (status in (
    'queued', 'sending', 'sent', 'failed', 'cancelled')),
  attempts integer not null default 0,
  claimed_at timestamptz,
  lease_until timestamptz,
  sent_at timestamptz,
  external_id text,
  last_error text,

  -- One message per lead per template version. A sequence that re-fires must
  -- not send the same words twice, and a retry must not either.
  idempotency_key text not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.outbound_messages is
  'One governed message to one person: what was sent, where, under which approval, and with the consent that was on the lead at the time. Unique per lead and template version, so neither a retry nor a re-fired sequence can repeat it.';

create index if not exists outbound_messages_claim_idx
  on public.outbound_messages (status, lease_until);
create index if not exists outbound_messages_client_idx
  on public.outbound_messages (client_id, created_at desc);
create index if not exists outbound_messages_lead_idx
  on public.outbound_messages (lead_id, created_at desc);

alter table public.outbound_messages enable row level security;
drop policy if exists outbound_messages_read on public.outbound_messages;
create policy outbound_messages_read on public.outbound_messages
  for select to authenticated using (public.can_access_client(client_id));
grant select on public.outbound_messages to authenticated;
grant all on public.outbound_messages to service_role;

create or replace function public.set_updated_at_outbound()
returns trigger language plpgsql set search_path = pg_catalog, public as $$
begin new.updated_at := now(); return new; end $$;

drop trigger if exists outbound_messages_updated_at on public.outbound_messages;
create trigger outbound_messages_updated_at before update on public.outbound_messages
  for each row execute function public.set_updated_at_outbound();

select lock_down_definer_functions();

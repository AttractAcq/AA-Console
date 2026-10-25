-- G04: something that actually books a call.
--
-- A sales agent carries a `booking_rule` — a sentence telling it when to
-- offer a booking — and nothing behind it. No calendar is connected,
-- nothing creates an appointment, and `client_leads.appointment_at` is set
-- by a person after the fact. So the agent can say "I have put you in for
-- Thursday at ten" and mean nothing by it, which is the worst failure in the
-- whole convert layer: the prospect believes it.
--
-- WHY THIS DOES NOT CONNECT GOOGLE CALENDAR
--
-- It would be the obvious move and it is the wrong first one. A two-way sync
-- needs OAuth per client, a webhook for external changes, conflict rules for
-- when both sides moved, and a decision about what happens when the token
-- dies mid-week. That is a project, and until it exists a client would have
-- a booking system that silently disagrees with the diary they actually use.
--
-- So this owns the availability instead: rules the client states, slots
-- computed from them, and one row per appointment. It is a real booking loop
-- with no third party in it, and the calendar sync becomes an export later
-- rather than a prerequisite now. What this deliberately cannot do is see a
-- dentist's own diary, so the rules have to be stated honestly — which is
-- why the settings ask for the hours they will actually honour rather than
-- the hours they are open.
--
-- DOUBLE BOOKING IS THE ONE UNFORGIVABLE BUG
--
-- Two people cannot hold the same slot. The check and the insert happen
-- under one advisory lock per client, so two requests arriving in the same
-- millisecond cannot both find the slot free. An exclusion constraint would
-- be tidier but needs btree_gist to scope by client, and a dependency on an
-- extension for the one rule that must never fail is a worse trade than six
-- lines of locking.

-- ---------------------------------------------------------------------------
-- What hours a client will honour
-- ---------------------------------------------------------------------------

create table if not exists public.client_booking_settings (
  client_id uuid primary key references public.clients(id) on delete cascade,
  -- Everything below is in this zone. Stored as a name rather than an offset
  -- so a booking in March still means the same clock time in November.
  timezone text not null default 'Europe/London',
  slot_minutes integer not null default 30 check (slot_minutes between 5 and 240),
  -- Gap after each appointment. A back-to-back diary is how a client ends up
  -- taking the second call from their car.
  buffer_minutes integer not null default 15 check (buffer_minutes between 0 and 240),
  -- Nothing may be booked sooner than this. Two hours' notice is not a
  -- booking, it is an ambush.
  min_notice_hours integer not null default 24 check (min_notice_hours between 0 and 720),
  -- Nor further out than this, because a slot four months away will be
  -- forgotten by both sides.
  max_days_ahead integer not null default 30 check (max_days_ahead between 1 and 365),
  -- The most calls the client will take in one day, whatever the hours allow.
  max_per_day integer not null default 4 check (max_per_day between 1 and 50),

  enabled boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.client_booking_settings is
  'The hours a client will actually honour, not the hours they are open. This system cannot see their own diary, so the rules have to be stated rather than inferred.';

comment on column public.client_booking_settings.enabled is
  'Off by default. On means a prospect can take a slot in the client''s week without anybody at the agency seeing it first.';

create table if not exists public.client_booking_windows (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  -- 0 is Sunday, matching extract(dow).
  day_of_week integer not null check (day_of_week between 0 and 6),
  starts_at_minute integer not null check (starts_at_minute between 0 and 1439),
  ends_at_minute integer not null check (ends_at_minute between 1 and 1440),
  created_at timestamptz not null default now(),
  check (ends_at_minute > starts_at_minute),
  unique (client_id, day_of_week, starts_at_minute)
);

comment on table public.client_booking_windows is
  'When in a week a client takes calls, as minutes from midnight in their own timezone. Several windows a day is normal: most people do not take calls over lunch.';

-- ---------------------------------------------------------------------------
-- The appointment
-- ---------------------------------------------------------------------------

create table if not exists public.client_appointments (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  lead_id uuid not null references public.client_leads(id) on delete cascade,
  campaign_id uuid references public.client_campaigns(id) on delete set null,

  starts_at timestamptz not null,
  ends_at timestamptz not null,
  check (ends_at > starts_at),

  status text not null default 'booked' check (status in (
    'booked', 'attended', 'no_show', 'cancelled')),
  -- Who did the booking. A prospect taking their own slot and a person
  -- typing it in are different facts, and the second says nothing about
  -- whether the booking link works.
  booked_via text not null check (booked_via in ('public_link', 'sales_agent', 'person')),
  booked_by uuid references public.profiles(id),

  cancelled_reason text,
  outcome_note text,
  external_ref text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.client_appointments is
  'One booked call. The row the sales agent''s booking rule finally has something to create, and the row a no-show rate can be counted from.';

create index if not exists client_appointments_client_idx
  on public.client_appointments (client_id, starts_at);
create index if not exists client_appointments_live_idx
  on public.client_appointments (client_id, starts_at)
  where status in ('booked', 'attended');
create index if not exists client_appointments_lead_idx
  on public.client_appointments (lead_id, starts_at desc);

-- ---------------------------------------------------------------------------
-- The public booking link
-- ---------------------------------------------------------------------------

create table if not exists public.booking_links (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  campaign_id uuid references public.client_campaigns(id) on delete set null,
  purpose text not null check (length(btrim(purpose)) between 1 and 200),
  -- Stored as a hash, shown once, exactly like a lead capture token.
  token_hash text not null unique,
  enabled boolean not null default true,
  expires_at timestamptz,
  revoked_at timestamptz,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now()
);

comment on table public.booking_links is
  'A link a prospect can take a slot through. The token is stored only as a hash and shown once, the same discipline as a lead capture endpoint.';

alter table public.client_booking_settings enable row level security;
alter table public.client_booking_windows enable row level security;
alter table public.client_appointments enable row level security;
alter table public.booking_links enable row level security;
drop policy if exists client_booking_settings_read on public.client_booking_settings;
create policy client_booking_settings_read on public.client_booking_settings
  for select to authenticated using (public.can_access_client(client_id));
drop policy if exists client_booking_windows_read on public.client_booking_windows;
create policy client_booking_windows_read on public.client_booking_windows
  for select to authenticated using (public.can_access_client(client_id));
drop policy if exists client_appointments_read on public.client_appointments;
create policy client_appointments_read on public.client_appointments
  for select to authenticated using (public.can_access_client(client_id));
drop policy if exists booking_links_read on public.booking_links;
create policy booking_links_read on public.booking_links
  for select to authenticated using (public.can_access_client(client_id));
grant select on public.client_booking_settings, public.client_booking_windows,
  public.client_appointments, public.booking_links to authenticated;
grant all on public.client_booking_settings, public.client_booking_windows,
  public.client_appointments, public.booking_links to service_role;

drop trigger if exists client_booking_settings_updated_at on public.client_booking_settings;
create trigger client_booking_settings_updated_at before update
  on public.client_booking_settings
  for each row execute function public.set_updated_at();
drop trigger if exists client_appointments_updated_at on public.client_appointments;
create trigger client_appointments_updated_at before update on public.client_appointments
  for each row execute function public.set_updated_at();

select lock_down_definer_functions();

-- Everything about how a client is reached and how they appear in public.
--
-- Migration 48 put a phone and a logo on client_business_context, which was
-- the wrong home: that row is the strategic brief every agent reads, not a
-- record of who to ring. Contact details belong with the client, are edited
-- by a different person at a different time, and are the values a generated
-- asset must reproduce exactly.
--
-- Those two columns are dropped rather than left behind. They are an hour old
-- and hold one value; leaving them would mean two places to look for a phone
-- number, and eventually two different answers.

create table client_contact_details (
  client_id       uuid primary key references clients(id) on delete cascade,

  -- Who we actually talk to.
  primary_contact text,
  role_title      text,
  email           text,
  phone           text,
  whatsapp        text,

  -- How they appear in public. These are rendered as literal type on
  -- creative, so an approximation is a false claim, not a near miss.
  website         text,
  instagram       text,
  facebook        text,
  address         text,
  logo_path       text,

  notes           text,
  updated_at      timestamptz not null default now()
);

alter table client_contact_details enable row level security;

create policy ccd_admin_all on client_contact_details
  for all to authenticated using (is_admin()) with check (is_admin());

-- A client may read their own record; it is their own information.
create policy ccd_client_read on client_contact_details
  for select to authenticated using (is_client_user(client_id));

create trigger ccd_set_updated_at
  before update on client_contact_details
  for each row execute function set_updated_at();

comment on table client_contact_details is
  'How a client is reached, and how they appear in public. The identity a generated asset must reproduce exactly rather than invent.';
comment on column client_contact_details.logo_path is
  'Storage path in client-media. Never redrawn by the image model - a diffusion model approximates a wordmark, and an approximated logo is still the wrong mark.';

-- carry across the one value that exists, then remove the wrong home
insert into client_contact_details (client_id, phone)
select client_id, contact_phone
  from client_business_context
 where contact_phone is not null
on conflict (client_id) do update set phone = excluded.phone;

alter table client_business_context
  drop column contact_phone,
  drop column logo_path;;

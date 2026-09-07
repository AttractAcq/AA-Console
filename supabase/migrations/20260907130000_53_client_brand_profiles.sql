-- The visual brand, so generated content looks like the same company twice.
--
-- Identity — phone, website, logo — has been handled rigorously since the
-- renderer invented a practice name: each detail is given verbatim or
-- explicitly forbidden. Visual brand had no equivalent. `art_direction` was
-- written fresh by the concept model on every build, so two assets for one
-- client could share nothing: different palette, different type, different
-- register. Nothing in the system said what the brand looks like.
--
-- This is that missing half, and it follows the same discipline: a value on
-- file is quoted verbatim into the prompt, and its absence is stated rather
-- than left for the model to fill in.

create table client_brand_profiles (
  client_id uuid primary key references clients(id) on delete cascade,

  -- Palette. Stored as hex because that is what goes into a prompt and,
  -- later, into CSS. Constrained so a typo cannot reach a renderer as a
  -- colour it will silently reinterpret.
  colour_primary    text,
  colour_secondary  text,
  colour_accent     text,
  colour_background text,
  colour_text       text,

  -- Typography. Named fonts, not files: the image model is told the shape of
  -- the type it should imitate, and pages will use the real family.
  font_heading text,
  font_body    text,

  -- How the pictures should look. imagery_style is the biggest single lever
  -- over whether two assets feel related.
  imagery_style     text,
  lighting          text,
  mood              text,
  composition_notes text,

  -- Brand-specific bans, on top of the global ones the renderer already
  -- carries. "Never a stock handshake", "never a smiling model in a hard hat".
  never_do text,

  -- Held for when a generated page is actually rendered as HTML. Nothing
  -- renders it today; the page agent is still given the tokens above so its
  -- copy and structure are written to the brand.
  custom_css text,

  updated_at timestamptz not null default now(),

  constraint brand_colours_are_hex check (
    (colour_primary    is null or colour_primary    ~* '^#[0-9a-f]{6}$') and
    (colour_secondary  is null or colour_secondary  ~* '^#[0-9a-f]{6}$') and
    (colour_accent     is null or colour_accent     ~* '^#[0-9a-f]{6}$') and
    (colour_background is null or colour_background ~* '^#[0-9a-f]{6}$') and
    (colour_text       is null or colour_text       ~* '^#[0-9a-f]{6}$')
  )
);

alter table client_brand_profiles enable row level security;

-- Matches client_contact_details: admin-only. The runtime reads it as
-- service_role, which bypasses RLS.
create policy cbp_admin_all on client_brand_profiles
  for all to authenticated using (is_admin()) with check (is_admin());

create trigger cbp_set_updated_at
  before update on client_brand_profiles
  for each row execute function set_updated_at();

comment on table client_brand_profiles is
  'The visual brand for one client: palette, typography, imagery direction and bans. Fed to both stages of a creative build the same way identity is — quoted verbatim, or its absence stated.';
comment on column client_brand_profiles.custom_css is
  'Stored for when generated pages render as HTML. Nothing consumes it yet.';

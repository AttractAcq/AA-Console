-- The client's own identity, so a generated asset never has to guess it.
--
-- The first live image build invented a practice name, a logo and a WhatsApp
-- number, because the concept could only write a placeholder — nothing in the
-- system held the real values. Banning the invention was the urgent half;
-- this is the other half, so the ban does not simply mean a blank corner
-- forever.
--
-- These live on business context rather than on clients because that is the
-- page an operator fills in when onboarding, and because every agent already
-- reads this row.

alter table client_business_context
  add column contact_phone text,
  add column logo_path text;

comment on column client_business_context.contact_phone is
  'The number that may appear on published creative. Rendered as literal type, so it must be exactly right.';
comment on column client_business_context.logo_path is
  'Storage path in client-media for the client''s logo. Not drawn by the image model — a diffusion model approximates a wordmark, and an approximated logo is still a false mark.';;

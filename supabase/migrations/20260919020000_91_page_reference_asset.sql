-- The ad a page belongs to.
--
-- A recruitment landing page is where a recruitment ad sends someone. The two
-- are one piece of work, and nothing recorded that: an approved Meta static sat
-- in one list and its landing page in another, with no way to say they went
-- together — not for the person building them, and not for the agent writing
-- the page, which had no idea an ad already existed.
--
-- One column rather than a join table. A page has at most one ad it is the
-- destination for; the reverse is not true, but nothing needs the reverse.
--
-- ON DELETE SET NULL, not CASCADE. Deleting an ad must never take a published
-- page down with it — the page may be live and receiving applicants while the
-- creative that pointed at it is being replaced.

alter table client_pages
  add column reference_asset_id uuid references client_media_assets (id) on delete set null;

create index client_pages_reference_asset_idx on client_pages (reference_asset_id)
  where reference_asset_id is not null;

comment on column client_pages.reference_asset_id is
  'The approved creative this page is the destination for. Gives the page agent the ad''s own words so the page matches what the reader just clicked, and records the pairing for whoever runs the campaign.';

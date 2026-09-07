-- Conversion Site Builder: the page as code the console can show.
--
-- client_pages.body held markdown, rendered as plain text in a modal. That is
-- a document, not a page. The console's job here is not to be a website
-- builder — it is to aggregate everything the business knows (context, offer,
-- ICP, brand, identity, cleared proof), hand it to an agent behind one button,
-- and then SHOW what came back: the rendered page, the code behind it, and
-- where it is live.
--
-- So the agent writes real HTML and this is where it lands. body is kept for
-- the two pages that predate it.
--
-- This is also the first consumer of client_brand_profiles.custom_css, which
-- until now was stored and used by nothing.

alter table client_pages
  add column html             text,
  add column meta_title       text,
  add column meta_description text,
  add column built_at         timestamptz;

comment on column client_pages.html is
  'The full page as generated. Rendered in a sandboxed frame in the console, never into the console document itself.';
comment on column client_pages.meta_title is
  'What a search result and a browser tab show. Distinct from title, which is what AA calls this page internally.';
comment on column client_pages.built_at is
  'When the HTML was last generated, so a page edited upstream can be seen to be stale.';

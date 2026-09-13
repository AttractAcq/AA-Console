-- Phase 10.4: where a page is published, and whether it got there.
--
-- client_pages.published_url already existed and was display-only: nothing ever
-- wrote it, and the one populated row in production was set by hand. These
-- columns are what make it a fact rather than a label.
--
-- Deliberately NOT registering site_provision or page_publish in `agents` here.
-- Those runners cannot work until the GitHub App exists, and this codebase has
-- already been bitten once by agents that could be queued and then failed on
-- their first line — creative_build and landing_page were enqueued by every
-- master run for days. An agent that cannot succeed should not be runnable.
-- Registration belongs in the migration that lands the working adapter.

alter table client_pages
  add column site_repository_id uuid references client_site_repositories (id) on delete set null,
  add column site_path          text,
  add column publish_status     text not null default 'unpublished'
                                  check (publish_status in ('unpublished', 'publishing', 'published', 'failed')),
  add column publish_error      text,
  add column published_at       timestamptz,
  add column published_commit   text;

-- One page per path per repository. Two pages publishing to the same path would
-- silently overwrite each other on every alternate publish.
create unique index client_pages_repo_path_uniq
  on client_pages (site_repository_id, site_path)
  where site_repository_id is not null and site_path is not null;

create index client_pages_repo_idx on client_pages (site_repository_id)
  where site_repository_id is not null;

comment on column client_pages.site_path is
  'Path inside the repository, e.g. winter-offer/index.html. Derived from the title, never from user input directly — a raw path could escape its directory or land on the shell.';
comment on column client_pages.publish_status is
  'unpublished, publishing, published or failed. published_url is only meaningful when this is published.';
comment on column client_pages.published_commit is
  'The commit that put this page live, so a published page can be traced to exactly what was committed.';
comment on column client_pages.publish_error is
  'Why the last publish failed, shown to whoever pressed the button. "Publish failed" on its own is unactionable.';

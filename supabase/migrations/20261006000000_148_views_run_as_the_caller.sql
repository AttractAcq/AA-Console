-- Two views were reading past the RLS underneath them.
--
-- A Postgres view runs as its owner unless it is told otherwise. The owner
-- here is the migration role, which is not subject to row level security, so
-- a view over an RLS-protected table hands every row to anyone allowed to
-- select from the view -- regardless of which client the rows belong to.
--
-- Fourteen of the sixteen views in this schema already set security_invoker,
-- so this is the house rule and these two are the exceptions:
--
--   distribution_due     migration 122. Every client's scheduled posts,
--                        readable by any signed-in user. The board happens to
--                        filter by client_id in its query, but a filter in the
--                        application is not a boundary.
--   post_copy_effective  migration 145, mine, shipped today. Same shape: every
--                        client's captions. post_copy has no rows yet, so
--                        nothing has actually been exposed, which is luck
--                        rather than design.
--
-- Found by a test on migration 147: slot_timeline leaked exactly this way and
-- said so. The same test now covers the board and the timeline, and
-- views-run-as-the-caller.test.ts checks every view in the repo so this class
-- cannot come back quietly.
--
-- Nothing in the agent runtime is affected: it connects as service_role, which
-- has BYPASSRLS, so it reads the same rows either way.

alter view distribution_due set (security_invoker = true);
alter view post_copy_effective set (security_invoker = true);

comment on view distribution_due is
  'Distribution still outstanding. state answers "which day" for the board; due_now answers "has the moment passed" for the publisher. Both read the client''s clock, not the server''s. Runs as the caller: RLS on scheduled_posts decides which rows.';

comment on view post_copy_effective is
  'The copy that would actually go out for each scheduled post and platform. Post-level copy overrides the asset-level draft it inherits. Runs as the caller: RLS on post_copy decides which rows.';

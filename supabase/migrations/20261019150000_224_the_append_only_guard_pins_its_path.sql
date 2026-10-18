-- One trigger function from 218 was left without a search_path.
--
-- `guard_proof_placement_event_append_only` raises and does nothing else, so
-- there is no object for a hostile search_path to redirect it to and the
-- practical exposure is nil. It is fixed anyway, for two reasons that are
-- worth more than the risk it carries.
--
-- The first is that Supabase's linter counts it, and a warning somebody has
-- decided to live with is a warning nobody reads. Nine other functions in
-- this database are on that list already, all of them trigger guards from
-- earlier work; this one is ours and arrived last week, so it is the one we
-- can honestly take off it.
--
-- The second is that "it only raises" is true of the body as written today.
-- The next person to add a condition to it inherits the mutable path, and
-- nothing in the file would tell them.
--
-- `alter function ... set` rather than a recreate, so the body is untouched
-- and this cannot drift from what 218 actually created.

alter function public.guard_proof_placement_event_append_only()
  set search_path = pg_catalog, public;

-- An asset cannot be decided without the decision being recorded.
--
-- "Implant consult reel" is approved in production with no row in
-- client_asset_reviews at all. Nobody knows who approved it, when, or why,
-- and nothing prevented it: review_status lives on the asset, the decision
-- log is a separate table, and no rule tied them together. Migration 105
-- made that asset unschedulable, which surfaced the problem without closing
-- the hole that produced it.
--
-- A constraint trigger, deferred to commit, rather than an ordinary one.
-- Both writers — review_media_asset and mcp_internal.approve_asset — update
-- the status first and insert the decision second, so a trigger firing on
-- the statement would refuse the correct path. Deferring to commit checks
-- the invariant at the only moment it is meant to hold.
--
-- The matching decision must be at least as recent as every other decision
-- on that asset. Without that, an asset approved in March and rejected in
-- April could be set back to approved by a direct write, because an old
-- approval row exists.
--
-- Ties pass, and that is a real hole with a measured edge rather than a
-- theoretical one. client_asset_reviews.created_at defaults to now(), which
-- is the TRANSACTION timestamp, so two decisions made inside one transaction
-- are indistinguishable by time and either satisfies the check. Approving
-- and then rejecting in separate transactions — every path the app takes,
-- since each PostgREST call is its own — behaves correctly: tested on
-- staging, the resurrection is refused.
--
-- Closing that edge would mean ordering by something monotonic. id is a
-- random uuid and clock_timestamp() is not what the column defaults to, so
-- the fix is a column change, not a better predicate. Refusing legitimate
-- same-transaction double-decisions to catch a case the app cannot produce
-- is the worse trade.

create or replace function assert_asset_decision_recorded()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  -- Pending is the state an asset starts in and can be returned to. It is
  -- the absence of a decision, so there is nothing to record.
  if new.review_status = 'pending' then
    return null;
  end if;

  if not exists (
    select 1
      from client_asset_reviews r
     where r.asset_id = new.id
       and r.decision = new.review_status
       and r.created_at >= coalesce(
             (select max(r2.created_at) from client_asset_reviews r2 where r2.asset_id = new.id),
             r.created_at)
  ) then
    raise exception
      'Asset % was set to % with no matching decision recorded. Use review_media_asset so the decision, its reason and whoever made it are written down.',
      new.id, new.review_status;
  end if;

  return null;
end;
$$;

create constraint trigger cma_decision_recorded
  after insert or update of review_status on client_media_assets
  deferrable initially deferred
  for each row execute function assert_asset_decision_recorded();

comment on function assert_asset_decision_recorded() is
  'Refuses an asset left approved or rejected with no matching row in client_asset_reviews. Deferred to commit because both writers set the status before inserting the decision.';

-- The asset that prompted this is left exactly as it is. It has no decision
-- to recover, and writing one now would be inventing a person and a date.
-- It is already in approvals_queue and already unschedulable, so a real
-- decision through review_media_asset is what fixes it — and that is now the
-- only way its status can change at all.

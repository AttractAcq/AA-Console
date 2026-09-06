-- Two things about auditing, pulling in opposite directions.
--
-- client_asset_reviews is real: every approve and reject has been recorded
-- since the beginning. But only admins and the client could read it, so the
-- editor or avatar whose work was rejected — the one person who has to act on
-- the reason — could not see it. A rejection reaching the maker as the single
-- word "rejected" is not a review, it is a shrug.
create policy cars_maker_read on client_asset_reviews
  for select to authenticated
  using (
    exists (
      select 1 from client_media_assets a
       where a.id = client_asset_reviews.asset_id
         and a.member_id is not null
         and is_member(a.member_id)
    )
  );

comment on table client_asset_reviews is
  'Every approve/reject decision, with its reason. Readable by an admin, the client, and the person who made the asset.';

-- agent_tool_calls is the opposite: nothing has ever written to it, and
-- nothing ever will. It was built for a tool-audit design the runtime did not
-- end up using — the record agents call exactly one tool, and the only real
-- tool user is the Master AI, which already writes a full audit to
-- master_ai_messages.tool_calls.
--
-- An empty table shaped like an audit trail is worse than no table: it reads
-- as evidence that tool calls are logged, and they are not. Dropping it makes
-- the absence honest.
drop table if exists agent_tool_calls;;

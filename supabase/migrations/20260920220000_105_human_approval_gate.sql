-- "Approved" meant two different things depending on who asked.
--
-- A bot approval (mcp_internal.approve_asset) and a human approval
-- (review_media_asset) both set review_status = 'approved'. schedule_asset
-- checked only that enum, so it accepted either. mcp_internal.get_approval
-- requires client_asset_reviews.reviewed_by to be non-null, so it accepted
-- only the human one.
--
-- The same row was therefore schedulable and still "waiting_for_human" at
-- the same time, and the Distribution assets list showed it as ready to go.
--
-- The stricter reading wins. A bot can move an asset out of the pending
-- queue; distribution is a person's decision. That is the same rule the Meta
-- write path follows — machines prepare, a human commits.
--
-- human_approved_at rather than deriving it from client_asset_reviews on
-- every read: the gate is checked on every schedule and the assets list
-- renders it per row, and a join to the latest review in both places is a
-- rule stored in two queries rather than in the data.

alter table client_media_assets
  add column human_approved_at timestamptz;

comment on column client_media_assets.human_approved_at is
  'When a person approved this asset. Null on anything a bot approved, and on anything approved before decisions were recorded. schedule_asset requires it: review_status says an asset cleared triage, this says a person signed it off.';

create index client_media_assets_human_approved_idx
  on client_media_assets (client_id, human_approved_at)
  where human_approved_at is not null;

-- Backfill from the decision that actually happened. Assets approved by a
-- bot, or approved with no decision row at all, are deliberately left null:
-- there is no human decision to date, and inventing one would put back the
-- ambiguity this column exists to remove.
update client_media_assets a
   set human_approved_at = r.created_at
  from (
    select distinct on (asset_id) asset_id, created_at
      from client_asset_reviews
     where decision = 'approved' and reviewed_by is not null
     order by asset_id, created_at desc
  ) r
 where r.asset_id = a.id
   and a.review_status = 'approved';

create or replace function review_media_asset(
  p_asset_id uuid,
  p_decision review_status,
  p_reason   text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_client uuid;
begin
  select client_id into v_client from client_media_assets where id = p_asset_id;
  if v_client is null then
    raise exception 'Asset not found';
  end if;
  if not can_access_client(v_client) then
    raise exception 'Not permitted for this client';
  end if;
  if p_decision = 'pending' then
    raise exception 'Decision must be approved or rejected';
  end if;

  update client_media_assets
     set review_status = p_decision,
         -- Cleared on rejection, so an asset that was approved and then
         -- rejected does not keep a sign-off it no longer has.
         human_approved_at = case when p_decision = 'approved' then now() else null end
   where id = p_asset_id;

  insert into client_asset_reviews (asset_id, decision, reason, reviewed_by)
  values (p_asset_id, p_decision, p_reason, auth.uid());
end;
$$;

comment on function review_media_asset(uuid, review_status, text) is
  'A person''s decision on an asset. Stamps human_approved_at, which is what distribution requires — a bot approval sets review_status but never this.';

create or replace function schedule_asset(
  p_asset_id uuid,
  p_date     date,
  p_channel  post_channel default 'organic',
  p_platform post_platform default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_client uuid;
  v_status review_status;
  v_human  timestamptz;
  v_id     uuid;
begin
  select client_id, review_status, human_approved_at
    into v_client, v_status, v_human
    from client_media_assets where id = p_asset_id;
  if v_client is null then
    raise exception 'Asset not found';
  end if;
  if not can_access_client(v_client) then
    raise exception 'Not permitted for this client';
  end if;
  if v_status <> 'approved' then
    raise exception 'Asset must be approved before it can be scheduled';
  end if;
  -- The distinction the old check could not make. An asset a bot moved out
  -- of the queue reads as approved and has nobody's name on it.
  if v_human is null then
    raise exception 'That asset has not been approved by a person yet. Approve it in Approvals before scheduling it.';
  end if;

  insert into scheduled_posts (asset_id, scheduled_for, channel, platform, created_by)
  values (p_asset_id, p_date, p_channel, p_platform, auth.uid())
  returning id into v_id;
  return v_id;
end;
$$;

revoke execute on function schedule_asset(uuid, date, post_channel, post_platform) from public, anon;
grant execute on function schedule_asset(uuid, date, post_channel, post_platform) to authenticated;

comment on function schedule_asset(uuid, date, post_channel, post_platform) is
  'Schedules an asset a person has approved. Refuses anything not through the review gate, and anything only a bot has signed off.';

-- An asset a bot approved is in neither queue otherwise: Approvals shows
-- pending, Distribution shows human-approved, and it is neither.
--
-- Dropped and recreated rather than replaced. `a.*` now expands to one more
-- column, which shifts client_name and brief_title, and create-or-replace
-- refuses to renumber a view's output. Spelling the columns out instead was
-- worse: the list would have to match whatever that table looks like in the
-- environment being migrated, and staging and production do not agree.
--
-- The grants are reissued exactly as they stood, because dropping a view
-- takes them with it and this one is read by the Master AI. RLS on
-- client_media_assets plus security_invoker is what actually restricts it;
-- the grants are Supabase's schema defaults and are restored, not widened.
drop view if exists approvals_queue;

create view approvals_queue as
select a.*, c.name as client_name, b.title as brief_title
from client_media_assets a
join clients c on c.id = a.client_id
left join client_briefs b on b.id = a.brief_id
where a.review_status = 'pending'
   or (a.review_status = 'approved' and a.human_approved_at is null);

alter view approvals_queue set (security_invoker = on);
grant all on approvals_queue to anon, authenticated, service_role;

comment on view approvals_queue is
  'Everything still needing a person''s decision: pending, plus anything a bot approved that no human has signed off.';

-- The queue has to show the broken rows, not drop them.
--
-- 122 joined scheduled_posts to client_media_assets and hid a row the
-- moment it mattered most. One of the three overdue posts has no asset at
-- all: asset_id is nullable with ON DELETE SET NULL, so deleting an asset
-- leaves its schedule behind pointing at nothing. Five such rows exist.
--
-- A scheduled post with no asset can never be published. It is the single
-- most broken thing that can be in a distribution queue, and an inner join
-- made it the one thing the queue would not mention — the exact failure
-- this view was written to stop, reproduced inside the view itself.
--
-- So: left join, and a state that says so. An orphaned row sorts to the top
-- rather than quietly leaving the count.
--
-- Not fixed here: the nullable asset_id and its SET NULL rule. Making it
-- CASCADE would mean deleting an asset silently unschedules it, and making
-- it NOT NULL needs the five existing rows resolved first. Both are
-- decisions about what deleting an asset should mean, which is a question
-- for a person and not a thing to slip into a view migration.

create or replace view distribution_due
with (security_invoker = on)
as
select
  sp.client_id,
  sp.id            as schedule_id,
  sp.asset_id,
  sp.ref_number,
  sp.scheduled_for,
  sp.channel::text as channel,
  sp.platform::text as platform,
  sp.media_type::text as media_type,
  a.title          as asset_title,
  a.content_format::text as content_format,
  -- 'orphaned' first: it is not late, it is impossible, and no amount of
  -- waiting changes that.
  case
    when sp.asset_id is null or a.id is null then 'orphaned'
    when sp.scheduled_for < current_date      then 'overdue'
    when sp.scheduled_for = current_date      then 'due_today'
    else 'upcoming'
  end as state,
  greatest(current_date - sp.scheduled_for, 0) as days_late,
  -- False for an orphan, which is the truthful answer: there is no asset,
  -- so nobody approved one.
  coalesce(a.human_approved_at is not null, false) as human_approved
from scheduled_posts sp
left join client_media_assets a on a.id = sp.asset_id
where sp.publication_status = 'scheduled'
  and sp.published_at is null;

comment on view distribution_due is
  'Distribution work still outstanding: what is due, what is late, and what can never be published because its asset was deleted. Read by the distribution bot to know what to publish and by the console to stop calling an overdue post "Scheduled". Changes nothing — an overdue post keeps its date and waits for a person.';

grant select on distribution_due to authenticated;

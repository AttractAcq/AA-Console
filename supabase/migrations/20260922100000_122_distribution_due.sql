-- What is due, and what is late.
--
-- Nothing in this system computed either. No function anywhere compared
-- scheduled_for to now(), and nothing in the three codebases flagged a post
-- whose date had passed. Three posts sat overdue for nineteen days in
-- silence, and the Distribution board went on calling them "Scheduled",
-- because it renders published_at ? "Published" : "Scheduled" and an
-- unpublished post has no third state to fall into.
--
-- Two readers need this, and they need the same answer:
--
--   the distribution bot, which can queue_distribution and
--   record_publication but has never been able to ask what it should
--   publish now; and
--
--   whoever is looking at the board, who should not have to compare dates
--   in their head to notice that nothing has gone out since the third.
--
-- WHAT THIS DOES NOT DO
--
-- It changes nothing. An overdue post stays scheduled, keeps its date, and
-- waits. Marking it missed or rolling it forward are both defensible and
-- both move state without a person deciding to — the opposite of the rule
-- the rest of this system follows, where machines prepare and people
-- commit. A view states the facts and lets somebody act on them.
--
-- Published and failed posts are out of scope by definition: this is a
-- queue of work outstanding, not a history.

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
  -- The state the board should show instead of a flat "Scheduled".
  case
    when sp.scheduled_for < current_date then 'overdue'
    when sp.scheduled_for = current_date then 'due_today'
    else 'upcoming'
  end as state,
  -- Zero for anything not yet late, so callers can sort and filter on one
  -- number without a case of their own.
  greatest(current_date - sp.scheduled_for, 0) as days_late,
  -- The human gate, carried through. A post whose asset was never approved
  -- by a person must not be published even when its date has passed, and
  -- the bot reading this queue is exactly who would otherwise do it.
  a.human_approved_at is not null as human_approved
from scheduled_posts sp
join client_media_assets a on a.id = sp.asset_id
where sp.publication_status = 'scheduled'
  and sp.published_at is null;

comment on view distribution_due is
  'Distribution work still outstanding, with how late each piece is. Read by the distribution bot to know what to publish and by the console to stop calling an overdue post "Scheduled". Changes nothing: an overdue post keeps its date and waits for a person.';

grant select on distribution_due to authenticated;

create index if not exists scheduled_posts_outstanding_idx
  on scheduled_posts (client_id, scheduled_for)
  where publication_status = 'scheduled' and published_at is null;

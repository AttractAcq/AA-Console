-- One row per archived piece of work, keyed the way the archive is read.
--
-- brief_ref, not the asset's ref_number. The two are different numbers off
-- the same counter — the smoke-test carousel burned AA-0066 for its brief
-- and AA-0067 for its asset — and only brief_ref spans the whole chain:
-- content_attribution is already keyed on it, and one brief_ref covered both
-- AA-0067 and AA-0068 when frame three was rebuilt. An archive keyed on the
-- asset ref would file one piece of work twice and have nowhere to put the
-- idea.
--
-- A view rather than a table, like content_attribution and approvals_queue
-- beside it. The archive is a reading of the records, not a copy of them;
-- a copy is a second source of truth that starts drifting the first time
-- somebody edits a title.
--
-- security_invoker so RLS is the caller's, matching every other view here.

create or replace view content_archive
with (security_invoker = on)
as
select
  b.client_id,
  b.brief_ref,
  b.id                as brief_id,
  b.title,
  b.media_type,
  b.content_format,
  b.archived_at,
  b.source_idea_id    as idea_id,
  i.title             as idea_title,
  i.content_territory,
  i.pillar_id,
  p.name              as pillar_name,
  b.frame_count,

  -- How far down the chain this piece actually got. Read off the records,
  -- so a piece that was scheduled and never published says so.
  (select count(*) from client_media_assets a where a.brief_id = b.id)            as assets,
  (select count(*) from client_media_assets a
     where a.brief_id = b.id and a.review_status = 'approved')                    as approved_assets,
  (select count(*) from scheduled_posts sp
     join client_media_assets a on a.id = sp.asset_id
    where a.brief_id = b.id)                                                      as scheduled,
  (select count(*) from scheduled_posts sp
     join client_media_assets a on a.id = sp.asset_id
    where a.brief_id = b.id and sp.published_at is not null)                      as published,
  -- Every regeneration is an iteration: a generation carrying an account of
  -- what was wrong with the one before it.
  (select count(*) from creative_generations g
     where g.brief_id = b.id and g.remake_feedback is not null)                   as iterations,
  (select min(sp.published_at) from scheduled_posts sp
     join client_media_assets a on a.id = sp.asset_id
    where a.brief_id = b.id and sp.published_at is not null)                      as first_published

from client_briefs b
left join client_ideas i          on i.id = b.source_idea_id
left join client_content_pillars p on p.id = i.pillar_id
where b.archived_at is not null;

comment on view content_archive is
  'One row per archived piece of content production, keyed on brief_ref because that is the reference that spans the whole chain — idea, brief, every asset built from it, and its attribution. Counts say how far each piece actually got.';

grant select on content_archive to authenticated;

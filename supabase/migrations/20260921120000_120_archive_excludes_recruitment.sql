-- The content production archive holds content production.
--
-- 119 filtered on archived_at and nothing else, so it picked up seven
-- recruitment briefs — hiring ads for editors, avatars and an SMM. Those are
-- Team work. They have never appeared on the Briefs page, which excludes
-- them explicitly, so the archive was showing finished work from a list that
-- never held it.
--
-- An archive that contains things its own active list never showed is not an
-- archive of that list. The view now mirrors the filter the Briefs page
-- applies, and the two say the same thing about what content production is.
--
-- Recruitment is not lost. The briefs are untouched and still read from Team
-- → Recruitment; when that side wants an archive it gets its own, keyed the
-- way recruitment is keyed rather than borrowed from here.

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
  (select count(*) from client_media_assets a where a.brief_id = b.id)            as assets,
  (select count(*) from client_media_assets a
     where a.brief_id = b.id and a.review_status = 'approved')                    as approved_assets,
  (select count(*) from scheduled_posts sp
     join client_media_assets a on a.id = sp.asset_id
    where a.brief_id = b.id)                                                      as scheduled,
  (select count(*) from scheduled_posts sp
     join client_media_assets a on a.id = sp.asset_id
    where a.brief_id = b.id and sp.published_at is not null)                      as published,
  (select count(*) from creative_generations g
     where g.brief_id = b.id and g.remake_feedback is not null)                   as iterations,
  (select min(sp.published_at) from scheduled_posts sp
     join client_media_assets a on a.id = sp.asset_id
    where a.brief_id = b.id and sp.published_at is not null)                      as first_published
from client_briefs b
left join client_ideas i          on i.id = b.source_idea_id
left join client_content_pillars p on p.id = i.pillar_id
where b.archived_at is not null
  -- The same exclusion the Briefs page makes. A hiring ad is not this
  -- client's content production.
  and b.purpose = 'client';

comment on view content_archive is
  'One row per archived piece of content production, keyed on brief_ref because that is the reference that spans the whole chain — idea, brief, every asset built from it, and its attribution. Recruitment briefs are excluded, matching the Briefs page they never appear on.';

grant select on content_archive to authenticated;

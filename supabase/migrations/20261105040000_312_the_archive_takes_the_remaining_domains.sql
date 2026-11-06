-- v6.1 / Phase 5 item 16: the archive takes market opportunities, the
-- intelligence and strategy models, lead magnets, and rejected creative.
--
-- Migration 121 built this pattern for pages, campaigns and sales agents, and
-- its comment left the door open: "The other three domains get their own tabs
-- here as they are brought over." This brings the rest over, in the same shape,
-- so the archive page keeps reading every domain with one component.
--
-- TWO TABLES NEED THE STAMP; TWO ALREADY HAVE IT
--
-- lead_magnets and client_media_assets already carry archived_at.
-- market_opportunities and client_agent_records do not, and get it here, with
-- 121's reasoning unchanged: nothing promotes these, so nothing can infer that
-- they are finished. An opportunity that was not pursued this quarter is not a
-- dead opportunity, and a money model nobody has opened in a month is not a
-- retired one. The person who decides is the only one who knows.
--
-- THE ONE THAT IS NOT ARCHIVED BY HAND
--
-- Rejected creative is different, and the notes say why: "Rejected assets land
-- here with their rejection note, so the what-worked trend becomes visible."
-- The point is the trend, and a trend built only from rejections somebody also
-- remembered to archive is not a trend -- it is a record of who tidied up.
--
-- So rejected_assets_archive filters on review_status = 'rejected' rather than
-- on archived_at. The rejection IS the filing decision. Its archived_at is the
-- moment of rejection, taken from the review that rejected it, so the existing
-- panel orders and dates it correctly with no change.
--
-- That also means a rejected asset has nothing to restore: un-rejecting is a
-- review decision, made with review_media_asset where the seat rules and the
-- video sign-off chain live, not a restore button on a filing page. The panel
-- is given a way to say so rather than offering an action that would not work.
--
-- The note itself comes from client_asset_reviews, which review_media_asset has
-- always written -- it takes p_reason and stores it there. The reason was
-- already being kept; nothing could read it back.

alter table market_opportunities  add column archived_at timestamptz;
alter table client_agent_records  add column archived_at timestamptz;

comment on column market_opportunities.archived_at is
  'When this opportunity was archived by hand. Nothing infers it: an opportunity not pursued this quarter is not a dead one.';
comment on column client_agent_records.archived_at is
  'When this record was archived by hand. A model nobody has opened recently is not a retired model.';

-- Matching the shape each working list actually queries, so the active lists
-- stay on an index once they carry the filter.
create index market_opportunities_active_idx
  on market_opportunities (client_id, created_at desc) where archived_at is null;
create index client_agent_records_active_idx
  on client_agent_records (client_id, domain, display_order) where archived_at is null;

-- ---------------------------------------------------------------------------
-- One row per archived thing, per domain, in 121's column shape:
-- client_id, id, title, kind, status, ..., archived_at, created_at, metric.

create or replace view opportunities_archive
with (security_invoker = on)
as
select
  o.client_id,
  o.id,
  o.name                                            as title,
  coalesce(o.micro_market, 'none')                  as kind,
  o.status::text                                    as status,
  o.core_problem,
  o.desired_outcome,
  o.confidence::text                                as confidence,
  o.status_note,
  o.archived_at,
  o.created_at,
  -- The score it was last given, which is the thing you want from a shelved
  -- opportunity: not that it was shelved, but what it was judged to be worth.
  (select s.total from opportunity_scores s
     where s.opportunity_id = o.id order by s.scored_at desc limit 1) as score
from market_opportunities o
where o.archived_at is not null;

comment on view opportunities_archive is
  'Archived market opportunities, each with the score it was last given -- what it was judged to be worth, not merely that it was shelved.';

create or replace view agent_models_archive
with (security_invoker = on)
as
select
  r.client_id,
  r.id,
  coalesce(nullif(btrim(r.title), ''), r.item_key)  as title,
  r.domain::text                                    as kind,
  coalesce(r.status::text, 'none')                   as status,
  r.item_key,
  r.period,
  r.edited_at,
  r.archived_at,
  r.created_at,
  -- How substantial the model was. A one-line ICP and a worked-through one are
  -- different things to find in an archive, and nothing else here says which.
  case
    when nullif(btrim(coalesce(r.body, '')), '') is null then 0
    else coalesce(array_length(regexp_split_to_array(btrim(r.body), '\s+'), 1), 0)
  end                                               as words
from client_agent_records r
where r.archived_at is not null;

comment on view agent_models_archive is
  'Archived intelligence and strategy records -- ICP, competitors, market, proof, campaign intel, brand and offer strategy, money model, reporting -- with a word count, because a gestured-at model and a worked-through one are different things to find later.';

create or replace view lead_magnets_archive
with (security_invoker = on)
as
select
  m.client_id,
  m.id,
  m.name                                            as title,
  coalesce(m.format::text, 'none')                   as kind,
  case when m.archived_at is null then 'active' else 'archived' end as status,
  m.objective,
  m.audience,
  m.campaign_id,
  m.archived_at,
  m.created_at,
  (select count(*) from lead_magnet_versions v where v.magnet_id = m.id) as versions
from lead_magnets m
where m.archived_at is not null;

comment on view lead_magnets_archive is
  'Archived lead magnets, with how many versions each went through.';

create or replace view rejected_assets_archive
with (security_invoker = on)
as
select
  a.client_id,
  a.id,
  coalesce(nullif(btrim(a.title), ''), 'Asset ' || coalesce(a.ref_number::text, '?')) as title,
  a.media_type::text                                as kind,
  a.review_status::text                             as status,
  a.purpose,
  a.content_format::text                            as content_format,
  a.brief_id,
  -- The note, which is the whole point of this domain. The latest rejecting
  -- review wins: an asset reworked and rejected again should show why it was
  -- rejected THIS time.
  (select v.reason from client_asset_reviews v
     where v.asset_id = a.id and v.decision = 'rejected'
     order by v.created_at desc limit 1)            as rejection_note,
  -- Filed at the moment of rejection, not when somebody tidied up, so the
  -- archive page's ordering and date column need no special case.
  (select v.created_at from client_asset_reviews v
     where v.asset_id = a.id and v.decision = 'rejected'
     order by v.created_at desc limit 1)            as archived_at,
  a.created_at,
  -- How many times it was looked at before being turned down. An asset
  -- rejected on the third review is a different story from one rejected flat.
  (select count(*) from client_asset_reviews v where v.asset_id = a.id) as reviews
from client_media_assets a
where a.review_status = 'rejected';

comment on view rejected_assets_archive is
  'Rejected creative with the reason it was rejected, so the what-worked trend is visible. Filtered on review_status, not archived_at: the rejection is the filing decision, and a trend built only from rejections somebody also archived is a record of who tidied up.';

grant select on opportunities_archive, agent_models_archive,
                lead_magnets_archive, rejected_assets_archive to authenticated;

select lock_down_definer_functions();

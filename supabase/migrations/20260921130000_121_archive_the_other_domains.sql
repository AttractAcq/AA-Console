-- Archiving for pages, campaigns and sales agents.
--
-- Same stamp as content production, and deliberately the same column name,
-- because the archive reads four domains the same way and a column called
-- something different in each is four special cases in every query that
-- touches them.
--
-- WHAT IS DIFFERENT HERE: NOTHING PROMOTES THESE.
--
-- Content production has a promotion to hang the stamp on — an idea has a
-- brief, a brief has an asset — so archiving is automatic and a trigger
-- fires on the fact. A campaign has no successor record that means "this is
-- finished", and neither does a page or a sales agent. Inferring it would
-- mean guessing: an end date that passed while the campaign was paused is
-- not a finished campaign, and a sales agent taken off live is usually being
-- edited rather than retired.
--
-- So these three are archived by hand, which is what was asked for, and the
-- honest answer regardless: the person who decides a campaign is over is the
-- only one who knows.
--
-- Reversible, like the agents registry it follows. archived_at back to null
-- and it is in the working list again. Nothing is deleted and nothing is
-- copied, so unarchiving costs nothing and loses nothing.

alter table client_pages       add column archived_at timestamptz;
alter table client_campaigns   add column archived_at timestamptz;
alter table client_sales_agents add column archived_at timestamptz;

comment on column client_pages.archived_at is
  'When this page was archived by hand. Hidden from the Pages list, unchanged and still published if it was published — archiving is a filing decision, not an unpublish.';
comment on column client_campaigns.archived_at is
  'When this campaign was archived by hand. Nothing infers it: an end date that passed while the campaign was paused is not a finished campaign.';
comment on column client_sales_agents.archived_at is
  'When this agent was archived by hand. Being taken off live is not archiving — that is usually an edit in progress.';

create index client_pages_active_idx on client_pages (client_id, page_type, created_at desc)
  where archived_at is null;
create index client_campaigns_active_idx on client_campaigns (client_id, created_at desc)
  where archived_at is null;
create index client_sales_agents_active_idx on client_sales_agents (client_id, created_at desc)
  where archived_at is null;

-- ---------------------------------------------------------------------------
-- One row per archived thing, per domain, shaped the same way so the archive
-- page reads them with one component rather than three.
--
-- A page that is archived while still published says so, because "archived"
-- and "off the internet" are different facts and conflating them is how
-- somebody unpublishes a live page by tidying up.

create or replace view pages_archive
with (security_invoker = on)
as
select
  p.client_id,
  p.id,
  p.title,
  p.page_type::text                                as kind,
  p.status::text                                   as status,
  p.published_url,
  p.publish_status::text                           as publish_status,
  p.published_at is not null                       as was_published,
  p.archived_at,
  p.created_at,
  (select count(*) from client_page_revisions r where r.page_id = p.id) as revisions
from client_pages p
where p.archived_at is not null;

comment on view pages_archive is
  'Archived pages. was_published is kept separate from archived_at on purpose: archiving files a page away, it does not take it off the internet.';

create or replace view campaigns_archive
with (security_invoker = on)
as
select
  c.client_id,
  c.id,
  c.name                                           as title,
  coalesce(c.template::text, 'none')                     as kind,
  c.status::text                                   as status,
  c.objective,
  c.starts_on,
  c.ends_on,
  c.budget,
  c.launched_at,
  c.archived_at,
  c.created_at,
  (select count(*) from client_ideas i where i.campaign_id = c.id) as pieces
from client_campaigns c
where c.archived_at is not null;

comment on view campaigns_archive is
  'Archived campaigns, with the count of content planned under each so a finished campaign still answers what it produced.';

create or replace view sales_agents_archive
with (security_invoker = on)
as
select
  s.client_id,
  s.id,
  s.name                                           as title,
  coalesce(s.role::text, 'none')                         as kind,
  s.status::text                                   as status,
  s.purpose,
  s.approved_at,
  s.archived_at,
  s.created_at,
  (select count(*) from sales_agent_conversations v where v.sales_agent_id = s.id) as conversations
from client_sales_agents s
where s.archived_at is not null;

comment on view sales_agents_archive is
  'Archived sales agents, with the count of conversations each handled — the thing you actually want from a retired agent.';

grant select on pages_archive, campaigns_archive, sales_agents_archive to authenticated;

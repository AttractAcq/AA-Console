-- Which campaign built the pool this one spends.
--
-- A retargeting campaign can only be as big as whatever fills its audience.
-- R1 spends what P1 and P4 build, and nothing recorded that relationship, so
-- the rule lived in a sentence on the template and in whoever remembered it.
--
-- One column, not a join table. A campaign spends one pool; several campaigns
-- may spend the same one, and the reverse is what the index is for.
--
-- ON DELETE SET NULL. Deleting the campaign that built a pool must not delete
-- the campaign spending it — the pool itself lives at Meta and outlives our
-- record of who filled it.

alter table client_campaigns
  add column feeds_from_campaign_id uuid
    references client_campaigns (id) on delete set null,
  add constraint client_campaigns_feeds_from_not_self
    check (feeds_from_campaign_id is null or feeds_from_campaign_id <> id);

create index client_campaigns_feeds_from_idx
  on client_campaigns (feeds_from_campaign_id)
  where feeds_from_campaign_id is not null;

comment on column client_campaigns.feeds_from_campaign_id is
  'The campaign whose audience this one spends. Set on a retargeting or lookalike campaign to name the build campaign that fills it. Null on a campaign that makes its own audience.';

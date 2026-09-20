-- What we built in the ad account, so we can find it again.
--
-- Without these, pressing Build twice creates a second campaign, a second ad
-- set and a second set of ads in the account, and nothing can tell that the
-- first press succeeded. The structure would be duplicated in silence and the
-- budget doubled the moment somebody launched both.
--
-- They also close the loop on reporting. The metrics connector already reads
-- Ads Insights by campaign_id; until that id is written down next to our own
-- campaign, spend comes back attached to a number nothing in the console
-- recognises.
--
-- Text, not uuid. Meta's ids are its own numeric strings and are not ours to
-- generate. Nullable throughout: a campaign that has not been built has no
-- ids, and that is the normal state, not a missing value.

alter table client_campaigns
  add column meta_campaign_id text,
  add column meta_ad_set_id   text,
  add column meta_built_at    timestamptz;

-- One console campaign owns one Meta campaign. A second row claiming the same
-- id means a build ran twice and wrote both, which is the thing these columns
-- exist to prevent.
create unique index client_campaigns_meta_campaign_idx
  on client_campaigns (meta_campaign_id)
  where meta_campaign_id is not null;

comment on column client_campaigns.meta_campaign_id is
  'The Meta campaign this was built as. Unique: one console campaign owns one Meta campaign.';
comment on column client_campaigns.meta_ad_set_id is
  'The ad set built under it. One for now; a campaign testing two audiences will need its own table.';
comment on column client_campaigns.meta_built_at is
  'When the structure was created in the ad account. Not when it went live — launching is a person in Ads Manager, and first spend against meta_campaign_id is what shows that happened.';

alter table client_media_assets
  add column meta_creative_id text,
  add column meta_ad_id       text;

create unique index client_media_assets_meta_ad_idx
  on client_media_assets (meta_ad_id)
  where meta_ad_id is not null;

comment on column client_media_assets.meta_creative_id is
  'The ad creative built from this asset and its copy.';
comment on column client_media_assets.meta_ad_id is
  'The ad carrying that creative. Unique: building twice must not leave two ads pointing at one asset.';

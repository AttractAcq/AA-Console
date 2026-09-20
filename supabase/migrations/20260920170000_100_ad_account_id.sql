-- The ad account id, in a column of its own.
--
-- credential_label has been doing two jobs: it is part of the uniqueness key
-- for an integration, and for paid Meta it also holds the act_<id> the
-- metrics connector reads. That is workable for reading insights, where a
-- wrong value returns nothing and somebody notices an empty report.
--
-- It is not workable for writing. A campaign created against a mistyped
-- act_<id> is a campaign in somebody else's ad account, and the failure is
-- silent: Meta accepts it if the token has access, and nothing in our records
-- disagrees. A label that is also a destination for money wants a column that
-- says so, and a constraint that rejects anything not shaped like an account.
--
-- Backfilled from credential_label only where it already looks like an ad
-- account id. A label that is a human name — "Main account", "Practice page"
-- — is left alone rather than guessed at.

alter table client_integrations
  add column ad_account_id text
    constraint client_integrations_ad_account_shape
      check (ad_account_id is null or ad_account_id ~ '^act_[0-9]+$');

update client_integrations
   set ad_account_id = credential_label
 where provider = 'meta'
   and credential_label ~ '^act_[0-9]+$';

comment on column client_integrations.ad_account_id is
  'The Meta ad account this client''s paid work runs in, as act_<id>. Money is created against this, so it is shaped-checked rather than trusted. credential_label stays the human name and part of the uniqueness key.';

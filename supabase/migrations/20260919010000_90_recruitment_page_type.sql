-- A third kind of page: the one a hiring ad points at.
--
-- page_type has been ('landing','offer') since migration 01 — the two kinds a
-- paying client needs. A recruitment ad needs somewhere to send an applicant,
-- and that page is neither: it is not a client's landing page and not a
-- secondary offer, it belongs to Attract Acquisition itself, and it must never
-- appear in a client's Page Builder.
--
-- Adding a value rather than reusing 'landing' is what keeps those lists
-- separate. A recruitment page filed as 'landing' on the house client would
-- surface in AA's own Page Builder alongside real marketing pages, and the
-- first person to publish one to a client site would have no warning.
--
-- ALTER TYPE ... ADD VALUE is allowed inside a transaction on PG12+, but the
-- new value cannot be USED in the same transaction. Nothing here uses it.

alter type page_type add value if not exists 'recruitment';

comment on type page_type is
  'landing and offer are client pages, built from a campaign. recruitment is a hiring page on the Attract Acquisition house client — it is what an applicant lands on after a recruitment ad, and it is deliberately kept out of client Page Builder lists.';

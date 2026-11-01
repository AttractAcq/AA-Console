-- v6.1 / 1.1: an offer is the business's own, or a micro-niche's.
--
-- The notes: "A main offer is just the offer of the business, whereas the
-- secondary offer is a specific campaign offer for a specific ICP and micro
-- niche. Created in the same way but with different inputs to target the micro
-- niche specifically." And the page gets "two buttons, one to create a main
-- offer and one to create a secondary offer".
--
-- `service_offers` holds id, client_id, service_name and created_at, and
-- nothing distinguishes the two. So the two buttons had nothing to write.
--
-- WHY A COLUMN AND NOT A DERIVED ANSWER
--
-- "Secondary" could be inferred from an opportunity_links row with role
-- 'offer': an offer with a micro-niche is a secondary one. That was tempting,
-- because inventing a second place to record one fact is exactly the mistake
-- 302 made and undid with market_opportunity_id.
--
-- It is not the same case. The link records *which* niche an offer targets;
-- the kind records *what the offer is*, which is knowable at creation, before
-- any niche is chosen, and stays true for a draft that has no link yet.
-- Deriving it would also make a main offer indistinguishable from a secondary
-- one nobody has linked, and the two have different inputs and different
-- compile sources -- offer strategy for the first, the opportunity for the
-- second.
--
-- The invariant between them is stated here and enforced by the migration that
-- introduces the writer, the same way 302 added the idea's route and left the
-- guards to the migration with the tests: a main offer should never hold an
-- opportunity link with role 'offer'.
--
-- NOTHING TO BACKFILL
--
-- There are zero rows in service_offers, service_offer_versions and
-- service_offer_signoffs, and opportunity_links holds no 'offer' rows at all.
-- Offer Studio has never been used. So the default is a free choice rather
-- than a migration of existing meaning, and 'main' is the safe one: it is the
-- offer that needs no niche.

alter table public.service_offers
  add column kind text not null default 'main'
    check (kind in ('main', 'secondary'));

comment on column public.service_offers.kind is
  'main is the business''s own offer, compiled from offer strategy. secondary targets one micro-niche, compiled from that market opportunity. A secondary offer is expected to carry an opportunity_links row with role ''offer'' naming the niche; a main offer never should.';

-- The page lists offers of both kinds together and filters, so the kind is
-- read on every row.
create index service_offers_client_kind_idx
  on public.service_offers (client_id, kind, created_at desc);

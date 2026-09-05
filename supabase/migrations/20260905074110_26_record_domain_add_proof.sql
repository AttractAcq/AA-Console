-- ============================================================
-- AA Console · 26 · Proof Intelligence domain
--
-- Separate migration because Postgres forbids USING a new enum value in
-- the transaction that creates it — the templates that reference 'proof'
-- have to land in the next one.
--
-- Note this is distinct from the Proof Bank. The Proof Bank stores actual
-- proof assets (testimonials, results, files). Proof Intelligence analyses
-- what proof the business has, what makes it unique, and what it does
-- daily that could BECOME proof. One is the evidence; this is the
-- assessment of it.
-- ============================================================

alter type record_domain add value if not exists 'proof' after 'market';;

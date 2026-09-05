-- ============================================================
-- AA Console · 22 · Make the records constraint upsert-safe
--
-- unique (client_id, domain, item_key, period) treats NULLs as distinct,
-- so every domain except campaign_intel — all of which leave period NULL —
-- could accumulate duplicate rows for the same item_key, and ON CONFLICT
-- would never match. NULLS NOT DISTINCT is what makes the agent's upsert
-- actually update.
-- ============================================================

alter table client_agent_records
  drop constraint if exists client_agent_records_client_id_domain_item_key_period_key;

alter table client_agent_records
  add constraint client_agent_records_client_domain_item_period_key
  unique nulls not distinct (client_id, domain, item_key, period);;

-- Archiving a model section must leave its old version intact while letting
-- a later agent run or human edit create a fresh active section with the same
-- template key. Only active sections must be unique.
alter table public.client_agent_records
  drop constraint client_agent_records_client_domain_item_period_key;
create unique index client_agent_records_active_version_key_v8
  on public.client_agent_records (client_id,domain,item_key,period) nulls not distinct
  where archived_at is null;

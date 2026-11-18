-- Read-only preflight before migration 580. Run with cross-client read access.
-- A scoped identity reporting zero cannot establish that all links are safe.
select count(*) as existing_links,
  count(*) filter (where c.id is null) as missing_or_cross_client_setups,
  count(*) filter (where l.submissions > 0) as links_with_submissions,
  count(*) filter (where l.revoked_at is null and l.expires_at > now()
    and l.submissions < l.max_submissions) as currently_usable_links
from public.proof_capture_links l
left join public.proof_capture_configs c
  on c.id=l.config_id and c.client_id=l.client_id;

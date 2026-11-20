-- 655 · Revoke signed-in EXECUTE on link_delivery_current_source_v6.
--
-- The function is security definer and inserts a lineage link. Its body
-- does not check the caller. Supabase's default privileges grant EXECUTE
-- to authenticated. Migration 320's lock_down_definer_functions() takes
-- EXECUTE from PUBLIC and anon only, so a signed-in user could still call
-- it. This migration revokes authenticated as well, and revokes PUBLIC and
-- anon again in case either grant is still present.
--
-- Triggers that call it are security definer and run as the owner, so they
-- do not need the authenticated grant. service_role keeps EXECUTE. The
-- owner (postgres) is not revoked.
--
-- Not applied to staging or production by this change.

revoke execute on function public.link_delivery_current_source_v6(
  public.delivery_entity_versions_v6, text, text, text)
  from public, anon, authenticated;

grant execute on function public.link_delivery_current_source_v6(
  public.delivery_entity_versions_v6, text, text, text)
  to service_role;

select public.lock_down_definer_functions();

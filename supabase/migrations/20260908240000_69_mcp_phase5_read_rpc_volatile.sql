-- Phase 5 hotfix: lock read RPCs as VOLATILE.
--
-- require_bot_client_grant does SELECT … FOR SHARE on mcp_bot_clients.
-- PostgREST runs STABLE RPCs in a read-only transaction, which rejects
-- FOR SHARE (500: cannot execute SELECT FOR SHARE in a read-only transaction).
--
-- Prod (bancbdztffokwiifzoiv) and staging (vmmertwoboqiazcsougw) already
-- have these ALTER … VOLATILE applied live. This migration is source lock-in
-- so future deploys / new environments match. Idempotent: re-running ALTER
-- VOLATILE is a no-op when the function is already volatile.
--
-- Do not change require_bot_client_grant FOR SHARE (writes still need it).
-- No auth/RLS weakening. No can_access_client. No token changes.

alter function mcp_internal.list_ideas(text, uuid, integer, text) volatile;
alter function mcp_internal.get_idea(text, uuid, uuid) volatile;
alter function mcp_internal.get_brief(text, uuid, uuid, uuid) volatile;
alter function mcp_internal.get_production_status(text, uuid, uuid, uuid, uuid) volatile;
alter function public.mcp_list_ideas(text, uuid, integer, text) volatile;
alter function public.mcp_get_idea(text, uuid, uuid) volatile;
alter function public.mcp_get_brief(text, uuid, uuid, uuid) volatile;
alter function public.mcp_get_production_status(text, uuid, uuid, uuid, uuid) volatile;

-- Migration 44 revoked EXECUTE from anon and changed nothing, because
-- functions grant EXECUTE to PUBLIC by default and anon inherits it.
-- Revoking from a role that never held its own grant is a no-op.
--
-- The working form is: drop the PUBLIC grant, then grant back explicitly to
-- the roles that need it. This is what migration 10 did for every other
-- internal function.
revoke execute on function is_channel_member(uuid) from public, anon;
grant execute on function is_channel_member(uuid) to authenticated, service_role;;

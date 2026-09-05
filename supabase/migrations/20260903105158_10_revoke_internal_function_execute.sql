-- ============================================================
-- AA Console · 10 · Close the last of the RPC surface
--
-- Supabase's default privileges grant EXECUTE to `authenticated`
-- explicitly, so migration 09's `revoke ... from anon, public` left
-- these reachable. Trigger and event-trigger functions do not need
-- EXECUTE to fire, and internal helpers are only ever called from
-- inside other SECURITY DEFINER functions.
-- ============================================================

revoke execute on function assign_ref_number()              from authenticated;
revoke execute on function sync_scheduled_post_from_asset() from authenticated;
revoke execute on function handle_new_user()                from authenticated;
revoke execute on function next_ref_number(uuid)            from authenticated;
revoke execute on function rls_auto_enable()                from authenticated;

-- Everything still flagged after this is deliberate:
--   is_admin, current_role_of, can_access_client, is_member,
--   current_member_id  -> evaluated inside RLS policy expressions,
--                         so `authenticated` MUST be able to run them
--   accessible_client_ids, can_run_agent
--                      -> read helpers the UI calls to scope lists and
--                         to disable a Run button before it can fail
--   enqueue_agent_job, approve_idea_and_generate_brief,
--   review_media_asset, schedule_asset, start_onboarding
--                      -> the action RPCs behind buttons; each one
--                         re-checks can_access_client() internally;

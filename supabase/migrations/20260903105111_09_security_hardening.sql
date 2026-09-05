-- ============================================================
-- AA Console · 09 · Security hardening
--
-- Fixes three classes of finding from the database linter:
--   1. Views ran as SECURITY DEFINER, so they bypassed the RLS of the
--      querying user. approvals_queue and work_submissions would have
--      leaked every client's assets to any signed-in user.
--   2. Three functions had a mutable search_path.
--   3. Trigger functions and internal helpers were callable as RPC.
-- ============================================================

-- ---------- 1 · views must respect the caller's RLS ----------
alter view agent_stats          set (security_invoker = on);
alter view approvals_queue      set (security_invoker = on);
alter view work_submissions     set (security_invoker = on);
alter view lead_pipeline_counts set (security_invoker = on);
alter view client_billing_view  set (security_invoker = on);
alter view mrr_from_billing     set (security_invoker = on);

-- ---------- 2 · pin search_path ----------
create or replace function set_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create or replace function mark_record_edited()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.body is distinct from old.body and auth.uid() is not null then
    new.edited_by = auth.uid();
    new.edited_at = now();
  end if;
  return new;
end;
$$;

create or replace function try_uuid(t text)
returns uuid
language plpgsql
immutable
set search_path = public
as $$
begin
  return t::uuid;
exception when others then
  return null;
end;
$$;

-- ---------- 3 · lock down the API surface ----------
-- Nothing this schema defines should be reachable by an anonymous
-- caller. Start from zero, then grant back only the RPCs the three
-- consoles actually call.
revoke execute on all functions in schema public from anon, public;

-- Trigger functions: invoked by the trigger machinery, never as RPC.
-- (No grant back — PostgreSQL does not check EXECUTE for triggers.)

-- Helpers that RLS policy expressions evaluate as the querying user.
-- These MUST stay executable by authenticated or every policy fails.
grant execute on function is_admin()                       to authenticated;
grant execute on function current_role_of()                to authenticated;
grant execute on function can_access_client(uuid)          to authenticated;
grant execute on function is_member(uuid)                  to authenticated;
grant execute on function current_member_id()              to authenticated;
grant execute on function try_uuid(text)                   to authenticated;

-- Read helpers the UI legitimately calls.
grant execute on function accessible_client_ids()          to authenticated;
grant execute on function can_run_agent(text, uuid)        to authenticated;

-- The action RPCs behind buttons. Each re-checks permission internally.
grant execute on function enqueue_agent_job(text, uuid, text, uuid)                to authenticated;
grant execute on function approve_idea_and_generate_brief(uuid)                    to authenticated;
grant execute on function review_media_asset(uuid, review_status, text)            to authenticated;
grant execute on function schedule_asset(uuid, date, post_channel)                 to authenticated;
grant execute on function start_onboarding(uuid)                                   to authenticated;

-- next_ref_number is only ever called from inside assign_ref_number,
-- which is SECURITY DEFINER — no direct grant.

-- ---------- Realtime ----------
-- The agent-flow UI subscribes to its job row rather than polling.
alter publication supabase_realtime add table agent_jobs;
alter publication supabase_realtime add table agent_job_events;
alter publication supabase_realtime add table client_agent_records;
alter publication supabase_realtime add table team_messages;;

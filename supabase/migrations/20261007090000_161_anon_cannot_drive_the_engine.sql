-- Anon could call every function in this database.
--
-- Not through a bug in any one migration. Supabase's default privileges
-- grant EXECUTE on every new function in `public` to anon, authenticated and
-- service_role, and `revoke all on function x from public` -- which several
-- migrations in this repo do, including three written this week -- revokes
-- from the PUBLIC pseudo-role and leaves those three role grants exactly
-- where they were.
--
-- So every one of these read "service_role only" in its migration and was in
-- fact callable by anybody holding the anon key, which is shipped in the
-- browser bundle:
--
--   advance_slot, engine_tick, plan_slots, select_idea_for_slot,
--   create_content_slot, approve_slot, reject_slot, regenerate_slot,
--   record_qa_result, approve_idea_by_policy, claim_posts_for_publishing,
--   record_post_published, record_post_publish_failure,
--   reap_stale_publish_claims, set_publishing_enabled, schedule_asset,
--   set_post_copy, and thirteen more.
--
-- Most of them survive on a check in their own body: record_qa_result asks
-- whether auth.role() is service_role, approve_slot asks
-- can_access_client. Those were doing the work the grants were credited
-- with. The ones with no body check were open, and the worst of them is
-- advance_slot, which is the engine's entire state machine and had no
-- permission check of any kind -- not even for a signed-in user of another
-- client. Anyone with a slot id could move that slot, including out of
-- awaiting_approval, which is the one human gate the whole engine exists to
-- stop at.
--
-- Three things here, in order of what they fix:
--
--   1. advance_slot gets the check it never had.
--   2. anon loses EXECUTE on every SECURITY DEFINER function, and the
--      default privileges stop granting it on the next one.
--   3. A view that lists the exposure, so this is a query somebody can run
--      rather than a lint somebody has to remember to read.
--
-- The second one cannot be made automatic. See the note above
-- lock_down_definer_functions: ALTER DEFAULT PRIVILEGES does not express it
-- and an event trigger needs superuser, so the sweep is a function that
-- later migrations call and the view is how anybody notices one did not.

-- ---------------------------------------------------------------------------
-- 1. advance_slot asks who is calling
-- ---------------------------------------------------------------------------

-- Three callers, and the gate has to let all three through.
--
--   service_role: every agent, through record_qa_result and the rest.
--   a person: through approve_slot, reject_slot, regenerate_slot, each of
--     which has already checked can_access_client -- but advance_slot is
--     callable directly and must not take that on trust.
--   the database itself: pg_cron runs engine_tick as the superuser with no
--     JWT at all, so auth.role() is null rather than any role name. That is
--     not a hole: reaching this with no JWT means being inside the database
--     already, which is a strictly larger privilege than this function.
create or replace function public.may_advance_slot(p_client_id uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select coalesce(auth.role(), '') in ('service_role', '')
      or can_access_client(p_client_id)
$$;

comment on function public.may_advance_slot(uuid) is
  'Whether the current caller may move this client''s slots: the engine, the database itself, or somebody who can reach the client. An empty role is pg_cron, which is already inside.';

create or replace function public.advance_slot(
  p_slot_id uuid,
  p_to_stage slot_stage,
  p_actor text default 'engine',
  p_note text default null,
  p_agent_key text default null,
  p_job_id uuid default null,
  p_cost_usd numeric default null,
  p_idea_id uuid default null,
  p_brief_id uuid default null,
  p_asset_id uuid default null,
  p_scheduled_post_id uuid default null,
  p_blocked_reason text default null
)
returns content_slots
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_slot content_slots;
  v_from slot_stage;
  v_row content_slots;
begin
  -- Lock first: two agents finishing at once must not both move the same slot.
  select * into v_slot from content_slots where id = p_slot_id for update;
  if not found then
    raise exception 'No such slot: %.', p_slot_id using errcode = 'P0001';
  end if;

  -- The check this function never had. Before it, a slot id was enough to
  -- move anybody's slot past the human gate.
  if not may_advance_slot(v_slot.client_id) then
    raise exception 'Not permitted for this client';
  end if;

  v_from := v_slot.stage;

  if v_from = p_to_stage then
    raise exception 'Slot % is already %.', p_slot_id, p_to_stage using errcode = 'P0001';
  end if;

  if not exists (
    select 1 from slot_transitions t where t.from_stage = v_from and t.to_stage = p_to_stage
  ) then
    raise exception 'A slot cannot go from % to %.', v_from, p_to_stage using errcode = 'P0001';
  end if;

  if p_actor not in ('engine', 'agent', 'human', 'policy') then
    raise exception 'Unknown actor "%".', p_actor using errcode = 'P0001';
  end if;

  perform set_config('aa.advancing_slot', p_slot_id::text, true);

  update content_slots set
    stage = p_to_stage,
    idea_id = coalesce(p_idea_id, idea_id),
    brief_id = coalesce(p_brief_id, brief_id),
    asset_id = coalesce(p_asset_id, asset_id),
    scheduled_post_id = coalesce(p_scheduled_post_id, scheduled_post_id),
    cost_usd = cost_usd + coalesce(p_cost_usd, 0),
    attempts = attempts + case
      when p_to_stage in ('building', 'copywriting') and v_from = 'qa' then 1
      when p_to_stage = 'planned' and v_from = 'failed' then 1
      when p_to_stage = 'briefing' and v_from = 'rejected' then 1
      else 0
    end,
    blocked_reason = case
      when p_to_stage = 'failed' then coalesce(p_blocked_reason, p_note)
      else null
    end
  where id = p_slot_id
  returning * into v_row;

  perform set_config('aa.advancing_slot', '', true);

  insert into slot_events (
    slot_id, from_stage, to_stage, actor, actor_id, agent_key, job_id, note, cost_usd
  ) values (
    p_slot_id, v_from, p_to_stage, p_actor, auth.uid(), p_agent_key, p_job_id, p_note, p_cost_usd
  );

  return v_row;
end;
$$;

comment on function public.advance_slot is
  'Move a slot to its next stage. The only thing that may write content_slots.stage. Refuses a caller who cannot reach the client, a move that is not in slot_transitions, and records every accepted one in slot_events.';

-- ---------------------------------------------------------------------------
-- 2. anon loses EXECUTE, and there is a way to take it away again
-- ---------------------------------------------------------------------------

-- TWO grants, not one, and the migrations that tried this only knew about
-- the other one.
--
-- PostgreSQL itself grants EXECUTE on every new function to PUBLIC, and anon
-- is a member of PUBLIC. Supabase then grants EXECUTE to anon, authenticated
-- and service_role by name. A function is therefore reachable by anon two
-- ways, and revoking either one alone leaves the other:
--
--   revoke ... from public  -- what migrations 158, 159 and 160 did. Removes
--                              PostgreSQL's grant, leaves Supabase's.
--   revoke ... from anon    -- removes Supabase's, leaves PostgreSQL's.
--
-- Both, every time.
--
-- WHY THIS IS NOT ALTER DEFAULT PRIVILEGES
--
-- The obvious fix is to stop the grant happening on the next function:
--
--   alter default privileges in schema public revoke execute on functions from public;
--
-- It does nothing, and it does nothing silently. Checked against this
-- project on 7 October: after running both that and the anon version, a
-- freshly created function was still executable by anon and by PUBLIC, and
-- pg_default_acl had no row for the schema. EXECUTE-to-PUBLIC is an implicit
-- default rather than a stored grant, so revoking it is a revoke of nothing;
-- Postgres only records a default ACL once a GRANT has made one diverge. An
-- event trigger on CREATE FUNCTION would work and needs superuser, which
-- Supabase does not give out.
--
-- So the mechanism is a function that can be run again, and the view below
-- is how anybody finds out it needs to be. Every migration that adds a
-- SECURITY DEFINER function to public should end by calling it.

create or replace function public.lock_down_definer_functions()
returns integer
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  r record;
  v_count integer := 0;
begin
  for r in
    select p.oid::regprocedure as sig
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname in ('public', 'mcp_internal')
       and p.prosecdef
       and (has_function_privilege('anon', p.oid, 'execute')
            or has_function_privilege('public', p.oid, 'execute'))
  loop
    execute format('revoke execute on function %s from public', r.sig);
    execute format('revoke execute on function %s from anon', r.sig);
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

comment on function public.lock_down_definer_functions() is
  'Take EXECUTE on every SECURITY DEFINER function in public and mcp_internal away from anon and from PUBLIC, and return how many it changed. Run at the end of any migration that adds one: ALTER DEFAULT PRIVILEGES cannot express this, because revoking the implicit EXECUTE-to-PUBLIC default is a revoke of nothing.';

-- Put back what the sweep took away from the roles that should have it.
--
-- The sweep removed PUBLIC and anon. A role that reached a function only
-- through PUBLIC lost it, so everything this system actually calls is named
-- here rather than left to whatever the defaults happened to leave behind.
--
-- This is deliberately not an attempt to re-derive every grant in the
-- database. `authenticated` keeps the named grants Supabase and the earlier
-- migrations gave it, because fifty screens call those functions and each
-- one is gated in its own body by can_access_client or is_admin. The four
-- exceptions are below.
grant execute on function public.advance_slot(uuid, slot_stage, text, text, text, uuid, numeric, uuid, uuid, uuid, uuid, text) to authenticated, service_role;
grant execute on function public.may_advance_slot(uuid) to authenticated, service_role;
grant execute on function public.approve_slot(uuid, text) to authenticated;
grant execute on function public.reject_slot(uuid, text) to authenticated;
grant execute on function public.regenerate_slot(uuid) to authenticated;
grant execute on function public.set_publishing_enabled(uuid, boolean) to authenticated;
grant execute on function public.create_content_slot(uuid, post_platform, timestamptz, uuid, content_format) to authenticated, service_role;
grant execute on function public.integration_usable(uuid, text) to authenticated, service_role;
grant execute on function public.usable_integration_statuses() to authenticated, service_role;
grant execute on function public.enqueue_publish_sweep() to authenticated, service_role;

-- And everything the engine calls, as the engine.
grant execute on function public.engine_tick(timestamptz) to service_role;
grant execute on function public.plan_slots(uuid, timestamptz) to service_role;
grant execute on function public.select_idea_for_slot(uuid) to service_role;
grant execute on function public.reap_stale_publish_claims(interval) to service_role;
grant execute on function public.record_qa_result(uuid, integer, jsonb, slot_stage, text, uuid) to service_role;
grant execute on function public.claim_posts_for_publishing(integer) to service_role;
grant execute on function public.record_post_published(uuid, text, text, text) to service_role;
grant execute on function public.record_post_publish_failure(uuid, text, boolean, integer) to service_role;

-- The four that spend money and have no check in their own bodies. Nothing
-- in a browser calls any of them: the agents call select_idea_for_slot as
-- the service role, and cron calls the rest. A signed-in person being able
-- to run the tick for every client is a signed-in person being able to spend
-- every client's month in one request.
revoke execute on function public.engine_tick(timestamptz) from authenticated;
revoke execute on function public.plan_slots(uuid, timestamptz) from authenticated;
revoke execute on function public.select_idea_for_slot(uuid) from authenticated;
revoke execute on function public.reap_stale_publish_claims(interval) from authenticated;

-- ---------------------------------------------------------------------------
-- 3. The exposure, as a query
-- ---------------------------------------------------------------------------

-- security_invoker like every other view here (148). It reads only system
-- catalogues, which have no RLS to read past, but "this one is fine" is a
-- judgement somebody has to make again on every review, and the test that
-- enforces the rule is worth more than the exemption.
create or replace view security_definer_exposure with (security_invoker = true) as
select
  n.nspname as schema,
  p.proname as function,
  pg_get_function_identity_arguments(p.oid) as arguments,
  has_function_privilege('anon', p.oid, 'execute') as anon_can_execute,
  has_function_privilege('authenticated', p.oid, 'execute') as signed_in_can_execute,
  -- A body that never asks who is calling. A false here next to a true
  -- above is the shape this migration was written about.
  (p.prosrc ~* 'can_access_client|is_admin\(|auth\.role\(\)|may_advance_slot|current_role_of|accessible_client_ids')
    as body_checks_the_caller
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname in ('public', 'mcp_internal')
  and p.prosecdef
  and (has_function_privilege('anon', p.oid, 'execute')
       or has_function_privilege('authenticated', p.oid, 'execute'))
order by anon_can_execute desc, body_checks_the_caller, n.nspname, p.proname;

comment on view security_definer_exposure is
  'Every SECURITY DEFINER function anon or a signed-in user can execute, and whether its own body checks the caller. Any row with anon_can_execute true is a finding. A row with body_checks_the_caller false is relying entirely on its grants.';

revoke all on security_definer_exposure from anon;
grant select on security_definer_exposure to authenticated;

-- ---------------------------------------------------------------------------
-- The rest of the lint, while here
-- ---------------------------------------------------------------------------

-- Pure functions, so a mutable search_path cannot actually be exploited --
-- neither touches a table. Pinned anyway: "this one is harmless" is a
-- judgement that has to be made again every time somebody reads the list,
-- and the list is more useful empty.
create or replace function public.default_post_time()
returns time without time zone
language sql
immutable
set search_path to 'public'
as $$ select time '09:00' $$;

create or replace function mcp_internal.clip_text(p text, p_max integer default 8000)
returns text
language sql
immutable
set search_path to 'public'
as $$
  select case
    when p is null then null
    when char_length(p) <= p_max then p
    else left(p, p_max)
  end;
$$;

-- slot_pipeline had RLS on and no policy, so it was readable by nobody. The
-- tick reads it as service_role and never noticed. It is reference data --
-- which stage runs which agent -- and the same shape as slot_transitions,
-- which has had a read-all policy since 147.
drop policy if exists sp_read on slot_pipeline;
create policy sp_read on slot_pipeline for select to authenticated using (true);
grant select on slot_pipeline to authenticated;

-- ---------------------------------------------------------------------------
-- And last, so it is the final word on every function above
-- ---------------------------------------------------------------------------

select public.lock_down_definer_functions();

-- Including itself: nothing below needs anon, and a sweep anon can call is a
-- sweep anon can watch.
revoke execute on function public.lock_down_definer_functions() from public, anon;
grant execute on function public.lock_down_definer_functions() to service_role;

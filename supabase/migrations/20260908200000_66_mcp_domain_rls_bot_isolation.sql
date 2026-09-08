-- Phase 4: domain RLS tightening for Bot-touched tables + shared Bot RPC helpers.
-- DO NOT APPLY TO PRODUCTION without Alex approval.
-- This migration does not rotate secrets, change DNS, or insert live token hashes.
--
-- Additive only:
--   * Enable (idempotent) / force RLS on Bot registry + Bot-touched domain tables.
--   * Shared mcp_internal helpers so Bot RPCs never use human can_access_client.
--   * enqueue_mcp_brief calls those helpers (also denies suspended/revoked bots).
--   * CoS prohibition trigger on mcp_bot_permissions.
-- Does not grant gateway table access. Does not enable stub adapters.

-- Auto-enable RLS for new tables in mcp_internal as well as public.
-- Event trigger ensure_rls (migration 09b) already exists in full environments.
-- PGlite fixtures used by agent-runtime tests may not provide event_trigger.
do $$
begin
  if not exists (select 1 from pg_type where typname = 'event_trigger') then
    raise notice 'Phase 4: event_trigger type not present; skipped rls_auto_enable update';
    return;
  end if;
  execute $fn$
    create or replace function public.rls_auto_enable()
    returns event_trigger
    language plpgsql
    security definer
    set search_path to 'pg_catalog'
    as $function$
    DECLARE
      cmd record;
    BEGIN
      FOR cmd IN
        SELECT *
        FROM pg_event_trigger_ddl_commands()
        WHERE command_tag IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
          AND object_type IN ('table','partitioned table')
      LOOP
         IF cmd.schema_name IS NOT NULL AND cmd.schema_name IN ('public', 'mcp_internal') AND cmd.schema_name NOT IN ('pg_catalog','information_schema') AND cmd.schema_name NOT LIKE 'pg_toast%' AND cmd.schema_name NOT LIKE 'pg_temp%' THEN
          BEGIN
            EXECUTE format('alter table if exists %s enable row level security', cmd.object_identity);
            RAISE LOG 'rls_auto_enable: enabled RLS on %', cmd.object_identity;
          EXCEPTION
            WHEN OTHERS THEN
              RAISE LOG 'rls_auto_enable: failed to enable RLS on %', cmd.object_identity;
          END;
         ELSE
            RAISE LOG 'rls_auto_enable: skip % (either system schema or not in enforced list: %.)', cmd.object_identity, cmd.schema_name;
         END IF;
      END LOOP;
    END;
    $function$;
  $fn$;
  execute 'revoke execute on function public.rls_auto_enable() from public, anon, authenticated';
  execute 'grant execute on function public.rls_auto_enable() to service_role';
end;
$$;

-- Bot-touched tables from the Phase 3–4 design §6. ENABLE is idempotent.
-- Partial PGlite fixtures may omit later domain tables; those tables enable RLS
-- in their own create migrations. Missing names are skipped, never created.
do $$
declare
  rec record;
begin
  for rec in
    select * from (values
      ('public', 'clients'),
      ('public', 'client_assignments'),
      ('public', 'job_assignments'),
      ('public', 'client_onboarding_steps'),
      ('public', 'agent_jobs'),
      ('public', 'agent_job_events'),
      ('public', 'campaigns'),
      ('public', 'client_ideas'),
      ('public', 'client_briefs'),
      ('public', 'client_media_assets'),
      ('public', 'client_asset_reviews'),
      ('public', 'creative_generations'),
      ('public', 'creative_renders'),
      ('public', 'brief_dispatches'),
      ('public', 'mcp_brief_requests'),
      ('public', 'mcp_bot_clients'),
      ('public', 'client_pages'),
      ('public', 'client_brand_profiles'),
      ('public', 'client_leads'),
      ('public', 'lead_events'),
      ('public', 'client_contact_details'),
      ('public', 'client_proof_assets'),
      ('public', 'metrics_daily'),
      ('public', 'scheduled_posts'),
      ('public', 'client_billing'),
      ('public', 'finance_entries'),
      ('public', 'finance_periods'),
      ('mcp_internal', 'mcp_bots'),
      ('mcp_internal', 'mcp_bot_tokens'),
      ('mcp_internal', 'mcp_bot_permissions'),
      ('mcp_internal', 'mcp_bot_token_audit')
    ) as t(nsp, rel)
  loop
    if to_regclass(format('%I.%I', rec.nsp, rec.rel)) is null then
      raise notice 'Phase 4 RLS: %.% not present (partial fixture); skipped', rec.nsp, rec.rel;
    else
      execute format('alter table %I.%I enable row level security', rec.nsp, rec.rel);
    end if;
  end loop;
end;
$$;

-- FORCE RLS on Bot registry / Bot ledger tables: no authenticated policies,
-- default deny, table-owner bypass removed. Superuser and BYPASSRLS (service_role)
-- still skip policies; grants remain the real control, matching enqueue_mcp_brief.
-- Do not FORCE domain Console tables — human policies + owner bypass stay as today.
do $$
declare
  rec record;
begin
  for rec in
    select * from (values
      ('mcp_internal', 'mcp_bots'),
      ('mcp_internal', 'mcp_bot_tokens'),
      ('mcp_internal', 'mcp_bot_permissions'),
      ('mcp_internal', 'mcp_bot_token_audit'),
      ('public', 'mcp_bot_clients'),
      ('public', 'mcp_brief_requests')
    ) as t(nsp, rel)
  loop
    if to_regclass(format('%I.%I', rec.nsp, rec.rel)) is not null then
      execute format('alter table %I.%I force row level security', rec.nsp, rec.rel);
    end if;
  end loop;
end;
$$;

-- Catalog for isolation tests: record relrowsecurity / policy count.
-- Does not claim a missing table is isolated.
create or replace function mcp_internal.bot_touched_rls_status()
returns table (
  nsp name,
  rel name,
  present boolean,
  rls_enabled boolean,
  rls_forced boolean,
  policy_count integer
)
language plpgsql
stable
security definer
set search_path = mcp_internal, public, pg_catalog
as $$
begin
  perform mcp_internal.require_service_role();
  return query
  select
    t.nsp,
    t.rel,
    (c.oid is not null) as present,
    coalesce(c.relrowsecurity, false) as rls_enabled,
    coalesce(c.relforcerowsecurity, false) as rls_forced,
    coalesce((select count(*)::int from pg_policy p where p.polrelid = c.oid), 0) as policy_count
  from (values
    ('public'::name, 'clients'::name),
    ('public', 'client_assignments'),
    ('public', 'job_assignments'),
    ('public', 'client_onboarding_steps'),
    ('public', 'agent_jobs'),
    ('public', 'agent_job_events'),
    ('public', 'campaigns'),
    ('public', 'client_ideas'),
    ('public', 'client_briefs'),
    ('public', 'client_media_assets'),
    ('public', 'client_asset_reviews'),
    ('public', 'creative_generations'),
    ('public', 'creative_renders'),
    ('public', 'brief_dispatches'),
    ('public', 'mcp_brief_requests'),
    ('public', 'mcp_bot_clients'),
    ('public', 'client_pages'),
    ('public', 'client_brand_profiles'),
    ('public', 'client_leads'),
    ('public', 'lead_events'),
    ('public', 'client_contact_details'),
    ('public', 'client_proof_assets'),
    ('public', 'metrics_daily'),
    ('public', 'scheduled_posts'),
    ('public', 'client_billing'),
    ('public', 'finance_entries'),
    ('public', 'finance_periods'),
    ('mcp_internal', 'mcp_bots'),
    ('mcp_internal', 'mcp_bot_tokens'),
    ('mcp_internal', 'mcp_bot_permissions'),
    ('mcp_internal', 'mcp_bot_token_audit')
  ) as t(nsp, rel)
  left join pg_class c
    on c.relname = t.rel
   and c.relnamespace = (select n.oid from pg_namespace n where n.nspname = t.nsp);
end;
$$;
revoke all on function mcp_internal.bot_touched_rls_status() from public, anon, authenticated;
grant execute on function mcp_internal.bot_touched_rls_status() to service_role;

create or replace function mcp_internal.require_active_bot(p_bot_id text)
returns void
language plpgsql
stable
security definer
set search_path = mcp_internal, public
as $$
declare
  v_status text;
begin
  perform mcp_internal.require_service_role();
  if p_bot_id is null or p_bot_id !~ '^bot_[a-z0-9_]{1,60}$' then
    raise exception using message = 'invalid_bot', errcode = 'P0001';
  end if;
  select status into v_status from mcp_internal.mcp_bots where bot_id = p_bot_id;
  if not found then
    raise exception using message = 'invalid_bot', errcode = 'P0001';
  end if;
  if v_status is distinct from 'active' then
    raise exception using message = 'bot_not_active', errcode = 'P0001';
  end if;
end;
$$;
revoke all on function mcp_internal.require_active_bot(text) from public, anon, authenticated;
grant execute on function mcp_internal.require_active_bot(text) to service_role;

-- Bot client scope. NEVER call can_access_client here: that is human Console
-- membership (auth.uid() / assignments) and would leak every client any
-- assigned employee can see.
create or replace function mcp_internal.require_bot_client_grant(p_bot_id text, p_client_id uuid)
returns void
language plpgsql
security definer
set search_path = mcp_internal, public
as $$
begin
  perform mcp_internal.require_service_role();
  perform mcp_internal.require_active_bot(p_bot_id);
  if p_client_id is null then
    raise exception using message = 'invalid_request', errcode = 'P0001';
  end if;
  perform 1 from public.mcp_bot_clients
    where bot_id = p_bot_id and client_id = p_client_id
    for share;
  if not found then
    raise exception using message = 'client_forbidden', errcode = 'P0001';
  end if;
end;
$$;
revoke all on function mcp_internal.require_bot_client_grant(text, uuid) from public, anon, authenticated;
grant execute on function mcp_internal.require_bot_client_grant(text, uuid) to service_role;

create or replace function mcp_internal.bot_has_permission(p_bot_id text, p_tool text)
returns boolean
language plpgsql
stable
security definer
set search_path = mcp_internal, public
as $$
begin
  perform mcp_internal.require_service_role();
  if p_bot_id is null or p_tool is null then
    return false;
  end if;
  return exists (
    select 1
      from mcp_internal.mcp_bot_permissions p
     where p.bot_id = p_bot_id
       and mcp_internal.permission_matches(p.permission_pattern, p_tool)
  );
end;
$$;
revoke all on function mcp_internal.bot_has_permission(text, text) from public, anon, authenticated;
grant execute on function mcp_internal.bot_has_permission(text, text) to service_role;

create or replace function mcp_internal.list_bot_clients(p_bot_id text)
returns jsonb
language plpgsql
stable
security definer
set search_path = mcp_internal, public
as $$
declare
  v_clients jsonb;
begin
  perform mcp_internal.require_service_role();
  perform mcp_internal.require_active_bot(p_bot_id);
  select coalesce(jsonb_agg(client_id order by client_id), '[]'::jsonb)
    into v_clients
    from public.mcp_bot_clients
    where bot_id = p_bot_id;
  return v_clients;
end;
$$;
revoke all on function mcp_internal.list_bot_clients(text) from public, anon, authenticated;
grant execute on function mcp_internal.list_bot_clients(text) to service_role;

create or replace function public.mcp_list_bot_clients(p_bot_id text)
returns jsonb
language plpgsql
stable
security definer
set search_path = mcp_internal, public
as $$
begin
  perform mcp_internal.require_service_role();
  return mcp_internal.list_bot_clients(p_bot_id);
end;
$$;
revoke all on function public.mcp_list_bot_clients(text) from public, anon, authenticated;
grant execute on function public.mcp_list_bot_clients(text) to service_role;

-- Same CoS checks as migration 65 seed. Enforced on every permission write.
create or replace function mcp_internal.assert_cos_prohibitions()
returns void
language plpgsql
set search_path = mcp_internal, public
as $$
begin
  if exists (
    select 1 from mcp_internal.mcp_bot_permissions p
    where p.bot_id = 'bot_production'
      and (
        p.permission_pattern like 'economics%'
        or p.permission_pattern like 'finance%'
        or p.permission_pattern like 'security%'
        or p.permission_pattern like '%deploy%'
        or mcp_internal.permission_matches(p.permission_pattern, 'economics.get_costs')
        or mcp_internal.permission_matches(p.permission_pattern, 'security.get_system_status')
        or mcp_internal.permission_matches(p.permission_pattern, 'sales_agents.deploy')
      )
  ) then
    raise exception 'CoS: bot_production must not have finance, security, or deploy grants';
  end if;
  if exists (
    select 1 from mcp_internal.mcp_bot_permissions p
    where p.bot_id = 'bot_finance'
      and (
        p.permission_pattern = 'content.*'
        or (
          p.permission_pattern like 'content.%'
          and p.permission_pattern !~ '^content\.(get|list|search)'
        )
      )
  ) then
    raise exception 'CoS: bot_finance must not have content write grants';
  end if;
  if exists (
    select 1 from mcp_internal.mcp_bot_permissions p
    where p.bot_id = 'bot_security_devops'
      and (
        p.permission_pattern like 'economics%'
        or p.permission_pattern like 'finance%'
        or p.permission_pattern = 'finance_periods'
        or p.permission_pattern = 'attribution.get_revenue_attribution'
        or mcp_internal.permission_matches(p.permission_pattern, 'economics.get_costs')
        or mcp_internal.permission_matches(p.permission_pattern, 'attribution.get_revenue_attribution')
      )
  ) then
    raise exception 'CoS: bot_security_devops must not have client financials or finance_periods grants';
  end if;
end;
$$;
revoke all on function mcp_internal.assert_cos_prohibitions() from public, anon, authenticated;
grant execute on function mcp_internal.assert_cos_prohibitions() to service_role;

create or replace function mcp_internal.mcp_bot_permissions_cos_guard()
returns trigger
language plpgsql
set search_path = mcp_internal
as $$
begin
  perform mcp_internal.assert_cos_prohibitions();
  return null;
end;
$$;
revoke all on function mcp_internal.mcp_bot_permissions_cos_guard() from public, anon, authenticated, service_role;

drop trigger if exists mcp_bot_permissions_cos_guard on mcp_internal.mcp_bot_permissions;
create trigger mcp_bot_permissions_cos_guard
  after insert or update or delete on mcp_internal.mcp_bot_permissions
  for each statement execute function mcp_internal.mcp_bot_permissions_cos_guard();

do $$ begin perform mcp_internal.assert_cos_prohibitions(); end $$;

-- Bot enqueue: same contract as migration 63, plus active-bot + shared grant helper.
-- Human enqueue_agent_job still uses can_access_client. Do not mix those paths.
create or replace function enqueue_mcp_brief(
  p_bot_id text, p_request_id text, p_execution_id text,
  p_client_id uuid, p_idea_id uuid
)
returns jsonb language plpgsql security definer set search_path = public, mcp_internal as $$
declare
  v_idea client_ideas;
  v_request mcp_brief_requests;
  v_job uuid;
  v_meta jsonb;
begin
  perform mcp_internal.require_service_role();
  if p_bot_id is null or p_bot_id !~ '^bot_[a-z0-9_]{1,60}$' then
    raise exception 'invalid_bot';
  end if;
  if p_client_id is null or p_idea_id is null
     or p_request_id is null or p_request_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
     or p_execution_id is null or p_execution_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' then
    raise exception 'invalid_request';
  end if;
  -- Bot path: mcp_bot_clients + active mcp_bots row. Not can_access_client.
  perform mcp_internal.require_bot_client_grant(p_bot_id, p_client_id);

  perform pg_advisory_xact_lock(hashtextextended(p_bot_id || ':' || p_execution_id, 0));
  select * into v_request from mcp_brief_requests
    where bot_id = p_bot_id and execution_id = p_execution_id;
  if found then
    if v_request.client_id <> p_client_id or v_request.idea_id <> p_idea_id then
      raise exception 'idempotency_conflict';
    end if;
  end if;

  select * into v_idea from client_ideas where id = p_idea_id for update;
  if not found then raise exception 'idea_not_found'; end if;
  if v_idea.client_id <> p_client_id then raise exception 'client_mismatch'; end if;
  if v_request.job_id is not null then
    return jsonb_build_object('job_id', v_request.job_id, 'client_id', v_request.client_id, 'replayed', true);
  end if;
  if v_idea.status <> 'approved' then raise exception 'invalid_idea_status'; end if;

  v_meta := jsonb_build_object('source', 'aa-mcp-gateway', 'bot_id', p_bot_id,
    'request_id', p_request_id, 'execution_id', p_execution_id,
    'client_id', p_client_id, 'idea_id', p_idea_id);
  begin
    v_job := enqueue_agent_job_internal('brief', p_client_id, 'client_ideas', p_idea_id,
      null, v_meta, 'Queued by MCP gateway');
  exception
    when raise_exception then raise exception 'brief_agent_unavailable';
    when others then raise exception 'queue_failure';
  end;
  insert into mcp_brief_requests (bot_id, execution_id, request_id, client_id, idea_id, job_id)
  values (p_bot_id, p_execution_id, p_request_id, p_client_id, p_idea_id, v_job);
  update client_ideas set status = 'briefed' where id = p_idea_id;
  return jsonb_build_object('job_id', v_job, 'client_id', p_client_id, 'replayed', false);
end;
$$;
revoke all on function enqueue_mcp_brief(text, text, text, uuid, uuid) from public, anon, authenticated;
grant execute on function enqueue_mcp_brief(text, text, text, uuid, uuid) to service_role;

comment on function mcp_internal.require_bot_client_grant(text, uuid) is
  'Phase 4 Bot client scope. Uses mcp_bot_clients only; never can_access_client. Alex approval required before applying this migration to production.';
comment on function public.enqueue_mcp_brief(text, text, text, uuid, uuid) is
  'Bot brief enqueue. service_role SECURITY DEFINER. Client grant + active bot required. Do not apply registry/RLS migrations to production without Alex approval.';

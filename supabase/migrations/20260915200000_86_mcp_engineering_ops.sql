-- Phase 14: Engineering Ops MCP for bot_engineering.
-- Exact 12-tool allowlist. Converts the seeded engineering.* wildcard to
-- four named engineering tools plus the eight workflow names.
-- DO NOT APPLY TO STAGING OR PRODUCTION without Alex via Chief of Staff.
-- Independent of Phase 13 Finance (migration 85); bases on main (through 84).
--
-- Gate 14 is read-heavy engineering status + workflow tracking.
-- No Railway write, secret rotation, or unrestricted deploy tools.
-- Every Bot RPC: require_active_bot + require_bot_client_grant; never can_access_client.
-- Isolation tests must stay green before registry unstub.
begin;

create table mcp_internal.mcp_engineering_issues (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id),
  title text not null check (length(btrim(title)) between 1 and 200),
  notes text check (length(notes) <= 2000),
  status text not null default 'open' check (status in ('open','in_progress','resolved','cancelled')),
  created_by_bot text not null references mcp_internal.mcp_bots(bot_id) check (created_by_bot='bot_engineering'),
  updated_by_bot text not null references mcp_internal.mcp_bots(bot_id) check (updated_by_bot='bot_engineering'),
  version integer not null default 1 check (version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index mcp_engineering_issues_client_idx on mcp_internal.mcp_engineering_issues(client_id, id);

create table mcp_internal.mcp_engineering_requests (
  bot_id text not null references mcp_internal.mcp_bots(bot_id),
  execution_id text not null check (execution_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  request_id text not null check (request_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  tool text not null check (tool = 'engineering.create_issue'),
  client_id uuid not null references public.clients(id),
  issue_id uuid not null references mcp_internal.mcp_engineering_issues(id),
  payload jsonb not null,
  result jsonb not null,
  created_at timestamptz not null default now(),
  primary key (bot_id, execution_id)
);

alter table mcp_internal.mcp_engineering_issues enable row level security;
alter table mcp_internal.mcp_engineering_issues force row level security;
alter table mcp_internal.mcp_engineering_requests enable row level security;
alter table mcp_internal.mcp_engineering_requests force row level security;
revoke all on mcp_internal.mcp_engineering_issues, mcp_internal.mcp_engineering_requests
  from public, anon, authenticated, service_role;

create function mcp_internal.require_engineering_permission(p_bot_id text, p_client_id uuid, p_tool text)
returns void
language plpgsql
volatile
security definer
set search_path = pg_catalog, mcp_internal, public
set timezone = 'UTC'
as $$
begin
  perform mcp_internal.require_active_bot(p_bot_id);
  perform mcp_internal.require_bot_client_grant(p_bot_id, p_client_id);
  if p_tool not in (
    'engineering.create_issue',
    'engineering.get_issue',
    'engineering.get_release_status',
    'engineering.get_deployment_status'
  ) then
    raise exception using message = 'bot_forbidden', errcode = 'P0001';
  end if;
  if p_tool in ('engineering.create_issue', 'engineering.get_issue')
     and p_bot_id is distinct from 'bot_engineering' then
    raise exception using message = 'bot_forbidden', errcode = 'P0001';
  end if;
  if p_tool in ('engineering.get_release_status', 'engineering.get_deployment_status')
     and p_bot_id not in ('bot_engineering', 'bot_security_devops') then
    raise exception using message = 'bot_forbidden', errcode = 'P0001';
  end if;
  perform 1 from mcp_internal.mcp_bots where bot_id = p_bot_id and status = 'active' for share;
  if not found then
    raise exception using message = 'bot_not_active', errcode = 'P0001';
  end if;
  perform 1 from mcp_internal.mcp_bot_permissions
    where bot_id = p_bot_id and permission_pattern = p_tool for share;
  if not found then
    raise exception using message = 'bot_forbidden', errcode = 'P0001';
  end if;
end
$$;
revoke all on function mcp_internal.require_engineering_permission(text, uuid, text)
  from public, anon, authenticated, service_role;

create function mcp_internal.engineering_create_issue(
  p_bot_id text,
  p_client_id uuid,
  p_request_id text,
  p_execution_id text,
  p_title text,
  p_notes text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, mcp_internal, public
set timezone = 'UTC'
as $$
declare
  issue mcp_internal.mcp_engineering_issues;
  receipt mcp_internal.mcp_engineering_requests;
  payload jsonb;
  result jsonb;
begin
  perform mcp_internal.require_active_bot(p_bot_id);
  perform mcp_internal.require_bot_client_grant(p_bot_id, p_client_id);
  perform mcp_internal.require_engineering_permission(p_bot_id, p_client_id, 'engineering.create_issue');
  perform mcp_internal.require_mcp_ids(p_request_id, p_execution_id);
  if p_title is null or length(btrim(p_title)) not between 1 and 200 or length(p_notes) > 2000 then
    raise exception using message = 'invalid_request', errcode = 'P0001';
  end if;
  payload := jsonb_build_object('title', p_title, 'notes', p_notes);
  perform pg_advisory_xact_lock(hashtextextended(p_bot_id || ':engineering:' || p_execution_id, 0));
  select * into receipt
    from mcp_internal.mcp_engineering_requests
   where bot_id = p_bot_id and execution_id = p_execution_id;
  if found then
    if receipt.tool is distinct from 'engineering.create_issue'
       or receipt.client_id is distinct from p_client_id
       or receipt.payload is distinct from payload then
      raise exception using message = 'idempotency_conflict', errcode = 'P0001';
    end if;
    return receipt.result || jsonb_build_object('replayed', true);
  end if;
  insert into mcp_internal.mcp_engineering_issues (
    client_id, title, notes, created_by_bot, updated_by_bot
  ) values (
    p_client_id, btrim(p_title), p_notes, p_bot_id, p_bot_id
  ) returning * into issue;
  result := jsonb_build_object('client_id', p_client_id, 'issue', to_jsonb(issue), 'replayed', false);
  insert into mcp_internal.mcp_engineering_requests (
    bot_id, execution_id, request_id, tool, client_id, issue_id, payload, result
  ) values (
    p_bot_id, p_execution_id, p_request_id, 'engineering.create_issue', p_client_id, issue.id, payload, result
  );
  return result;
end
$$;

create function mcp_internal.engineering_get_issue(p_bot_id text, p_client_id uuid, p_issue_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, mcp_internal, public
set timezone = 'UTC'
as $$
declare
  issue mcp_internal.mcp_engineering_issues;
begin
  perform mcp_internal.require_active_bot(p_bot_id);
  perform mcp_internal.require_bot_client_grant(p_bot_id, p_client_id);
  perform mcp_internal.require_engineering_permission(p_bot_id, p_client_id, 'engineering.get_issue');
  select * into issue
    from mcp_internal.mcp_engineering_issues
   where id = p_issue_id and client_id = p_client_id;
  if not found then
    raise exception using message = 'issue_not_found', errcode = 'P0001';
  end if;
  return jsonb_build_object('client_id', p_client_id, 'issue', to_jsonb(issue));
end
$$;

create function mcp_internal.engineering_get_release_status(
  p_bot_id text,
  p_client_id uuid,
  p_limit integer default 25,
  p_after uuid default null,
  p_page_id uuid default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, mcp_internal, public
set timezone = 'UTC'
as $$
declare
  items jsonb;
  cursor_id uuid;
begin
  perform mcp_internal.require_active_bot(p_bot_id);
  perform mcp_internal.require_bot_client_grant(p_bot_id, p_client_id);
  perform mcp_internal.require_engineering_permission(p_bot_id, p_client_id, 'engineering.get_release_status');
  if p_page_id is not null and (p_after is not null or (p_limit is not null and p_limit is distinct from 25)) then
    raise exception using message = 'invalid_request', errcode = 'P0001';
  end if;
  if p_limit is null or p_limit not between 1 and 100 then
    raise exception using message = 'invalid_request', errcode = 'P0001';
  end if;
  if p_page_id is not null then
    select jsonb_build_object(
      'id', p.id,
      'client_id', p.client_id,
      'page_type', p.page_type,
      'title', p.title,
      'status', p.status,
      'published_url', p.published_url,
      'created_at', p.created_at,
      'updated_at', p.updated_at
    ) into items
      from public.client_pages p
     where p.id = p_page_id and p.client_id = p_client_id;
    if items is null then
      raise exception using message = 'page_not_found', errcode = 'P0001';
    end if;
    return jsonb_build_object(
      'client_id', p_client_id,
      'projection', 'client_pages_v1',
      'pages', jsonb_build_array(items),
      'next_cursor', null
    );
  end if;
  if p_after is not null and not exists (
    select 1 from public.client_pages where id = p_after and client_id = p_client_id
  ) then
    raise exception using message = 'page_not_found', errcode = 'P0001';
  end if;
  select coalesce(jsonb_agg(to_jsonb(x) order by x.id), '[]') into items from (
    select p.id, p.client_id, p.page_type, p.title, p.status, p.published_url, p.created_at, p.updated_at
      from public.client_pages p
     where p.client_id = p_client_id
       and (p_after is null or p.id > p_after)
     order by p.id
     limit p_limit + 1
  ) x;
  if jsonb_array_length(items) > p_limit then
    items := items - p_limit;
    cursor_id := (items -> (p_limit - 1) ->> 'id')::uuid;
  end if;
  return jsonb_build_object(
    'client_id', p_client_id,
    'projection', 'client_pages_v1',
    'pages', items,
    'next_cursor', cursor_id
  );
end
$$;

create function mcp_internal.engineering_get_deployment_status(
  p_bot_id text,
  p_client_id uuid,
  p_limit integer default 25,
  p_after uuid default null,
  p_job_id uuid default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, mcp_internal, public
set timezone = 'UTC'
as $$
declare
  items jsonb;
  cursor_id uuid;
begin
  perform mcp_internal.require_active_bot(p_bot_id);
  perform mcp_internal.require_bot_client_grant(p_bot_id, p_client_id);
  perform mcp_internal.require_engineering_permission(p_bot_id, p_client_id, 'engineering.get_deployment_status');
  if p_job_id is not null and (p_after is not null or (p_limit is not null and p_limit is distinct from 25)) then
    raise exception using message = 'invalid_request', errcode = 'P0001';
  end if;
  if p_limit is null or p_limit not between 1 and 100 then
    raise exception using message = 'invalid_request', errcode = 'P0001';
  end if;
  if p_job_id is not null then
    select jsonb_build_object(
      'id', j.id,
      'client_id', j.client_id,
      'agent_key', j.agent_key,
      'status', j.status,
      'attempts', j.attempts,
      'created_at', j.created_at,
      'started_at', j.started_at,
      'completed_at', j.completed_at
    ) into items
      from public.agent_jobs j
     where j.id = p_job_id and j.client_id = p_client_id;
    if items is null then
      raise exception using message = 'job_not_found', errcode = 'P0001';
    end if;
    return jsonb_build_object(
      'client_id', p_client_id,
      'projection', 'agent_jobs_v1',
      'jobs', jsonb_build_array(items),
      'next_cursor', null
    );
  end if;
  if p_after is not null and not exists (
    select 1 from public.agent_jobs where id = p_after and client_id = p_client_id
  ) then
    raise exception using message = 'job_not_found', errcode = 'P0001';
  end if;
  select coalesce(jsonb_agg(to_jsonb(x) order by x.id), '[]') into items from (
    select j.id, j.client_id, j.agent_key, j.status, j.attempts, j.created_at, j.started_at, j.completed_at
      from public.agent_jobs j
     where j.client_id = p_client_id
       and (p_after is null or j.id > p_after)
     order by j.id
     limit p_limit + 1
  ) x;
  if jsonb_array_length(items) > p_limit then
    items := items - p_limit;
    cursor_id := (items -> (p_limit - 1) ->> 'id')::uuid;
  end if;
  return jsonb_build_object(
    'client_id', p_client_id,
    'projection', 'agent_jobs_v1',
    'jobs', items,
    'next_cursor', cursor_id
  );
end
$$;

create function public.mcp_engineering_create_issue(
  p_bot_id text, p_client_id uuid, p_request_id text, p_execution_id text, p_title text, p_notes text
) returns jsonb
language plpgsql volatile security definer
set search_path = pg_catalog, mcp_internal, public
set timezone = 'UTC'
as $$
begin
  perform mcp_internal.require_service_role();
  perform mcp_internal.require_active_bot(p_bot_id);
  perform mcp_internal.require_bot_client_grant(p_bot_id, p_client_id);
  return mcp_internal.engineering_create_issue(p_bot_id, p_client_id, p_request_id, p_execution_id, p_title, p_notes);
end
$$;
revoke all on function public.mcp_engineering_create_issue(text, uuid, text, text, text, text)
  from public, anon, authenticated;
revoke all on function mcp_internal.engineering_create_issue(text, uuid, text, text, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.mcp_engineering_create_issue(text, uuid, text, text, text, text) to service_role;

create function public.mcp_engineering_get_issue(p_bot_id text, p_client_id uuid, p_issue_id uuid) returns jsonb
language plpgsql volatile security definer
set search_path = pg_catalog, mcp_internal, public
set timezone = 'UTC'
as $$
begin
  perform mcp_internal.require_service_role();
  perform mcp_internal.require_active_bot(p_bot_id);
  perform mcp_internal.require_bot_client_grant(p_bot_id, p_client_id);
  return mcp_internal.engineering_get_issue(p_bot_id, p_client_id, p_issue_id);
end
$$;
revoke all on function public.mcp_engineering_get_issue(text, uuid, uuid)
  from public, anon, authenticated;
revoke all on function mcp_internal.engineering_get_issue(text, uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.mcp_engineering_get_issue(text, uuid, uuid) to service_role;

create function public.mcp_engineering_get_release_status(
  p_bot_id text, p_client_id uuid, p_limit integer default 25, p_after uuid default null, p_page_id uuid default null
) returns jsonb
language plpgsql volatile security definer
set search_path = pg_catalog, mcp_internal, public
set timezone = 'UTC'
as $$
begin
  perform mcp_internal.require_service_role();
  perform mcp_internal.require_active_bot(p_bot_id);
  perform mcp_internal.require_bot_client_grant(p_bot_id, p_client_id);
  return mcp_internal.engineering_get_release_status(p_bot_id, p_client_id, p_limit, p_after, p_page_id);
end
$$;
revoke all on function public.mcp_engineering_get_release_status(text, uuid, integer, uuid, uuid)
  from public, anon, authenticated;
revoke all on function mcp_internal.engineering_get_release_status(text, uuid, integer, uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.mcp_engineering_get_release_status(text, uuid, integer, uuid, uuid) to service_role;

create function public.mcp_engineering_get_deployment_status(
  p_bot_id text, p_client_id uuid, p_limit integer default 25, p_after uuid default null, p_job_id uuid default null
) returns jsonb
language plpgsql volatile security definer
set search_path = pg_catalog, mcp_internal, public
set timezone = 'UTC'
as $$
begin
  perform mcp_internal.require_service_role();
  perform mcp_internal.require_active_bot(p_bot_id);
  perform mcp_internal.require_bot_client_grant(p_bot_id, p_client_id);
  return mcp_internal.engineering_get_deployment_status(p_bot_id, p_client_id, p_limit, p_after, p_job_id);
end
$$;
revoke all on function public.mcp_engineering_get_deployment_status(text, uuid, integer, uuid, uuid)
  from public, anon, authenticated;
revoke all on function mcp_internal.engineering_get_deployment_status(text, uuid, integer, uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.mcp_engineering_get_deployment_status(text, uuid, integer, uuid, uuid) to service_role;

-- Remove the wildcard before the prohibition function starts rejecting it.
delete from mcp_internal.mcp_bot_permissions where bot_id = 'bot_engineering';

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
  if exists (
    select 1 from mcp_internal.mcp_bot_permissions p
    where p.bot_id <> 'bot_sales_ops'
      and (p.permission_pattern like 'pipeline.%' or p.permission_pattern like 'sales_agents.%')
  ) then
    raise exception 'Phase 11: pipeline.*/sales_agents.* must not be granted outside bot_sales_ops';
  end if;
  if exists (
    select 1 from mcp_internal.mcp_bot_permissions p
    where p.bot_id = 'bot_sales_ops'
      and (
        p.permission_pattern in ('pipeline.record_sale', 'sales_agents.deploy',
          'proof.search', 'proof.get', 'proof.*')
        or p.permission_pattern = 'pipeline.*'
        or p.permission_pattern = 'sales_agents.*'
      )
  ) then
    raise exception 'Phase 11b: bot_sales_ops must not hold record_sale/deploy/proof.* or a domain wildcard';
  end if;
  if exists (
    select 1 from mcp_internal.mcp_bot_permissions p
    where p.permission_pattern = 'engineering.*'
  ) then
    raise exception 'Phase 14: engineering.* wildcard is forbidden';
  end if;
  if exists (
    select 1 from mcp_internal.mcp_bot_permissions p
    where p.bot_id <> 'bot_engineering'
      and p.permission_pattern in ('engineering.create_issue', 'engineering.get_issue')
  ) then
    raise exception 'Phase 14: issue tools must not be granted outside bot_engineering';
  end if;
  if exists (
    select 1 from mcp_internal.mcp_bot_permissions p
    where p.bot_id = 'bot_engineering'
      and (
        p.permission_pattern like 'railway%'
        or p.permission_pattern like 'secret%'
        or p.permission_pattern like 'infra%'
        or p.permission_pattern like '%deploy%'
        or p.permission_pattern like 'finance%'
        or p.permission_pattern like 'economics%'
      )
  ) then
    raise exception 'Phase 14: bot_engineering must not hold deploy, secrets, infra or finance grants';
  end if;
end
$$;
revoke all on function mcp_internal.assert_cos_prohibitions() from public, anon, authenticated;
grant execute on function mcp_internal.assert_cos_prohibitions() to service_role;

insert into mcp_internal.mcp_bot_permissions (bot_id, permission_pattern, granted_by)
select 'bot_engineering', name, 'phase-14:engineering-ops-allowlist'
from (values
  ('engineering.get_issue'),
  ('engineering.get_release_status'),
  ('engineering.get_deployment_status'),
  ('workflow.get_task'),
  ('workflow.list_tasks'),
  ('workflow.get_pending_approvals'),
  ('workflow.get_activity'),
  ('engineering.create_issue'),
  ('workflow.create_task'),
  ('workflow.assign_task'),
  ('workflow.complete_task'),
  ('workflow.create_approval')
) as v(name);

do $$
declare n integer;
begin
  select count(*) into n from mcp_internal.mcp_bot_permissions where bot_id = 'bot_engineering';
  if n is distinct from 12 then
    raise exception 'Phase 14: bot_engineering must have exactly 12 permission rows, found %', n;
  end if;
  if exists (
    select 1 from mcp_internal.mcp_bot_permissions
     where bot_id = 'bot_engineering' and permission_pattern = 'engineering.*'
  ) then
    raise exception 'Phase 14: engineering.* wildcard must be gone';
  end if;
  perform mcp_internal.assert_cos_prohibitions();
end
$$;

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
    ('public', 'client_sales_agents'),
    ('public', 'sales_agent_conversations'),
    ('public', 'metrics_daily'),
    ('public', 'scheduled_posts'),
    ('public', 'client_billing'),
    ('public', 'finance_entries'),
    ('public', 'finance_periods'),
    ('mcp_internal', 'mcp_bots'),
    ('mcp_internal', 'mcp_bot_tokens'),
    ('mcp_internal', 'mcp_bot_permissions'),
    ('mcp_internal', 'mcp_bot_token_audit'),
    ('mcp_internal', 'mcp_content_requests'),
    ('mcp_internal', 'mcp_pipeline_requests'),
    ('mcp_internal', 'mcp_sales_agent_requests'),
    ('mcp_internal', 'mcp_engineering_issues'),
    ('mcp_internal', 'mcp_engineering_requests')
  ) as t(nsp, rel)
  left join pg_class c
    on c.relname = t.rel
   and c.relnamespace = (select n.oid from pg_namespace n where n.nspname = t.nsp);
end;
$$;
revoke all on function mcp_internal.bot_touched_rls_status() from public, anon, authenticated;
grant execute on function mcp_internal.bot_touched_rls_status() to service_role;

commit;

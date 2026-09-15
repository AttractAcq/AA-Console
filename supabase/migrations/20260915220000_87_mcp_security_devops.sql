-- Phase 15: Security & DevOps MCP for bot_security_devops.
-- Exact 14-tool allowlist. Converts the seeded security.* wildcard to
-- four named security tools plus two engineering status reads and eight
-- workflow names.
-- DO NOT APPLY TO STAGING OR PRODUCTION without Alex via Chief of Staff.
-- Independent of Phase 13 Finance (migration 85) and Phase 14 Engineering
-- (migration 86) except shared engineering status RPCs already on main.
--
-- Gate 15 is read-heavy security status + finding tracking.
-- Highest-risk bot: no secret exfiltration, no unattended destroy, no
-- global/unscoped client access, no Railway write / secret rotation /
-- unrestricted deploy.
-- Every Bot RPC: require_active_bot + require_bot_client_grant; never can_access_client.
-- Isolation tests must stay green before registry unstub.
begin;

create table mcp_internal.mcp_security_findings (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id),
  title text not null check (length(btrim(title)) between 1 and 200),
  notes text check (length(notes) <= 2000),
  kind text not null default 'finding' check (kind in ('finding','incident')),
  severity text not null check (severity in ('low','medium','high','critical')),
  status text not null default 'open' check (status in ('open','in_progress','resolved','dismissed')),
  created_by_bot text not null references mcp_internal.mcp_bots(bot_id) check (created_by_bot='bot_security_devops'),
  updated_by_bot text not null references mcp_internal.mcp_bots(bot_id) check (updated_by_bot='bot_security_devops'),
  version integer not null default 1 check (version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index mcp_security_findings_client_idx on mcp_internal.mcp_security_findings(client_id, id);
create index mcp_security_findings_open_idx on mcp_internal.mcp_security_findings(client_id, kind, status, id);

create table mcp_internal.mcp_security_requests (
  bot_id text not null references mcp_internal.mcp_bots(bot_id),
  execution_id text not null check (execution_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  request_id text not null check (request_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  tool text not null check (tool = 'security.create_finding'),
  client_id uuid not null references public.clients(id),
  finding_id uuid not null references mcp_internal.mcp_security_findings(id),
  payload jsonb not null,
  result jsonb not null,
  created_at timestamptz not null default now(),
  primary key (bot_id, execution_id)
);

alter table mcp_internal.mcp_security_findings enable row level security;
alter table mcp_internal.mcp_security_findings force row level security;
alter table mcp_internal.mcp_security_requests enable row level security;
alter table mcp_internal.mcp_security_requests force row level security;
revoke all on mcp_internal.mcp_security_findings, mcp_internal.mcp_security_requests
  from public, anon, authenticated, service_role;

create function mcp_internal.require_security_permission(p_bot_id text, p_client_id uuid, p_tool text)
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
    'security.create_finding',
    'security.get_open_findings',
    'security.get_incident_status',
    'security.get_system_status'
  ) then
    raise exception using message = 'bot_forbidden', errcode = 'P0001';
  end if;
  if p_bot_id is distinct from 'bot_security_devops' then
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
revoke all on function mcp_internal.require_security_permission(text, uuid, text)
  from public, anon, authenticated, service_role;

create function mcp_internal.security_create_finding(
  p_bot_id text,
  p_client_id uuid,
  p_request_id text,
  p_execution_id text,
  p_title text,
  p_notes text,
  p_severity text,
  p_kind text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, mcp_internal, public
set timezone = 'UTC'
as $$
declare
  finding mcp_internal.mcp_security_findings;
  receipt mcp_internal.mcp_security_requests;
  payload jsonb;
  result jsonb;
  kind text;
begin
  perform mcp_internal.require_active_bot(p_bot_id);
  perform mcp_internal.require_bot_client_grant(p_bot_id, p_client_id);
  perform mcp_internal.require_security_permission(p_bot_id, p_client_id, 'security.create_finding');
  perform mcp_internal.require_mcp_ids(p_request_id, p_execution_id);
  kind := coalesce(p_kind, 'finding');
  if p_title is null or length(btrim(p_title)) not between 1 and 200
     or length(p_notes) > 2000
     or p_severity not in ('low','medium','high','critical')
     or kind not in ('finding','incident') then
    raise exception using message = 'invalid_request', errcode = 'P0001';
  end if;
  payload := jsonb_build_object(
    'title', p_title,
    'notes', p_notes,
    'severity', p_severity,
    'kind', kind
  );
  perform pg_advisory_xact_lock(hashtextextended(p_bot_id || ':security:' || p_execution_id, 0));
  select * into receipt
    from mcp_internal.mcp_security_requests
   where bot_id = p_bot_id and execution_id = p_execution_id;
  if found then
    if receipt.tool is distinct from 'security.create_finding'
       or receipt.client_id is distinct from p_client_id
       or receipt.payload is distinct from payload then
      raise exception using message = 'idempotency_conflict', errcode = 'P0001';
    end if;
    return receipt.result || jsonb_build_object('replayed', true);
  end if;
  insert into mcp_internal.mcp_security_findings (
    client_id, title, notes, kind, severity, created_by_bot, updated_by_bot
  ) values (
    p_client_id, btrim(p_title), p_notes, kind, p_severity, p_bot_id, p_bot_id
  ) returning * into finding;
  result := jsonb_build_object('client_id', p_client_id, 'finding', to_jsonb(finding), 'replayed', false);
  insert into mcp_internal.mcp_security_requests (
    bot_id, execution_id, request_id, tool, client_id, finding_id, payload, result
  ) values (
    p_bot_id, p_execution_id, p_request_id, 'security.create_finding', p_client_id, finding.id, payload, result
  );
  return result;
end
$$;

create function mcp_internal.security_get_open_findings(
  p_bot_id text,
  p_client_id uuid,
  p_limit integer default 25,
  p_after uuid default null,
  p_finding_id uuid default null
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
  perform mcp_internal.require_security_permission(p_bot_id, p_client_id, 'security.get_open_findings');
  if p_finding_id is not null and (p_after is not null or (p_limit is not null and p_limit is distinct from 25)) then
    raise exception using message = 'invalid_request', errcode = 'P0001';
  end if;
  if p_limit is null or p_limit not between 1 and 100 then
    raise exception using message = 'invalid_request', errcode = 'P0001';
  end if;
  if p_finding_id is not null then
    select to_jsonb(f) into items
      from mcp_internal.mcp_security_findings f
     where f.id = p_finding_id
       and f.client_id = p_client_id
       and f.kind = 'finding'
       and f.status in ('open','in_progress');
    if items is null then
      raise exception using message = 'finding_not_found', errcode = 'P0001';
    end if;
    return jsonb_build_object(
      'client_id', p_client_id,
      'findings', jsonb_build_array(items),
      'next_cursor', null
    );
  end if;
  if p_after is not null and not exists (
    select 1 from mcp_internal.mcp_security_findings
     where id = p_after and client_id = p_client_id and kind = 'finding'
  ) then
    raise exception using message = 'finding_not_found', errcode = 'P0001';
  end if;
  select coalesce(jsonb_agg(to_jsonb(x) order by x.id), '[]') into items from (
    select f.id, f.client_id, f.title, f.notes, f.kind, f.severity, f.status,
           f.created_by_bot, f.updated_by_bot, f.version, f.created_at, f.updated_at
      from mcp_internal.mcp_security_findings f
     where f.client_id = p_client_id
       and f.kind = 'finding'
       and f.status in ('open','in_progress')
       and (p_after is null or f.id > p_after)
     order by f.id
     limit p_limit + 1
  ) x;
  if jsonb_array_length(items) > p_limit then
    items := items - p_limit;
    cursor_id := (items -> (p_limit - 1) ->> 'id')::uuid;
  end if;
  return jsonb_build_object(
    'client_id', p_client_id,
    'findings', items,
    'next_cursor', cursor_id
  );
end
$$;

create function mcp_internal.security_get_incident_status(
  p_bot_id text,
  p_client_id uuid,
  p_limit integer default 25,
  p_after uuid default null,
  p_incident_id uuid default null
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
  perform mcp_internal.require_security_permission(p_bot_id, p_client_id, 'security.get_incident_status');
  if p_incident_id is not null and (p_after is not null or (p_limit is not null and p_limit is distinct from 25)) then
    raise exception using message = 'invalid_request', errcode = 'P0001';
  end if;
  if p_limit is null or p_limit not between 1 and 100 then
    raise exception using message = 'invalid_request', errcode = 'P0001';
  end if;
  if p_incident_id is not null then
    select to_jsonb(f) into items
      from mcp_internal.mcp_security_findings f
     where f.id = p_incident_id
       and f.client_id = p_client_id
       and f.kind = 'incident';
    if items is null then
      raise exception using message = 'incident_not_found', errcode = 'P0001';
    end if;
    return jsonb_build_object(
      'client_id', p_client_id,
      'incidents', jsonb_build_array(items),
      'next_cursor', null
    );
  end if;
  if p_after is not null and not exists (
    select 1 from mcp_internal.mcp_security_findings
     where id = p_after and client_id = p_client_id and kind = 'incident'
  ) then
    raise exception using message = 'incident_not_found', errcode = 'P0001';
  end if;
  select coalesce(jsonb_agg(to_jsonb(x) order by x.id), '[]') into items from (
    select f.id, f.client_id, f.title, f.notes, f.kind, f.severity, f.status,
           f.created_by_bot, f.updated_by_bot, f.version, f.created_at, f.updated_at
      from mcp_internal.mcp_security_findings f
     where f.client_id = p_client_id
       and f.kind = 'incident'
       and (p_after is null or f.id > p_after)
     order by f.id
     limit p_limit + 1
  ) x;
  if jsonb_array_length(items) > p_limit then
    items := items - p_limit;
    cursor_id := (items -> (p_limit - 1) ->> 'id')::uuid;
  end if;
  return jsonb_build_object(
    'client_id', p_client_id,
    'incidents', items,
    'next_cursor', cursor_id
  );
end
$$;

create function mcp_internal.security_get_system_status(p_bot_id text, p_client_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, mcp_internal, public
set timezone = 'UTC'
as $$
declare
  jobs jsonb;
  pages jsonb;
  open_findings integer;
  open_incidents integer;
begin
  perform mcp_internal.require_active_bot(p_bot_id);
  perform mcp_internal.require_bot_client_grant(p_bot_id, p_client_id);
  perform mcp_internal.require_security_permission(p_bot_id, p_client_id, 'security.get_system_status');
  select coalesce(jsonb_object_agg(status, n), '{}'::jsonb) into jobs from (
    select j.status::text as status, count(*)::int as n
      from public.agent_jobs j
     where j.client_id = p_client_id
     group by j.status
  ) s;
  select coalesce(jsonb_object_agg(status, n), '{}'::jsonb) into pages from (
    select p.status::text as status, count(*)::int as n
      from public.client_pages p
     where p.client_id = p_client_id
     group by p.status
  ) s;
  select count(*)::int into open_findings
    from mcp_internal.mcp_security_findings
   where client_id = p_client_id
     and kind = 'finding'
     and status in ('open','in_progress');
  select count(*)::int into open_incidents
    from mcp_internal.mcp_security_findings
   where client_id = p_client_id
     and kind = 'incident'
     and status in ('open','in_progress');
  return jsonb_build_object(
    'client_id', p_client_id,
    'projection', 'security_system_status_v1',
    'jobs_by_status', jobs,
    'pages_by_status', pages,
    'open_findings', open_findings,
    'open_incidents', open_incidents
  );
end
$$;

create function public.mcp_security_create_finding(
  p_bot_id text, p_client_id uuid, p_request_id text, p_execution_id text,
  p_title text, p_notes text, p_severity text, p_kind text
) returns jsonb
language plpgsql volatile security definer
set search_path = pg_catalog, mcp_internal, public
set timezone = 'UTC'
as $$
begin
  perform mcp_internal.require_service_role();
  perform mcp_internal.require_active_bot(p_bot_id);
  perform mcp_internal.require_bot_client_grant(p_bot_id, p_client_id);
  return mcp_internal.security_create_finding(
    p_bot_id, p_client_id, p_request_id, p_execution_id, p_title, p_notes, p_severity, p_kind
  );
end
$$;
revoke all on function public.mcp_security_create_finding(text, uuid, text, text, text, text, text, text)
  from public, anon, authenticated;
revoke all on function mcp_internal.security_create_finding(text, uuid, text, text, text, text, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.mcp_security_create_finding(text, uuid, text, text, text, text, text, text) to service_role;

create function public.mcp_security_get_open_findings(
  p_bot_id text, p_client_id uuid, p_limit integer default 25, p_after uuid default null, p_finding_id uuid default null
) returns jsonb
language plpgsql volatile security definer
set search_path = pg_catalog, mcp_internal, public
set timezone = 'UTC'
as $$
begin
  perform mcp_internal.require_service_role();
  perform mcp_internal.require_active_bot(p_bot_id);
  perform mcp_internal.require_bot_client_grant(p_bot_id, p_client_id);
  return mcp_internal.security_get_open_findings(p_bot_id, p_client_id, p_limit, p_after, p_finding_id);
end
$$;
revoke all on function public.mcp_security_get_open_findings(text, uuid, integer, uuid, uuid)
  from public, anon, authenticated;
revoke all on function mcp_internal.security_get_open_findings(text, uuid, integer, uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.mcp_security_get_open_findings(text, uuid, integer, uuid, uuid) to service_role;

create function public.mcp_security_get_incident_status(
  p_bot_id text, p_client_id uuid, p_limit integer default 25, p_after uuid default null, p_incident_id uuid default null
) returns jsonb
language plpgsql volatile security definer
set search_path = pg_catalog, mcp_internal, public
set timezone = 'UTC'
as $$
begin
  perform mcp_internal.require_service_role();
  perform mcp_internal.require_active_bot(p_bot_id);
  perform mcp_internal.require_bot_client_grant(p_bot_id, p_client_id);
  return mcp_internal.security_get_incident_status(p_bot_id, p_client_id, p_limit, p_after, p_incident_id);
end
$$;
revoke all on function public.mcp_security_get_incident_status(text, uuid, integer, uuid, uuid)
  from public, anon, authenticated;
revoke all on function mcp_internal.security_get_incident_status(text, uuid, integer, uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.mcp_security_get_incident_status(text, uuid, integer, uuid, uuid) to service_role;

create function public.mcp_security_get_system_status(p_bot_id text, p_client_id uuid) returns jsonb
language plpgsql volatile security definer
set search_path = pg_catalog, mcp_internal, public
set timezone = 'UTC'
as $$
begin
  perform mcp_internal.require_service_role();
  perform mcp_internal.require_active_bot(p_bot_id);
  perform mcp_internal.require_bot_client_grant(p_bot_id, p_client_id);
  return mcp_internal.security_get_system_status(p_bot_id, p_client_id);
end
$$;
revoke all on function public.mcp_security_get_system_status(text, uuid)
  from public, anon, authenticated;
revoke all on function mcp_internal.security_get_system_status(text, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.mcp_security_get_system_status(text, uuid) to service_role;

-- Remove the wildcard before the prohibition function starts rejecting it.
delete from mcp_internal.mcp_bot_permissions where bot_id = 'bot_security_devops';

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
    where p.bot_id = 'bot_finance'
      and (
        p.permission_pattern = 'economics.*'
        or p.permission_pattern like 'finance.%'
        or p.permission_pattern like '%payment%'
        or p.permission_pattern like '%stripe%'
        or p.permission_pattern like '%xero%'
        or p.permission_pattern like '%bank%'
        or p.permission_pattern = 'pipeline.record_sale'
      )
  ) then
    raise exception 'Phase 13: bot_finance must not hold economics.* wildcard or money-write/payment grants';
  end if;
  if exists (
    select 1 from mcp_internal.mcp_bot_permissions p
    where p.bot_id <> 'bot_finance'
      and p.permission_pattern like 'economics%'
  ) then
    raise exception 'Phase 13: economics.* must not be granted outside bot_finance';
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
        or p.permission_pattern in ('sales_agents.deploy', 'deploy')
        or p.permission_pattern like '%.deploy'
        or p.permission_pattern like 'deploy.%'
        or p.permission_pattern like 'finance%'
        or p.permission_pattern like 'economics%'
      )
  ) then
    raise exception 'Phase 14: bot_engineering must not hold deploy, secrets, infra or finance grants';
  end if;
  if exists (
    select 1 from mcp_internal.mcp_bot_permissions p
    where p.permission_pattern = 'security.*'
  ) then
    raise exception 'Phase 15: security.* wildcard is forbidden';
  end if;
  if exists (
    select 1 from mcp_internal.mcp_bot_permissions p
    where p.bot_id <> 'bot_security_devops'
      and (
        p.permission_pattern like 'security.%'
        or p.permission_pattern = 'security.*'
      )
  ) then
    raise exception 'Phase 15: security tools must not be granted outside bot_security_devops';
  end if;
  if exists (
    select 1 from mcp_internal.mcp_bot_permissions p
    where p.bot_id = 'bot_security_devops'
      and (
        p.permission_pattern like 'railway%'
        or p.permission_pattern like 'secret%'
        or p.permission_pattern like 'infra%'
        or p.permission_pattern like '%destroy%'
        or p.permission_pattern like '%rotate%'
        or p.permission_pattern in ('sales_agents.deploy', 'deploy')
        or p.permission_pattern like '%.deploy'
        or p.permission_pattern like 'deploy.%'
        or p.permission_pattern like '%global%'
        or p.permission_pattern = '*'
      )
  ) then
    raise exception 'Phase 15: bot_security_devops must not hold destroy, secrets, infra, deploy or global grants';
  end if;
end
$$;
revoke all on function mcp_internal.assert_cos_prohibitions() from public, anon, authenticated;
grant execute on function mcp_internal.assert_cos_prohibitions() to service_role;

insert into mcp_internal.mcp_bot_permissions (bot_id, permission_pattern, granted_by)
select 'bot_security_devops', name, 'phase-15:security-devops-allowlist'
from (values
  ('security.get_system_status'),
  ('security.get_open_findings'),
  ('security.get_incident_status'),
  ('engineering.get_release_status'),
  ('engineering.get_deployment_status'),
  ('workflow.get_task'),
  ('workflow.list_tasks'),
  ('workflow.get_pending_approvals'),
  ('workflow.get_activity'),
  ('security.create_finding'),
  ('workflow.create_task'),
  ('workflow.assign_task'),
  ('workflow.complete_task'),
  ('workflow.create_approval')
) as v(name);

do $$
declare n integer;
begin
  select count(*) into n from mcp_internal.mcp_bot_permissions where bot_id = 'bot_security_devops';
  if n is distinct from 14 then
    raise exception 'Phase 15: bot_security_devops must have exactly 14 permission rows, found %', n;
  end if;
  if exists (
    select 1 from mcp_internal.mcp_bot_permissions
     where bot_id = 'bot_security_devops' and permission_pattern = 'security.*'
  ) then
    raise exception 'Phase 15: security.* wildcard must be gone';
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
    ('mcp_internal', 'mcp_engineering_requests'),
    ('mcp_internal', 'mcp_security_findings'),
    ('mcp_internal', 'mcp_security_requests')
  ) as t(nsp, rel)
  left join pg_class c
    on c.relname = t.rel
   and c.relnamespace = (select n.oid from pg_namespace n where n.nspname = t.nsp);
end;
$$;
revoke all on function mcp_internal.bot_touched_rls_status() from public, anon, authenticated;
grant execute on function mcp_internal.bot_touched_rls_status() to service_role;

commit;

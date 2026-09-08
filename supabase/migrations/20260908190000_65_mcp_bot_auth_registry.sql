-- Phase 3 Bot auth registry.
-- DO NOT APPLY TO PRODUCTION without Alex approval.
-- No live Bearer secrets or token hashes are stored in this file.

create schema if not exists mcp_internal;
revoke all on schema mcp_internal from public, anon, authenticated;
grant usage on schema mcp_internal to service_role;

create or replace function mcp_internal.require_service_role()
returns void
language plpgsql
stable
set search_path = mcp_internal, public
as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using message = 'unauthorized', errcode = 'P0001';
  end if;
end;
$$;
revoke all on function mcp_internal.require_service_role() from public, anon, authenticated;
grant execute on function mcp_internal.require_service_role() to service_role;

-- Exact tool name, or single-segment domain wildcard only (content.* → content.<one segment>).
-- No substring matching and no multi-dot abuse.
create or replace function mcp_internal.permission_matches(p_grant text, p_tool text)
returns boolean
language sql
immutable
strict
set search_path = mcp_internal
as $$
  select
    p_grant = p_tool
    or (
      p_grant ~ '^[a-z0-9_]+\.\*$'
      and p_tool like regexp_replace(p_grant, '\*$', '') || '%'
      and length(p_tool) > length(regexp_replace(p_grant, '\*$', ''))
      and position('.' in substr(p_tool, length(regexp_replace(p_grant, '\*$', '')) + 1)) = 0
    );
$$;
revoke all on function mcp_internal.permission_matches(text, text) from public, anon, authenticated;
grant execute on function mcp_internal.permission_matches(text, text) to service_role;

create table mcp_internal.mcp_bots (
  bot_id text primary key check (bot_id ~ '^bot_[a-z0-9_]{1,60}$'),
  display_name text not null,
  status text not null default 'active' check (status in ('active', 'suspended', 'revoked')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger mcp_bots_set_updated_at
  before update on mcp_internal.mcp_bots
  for each row execute function set_updated_at();
alter table mcp_internal.mcp_bots enable row level security;
revoke all on mcp_internal.mcp_bots from public, anon, authenticated, service_role;

create table mcp_internal.mcp_bot_tokens (
  token_id uuid primary key default gen_random_uuid(),
  bot_id text not null references mcp_internal.mcp_bots(bot_id),
  token_hash bytea not null unique check (octet_length(token_hash) = 32),
  created_at timestamptz not null default now(),
  expires_at timestamptz,
  revoked_at timestamptz,
  rotated_from uuid references mcp_internal.mcp_bot_tokens(token_id),
  label text
);
create index mcp_bot_tokens_bot_revoked_idx
  on mcp_internal.mcp_bot_tokens (bot_id, revoked_at);
alter table mcp_internal.mcp_bot_tokens enable row level security;
revoke all on mcp_internal.mcp_bot_tokens from public, anon, authenticated, service_role;

create table mcp_internal.mcp_bot_permissions (
  bot_id text not null references mcp_internal.mcp_bots(bot_id),
  permission_pattern text not null
    check (
      permission_pattern ~ '^[a-z0-9_]+(\.[a-z0-9_]+)+$'
      or permission_pattern ~ '^[a-z0-9_]+\.\*$'
    ),
  granted_at timestamptz not null default now(),
  granted_by text not null,
  primary key (bot_id, permission_pattern)
);
alter table mcp_internal.mcp_bot_permissions enable row level security;
revoke all on mcp_internal.mcp_bot_permissions from public, anon, authenticated, service_role;

create table mcp_internal.mcp_bot_token_audit (
  id uuid primary key default gen_random_uuid(),
  bot_id text not null,
  token_id uuid,
  event text not null check (event in (
    'issue', 'rotate', 'revoke', 'expire', 'suspend_bot', 'restore_bot'
  )),
  actor text not null,
  reason text,
  created_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb
);
alter table mcp_internal.mcp_bot_token_audit enable row level security;
revoke all on mcp_internal.mcp_bot_token_audit from public, anon, authenticated, service_role;

insert into mcp_internal.mcp_bots (bot_id, display_name) values
  ('bot_chief_of_staff', 'Chief of Staff'),
  ('bot_client_delivery', 'Client Delivery'),
  ('bot_marketing', 'Marketing'),
  ('bot_production', 'Production Manager'),
  ('bot_distribution', 'Distribution'),
  ('bot_sales_ops', 'Sales Ops'),
  ('bot_admin', 'Admin'),
  ('bot_finance', 'Finance'),
  ('bot_engineering', 'Engineering'),
  ('bot_security_devops', 'Security / DevOps');

alter table public.mcp_bot_clients
  add column if not exists granted_at timestamptz not null default now(),
  add column if not exists granted_by text;
alter table public.mcp_bot_clients
  add constraint mcp_bot_clients_bot_id_fkey
  foreign key (bot_id) references mcp_internal.mcp_bots(bot_id);

insert into mcp_internal.mcp_bot_permissions (bot_id, permission_pattern, granted_by)
select bot_id, permission_pattern, 'seed:code-matrix'
from (values
  ('bot_chief_of_staff', 'delivery.*'),
  ('bot_chief_of_staff', 'campaign.*'),
  ('bot_chief_of_staff', 'workflow.*'),
  ('bot_chief_of_staff', 'attribution.*'),
  ('bot_client_delivery', 'delivery.*'),
  ('bot_client_delivery', 'workflow.*'),
  ('bot_client_delivery', 'campaign.get'),
  ('bot_client_delivery', 'campaign.get_status'),
  ('bot_client_delivery', 'content.get_production_status'),
  ('bot_marketing', 'campaign.*'),
  ('bot_marketing', 'content.*'),
  ('bot_marketing', 'conversion.*'),
  ('bot_marketing', 'proof.*'),
  ('bot_marketing', 'attribution.*'),
  ('bot_marketing', 'workflow.create_task'),
  ('bot_marketing', 'workflow.assign_task'),
  ('bot_marketing', 'workflow.get_task'),
  ('bot_marketing', 'workflow.list_tasks'),
  ('bot_marketing', 'workflow.complete_task'),
  ('bot_marketing', 'workflow.create_approval'),
  ('bot_marketing', 'workflow.get_pending_approvals'),
  ('bot_marketing', 'workflow.get_activity'),
  ('bot_production', 'content.*'),
  ('bot_production', 'proof.search'),
  ('bot_production', 'proof.get'),
  ('bot_production', 'proof.get_for_avatar'),
  ('bot_production', 'proof.get_for_claim'),
  ('bot_production', 'workflow.create_task'),
  ('bot_production', 'workflow.assign_task'),
  ('bot_production', 'workflow.get_task'),
  ('bot_production', 'workflow.list_tasks'),
  ('bot_production', 'workflow.complete_task'),
  ('bot_production', 'workflow.create_approval'),
  ('bot_production', 'workflow.get_pending_approvals'),
  ('bot_production', 'workflow.get_activity'),
  ('bot_distribution', 'content.get_brief'),
  ('bot_distribution', 'content.get_production_status'),
  ('bot_distribution', 'content.queue_distribution'),
  ('bot_distribution', 'content.get_performance'),
  ('bot_distribution', 'attribution.get_content_performance'),
  ('bot_distribution', 'workflow.create_task'),
  ('bot_distribution', 'workflow.assign_task'),
  ('bot_distribution', 'workflow.get_task'),
  ('bot_distribution', 'workflow.list_tasks'),
  ('bot_distribution', 'workflow.complete_task'),
  ('bot_distribution', 'workflow.create_approval'),
  ('bot_distribution', 'workflow.get_pending_approvals'),
  ('bot_distribution', 'workflow.get_activity'),
  ('bot_sales_ops', 'pipeline.*'),
  ('bot_sales_ops', 'sales_agents.*'),
  ('bot_sales_ops', 'proof.search'),
  ('bot_sales_ops', 'proof.get'),
  ('bot_sales_ops', 'workflow.create_task'),
  ('bot_sales_ops', 'workflow.assign_task'),
  ('bot_sales_ops', 'workflow.get_task'),
  ('bot_sales_ops', 'workflow.list_tasks'),
  ('bot_sales_ops', 'workflow.complete_task'),
  ('bot_sales_ops', 'workflow.create_approval'),
  ('bot_sales_ops', 'workflow.get_pending_approvals'),
  ('bot_sales_ops', 'workflow.get_activity'),
  ('bot_admin', 'delivery.list_clients'),
  ('bot_admin', 'delivery.get_client'),
  ('bot_admin', 'workflow.create_task'),
  ('bot_admin', 'workflow.assign_task'),
  ('bot_admin', 'workflow.get_task'),
  ('bot_admin', 'workflow.list_tasks'),
  ('bot_admin', 'workflow.complete_task'),
  ('bot_admin', 'workflow.create_approval'),
  ('bot_admin', 'workflow.get_pending_approvals'),
  ('bot_admin', 'workflow.get_activity'),
  ('bot_finance', 'economics.*'),
  ('bot_finance', 'attribution.get_revenue_attribution'),
  ('bot_finance', 'workflow.create_task'),
  ('bot_finance', 'workflow.assign_task'),
  ('bot_finance', 'workflow.get_task'),
  ('bot_finance', 'workflow.list_tasks'),
  ('bot_finance', 'workflow.complete_task'),
  ('bot_finance', 'workflow.create_approval'),
  ('bot_finance', 'workflow.get_pending_approvals'),
  ('bot_finance', 'workflow.get_activity'),
  ('bot_engineering', 'engineering.*'),
  ('bot_engineering', 'workflow.create_task'),
  ('bot_engineering', 'workflow.assign_task'),
  ('bot_engineering', 'workflow.get_task'),
  ('bot_engineering', 'workflow.list_tasks'),
  ('bot_engineering', 'workflow.complete_task'),
  ('bot_engineering', 'workflow.create_approval'),
  ('bot_engineering', 'workflow.get_pending_approvals'),
  ('bot_engineering', 'workflow.get_activity'),
  ('bot_security_devops', 'security.*'),
  ('bot_security_devops', 'engineering.get_release_status'),
  ('bot_security_devops', 'engineering.get_deployment_status'),
  ('bot_security_devops', 'workflow.create_task'),
  ('bot_security_devops', 'workflow.assign_task'),
  ('bot_security_devops', 'workflow.get_task'),
  ('bot_security_devops', 'workflow.list_tasks'),
  ('bot_security_devops', 'workflow.complete_task'),
  ('bot_security_devops', 'workflow.create_approval'),
  ('bot_security_devops', 'workflow.get_pending_approvals'),
  ('bot_security_devops', 'workflow.get_activity')
) as seed(bot_id, permission_pattern);

do $$
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

create or replace function mcp_internal.decode_token_hash(p_token_hash text)
returns bytea
language plpgsql
immutable
set search_path = mcp_internal
as $$
begin
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception using message = 'invalid_request', errcode = 'P0001';
  end if;
  return decode(p_token_hash, 'hex');
end;
$$;
revoke all on function mcp_internal.decode_token_hash(text) from public, anon, authenticated;
grant execute on function mcp_internal.decode_token_hash(text) to service_role;

create or replace function mcp_internal.audit_token(
  p_bot_id text, p_token_id uuid, p_event text, p_actor text, p_reason text, p_metadata jsonb
)
returns void
language plpgsql
security definer
set search_path = mcp_internal
as $$
begin
  insert into mcp_internal.mcp_bot_token_audit (bot_id, token_id, event, actor, reason, metadata)
  values (p_bot_id, p_token_id, p_event, p_actor, p_reason, coalesce(p_metadata, '{}'::jsonb));
end;
$$;
revoke all on function mcp_internal.audit_token(text, uuid, text, text, text, jsonb)
  from public, anon, authenticated, service_role;

create or replace function mcp_internal.resolve_bot_token(p_token_hash bytea)
returns jsonb
language plpgsql
security definer
set search_path = mcp_internal, public
as $$
declare
  v_token mcp_internal.mcp_bot_tokens;
  v_bot mcp_internal.mcp_bots;
  v_status text;
  v_clients jsonb;
  v_permissions jsonb;
begin
  perform mcp_internal.require_service_role();
  if p_token_hash is null or octet_length(p_token_hash) <> 32 then
    raise exception using message = 'invalid_request', errcode = 'P0001';
  end if;
  select * into v_token from mcp_internal.mcp_bot_tokens where token_hash = p_token_hash;
  if not found then
    return jsonb_build_object('found', false);
  end if;
  select * into v_bot from mcp_internal.mcp_bots where bot_id = v_token.bot_id;
  if v_token.revoked_at is not null then
    v_status := 'revoked_token';
  elsif v_token.expires_at is not null and v_token.expires_at <= now() then
    v_status := 'expired';
  elsif v_bot.status is distinct from 'active' then
    v_status := v_bot.status;
  else
    v_status := 'active';
  end if;
  if v_status is distinct from 'active' then
    return jsonb_build_object(
      'found', true,
      'status', v_status,
      'bot_id', v_token.bot_id,
      'token_id', v_token.token_id
    );
  end if;
  select coalesce(jsonb_agg(client_id order by client_id), '[]'::jsonb)
    into v_clients
    from public.mcp_bot_clients
    where bot_id = v_token.bot_id;
  select coalesce(jsonb_agg(permission_pattern order by permission_pattern), '[]'::jsonb)
    into v_permissions
    from mcp_internal.mcp_bot_permissions
    where bot_id = v_token.bot_id;
  return jsonb_build_object(
    'found', true,
    'status', 'active',
    'bot_id', v_token.bot_id,
    'token_id', v_token.token_id,
    'clients', v_clients,
    'permissions', v_permissions
  );
end;
$$;

create or replace function mcp_internal.issue_bot_token(
  p_bot_id text, p_token_hash bytea, p_label text, p_actor text, p_expires_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = mcp_internal, public
as $$
declare
  v_bot mcp_internal.mcp_bots;
  v_id uuid;
begin
  perform mcp_internal.require_service_role();
  if p_bot_id is null or p_bot_id !~ '^bot_[a-z0-9_]{1,60}$'
     or p_token_hash is null or octet_length(p_token_hash) <> 32
     or p_actor is null or length(p_actor) < 1 or length(p_actor) > 100 then
    raise exception using message = 'invalid_request', errcode = 'P0001';
  end if;
  select * into v_bot from mcp_internal.mcp_bots where bot_id = p_bot_id;
  if not found then raise exception using message = 'invalid_bot', errcode = 'P0001'; end if;
  if v_bot.status is distinct from 'active' then
    raise exception using message = 'bot_not_active', errcode = 'P0001';
  end if;
  begin
    insert into mcp_internal.mcp_bot_tokens (bot_id, token_hash, label, expires_at)
    values (p_bot_id, p_token_hash, p_label, p_expires_at)
    returning token_id into v_id;
  exception
    when unique_violation then
      raise exception using message = 'hash_conflict', errcode = 'P0001';
  end;
  perform mcp_internal.audit_token(p_bot_id, v_id, 'issue', p_actor, null,
    jsonb_strip_nulls(jsonb_build_object('label', p_label)));
  return jsonb_build_object('token_id', v_id, 'bot_id', p_bot_id);
end;
$$;

create or replace function mcp_internal.rotate_bot_token(
  p_old_token_hash bytea, p_new_token_hash bytea, p_label text, p_actor text
)
returns jsonb
language plpgsql
security definer
set search_path = mcp_internal, public
as $$
declare
  v_old mcp_internal.mcp_bot_tokens;
  v_bot mcp_internal.mcp_bots;
  v_id uuid;
begin
  perform mcp_internal.require_service_role();
  if p_old_token_hash is null or octet_length(p_old_token_hash) <> 32
     or p_new_token_hash is null or octet_length(p_new_token_hash) <> 32
     or p_old_token_hash = p_new_token_hash
     or p_actor is null or length(p_actor) < 1 or length(p_actor) > 100 then
    raise exception using message = 'invalid_request', errcode = 'P0001';
  end if;
  select * into v_old from mcp_internal.mcp_bot_tokens where token_hash = p_old_token_hash for update;
  if not found then raise exception using message = 'not_found', errcode = 'P0001'; end if;
  if v_old.revoked_at is not null then
    raise exception using message = 'token_revoked', errcode = 'P0001';
  end if;
  select * into v_bot from mcp_internal.mcp_bots where bot_id = v_old.bot_id;
  if v_bot.status is distinct from 'active' then
    raise exception using message = 'bot_not_active', errcode = 'P0001';
  end if;
  update mcp_internal.mcp_bot_tokens set revoked_at = now() where token_id = v_old.token_id;
  begin
    insert into mcp_internal.mcp_bot_tokens (bot_id, token_hash, label, rotated_from)
    values (v_old.bot_id, p_new_token_hash, p_label, v_old.token_id)
    returning token_id into v_id;
  exception
    when unique_violation then
      raise exception using message = 'hash_conflict', errcode = 'P0001';
  end;
  perform mcp_internal.audit_token(v_old.bot_id, v_id, 'rotate', p_actor, 'hard-cut',
    jsonb_strip_nulls(jsonb_build_object('label', p_label, 'rotated_from', v_old.token_id)));
  perform mcp_internal.audit_token(v_old.bot_id, v_old.token_id, 'revoke', p_actor, 'hard-cut rotate', '{}'::jsonb);
  return jsonb_build_object('token_id', v_id, 'bot_id', v_old.bot_id, 'rotated_from', v_old.token_id);
end;
$$;

create or replace function mcp_internal.revoke_bot_token(
  p_token_hash bytea, p_actor text, p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = mcp_internal, public
as $$
declare
  v_token mcp_internal.mcp_bot_tokens;
begin
  perform mcp_internal.require_service_role();
  if p_token_hash is null or octet_length(p_token_hash) <> 32
     or p_actor is null or length(p_actor) < 1 or length(p_actor) > 100 then
    raise exception using message = 'invalid_request', errcode = 'P0001';
  end if;
  select * into v_token from mcp_internal.mcp_bot_tokens where token_hash = p_token_hash for update;
  if not found then raise exception using message = 'not_found', errcode = 'P0001'; end if;
  if v_token.revoked_at is null then
    update mcp_internal.mcp_bot_tokens set revoked_at = now() where token_id = v_token.token_id;
    perform mcp_internal.audit_token(v_token.bot_id, v_token.token_id, 'revoke', p_actor, p_reason, '{}'::jsonb);
  end if;
  return jsonb_build_object('token_id', v_token.token_id, 'bot_id', v_token.bot_id, 'revoked', true);
end;
$$;

create or replace function mcp_internal.suspend_bot(p_bot_id text, p_actor text, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = mcp_internal, public
as $$
declare
  v_bot mcp_internal.mcp_bots;
begin
  perform mcp_internal.require_service_role();
  if p_bot_id is null or p_bot_id !~ '^bot_[a-z0-9_]{1,60}$'
     or p_actor is null or length(p_actor) < 1 or length(p_actor) > 100 then
    raise exception using message = 'invalid_request', errcode = 'P0001';
  end if;
  select * into v_bot from mcp_internal.mcp_bots where bot_id = p_bot_id for update;
  if not found then raise exception using message = 'invalid_bot', errcode = 'P0001'; end if;
  if v_bot.status = 'revoked' then
    raise exception using message = 'bot_not_active', errcode = 'P0001';
  end if;
  update mcp_internal.mcp_bots set status = 'suspended' where bot_id = p_bot_id;
  perform mcp_internal.audit_token(p_bot_id, null, 'suspend_bot', p_actor, p_reason, '{}'::jsonb);
  return jsonb_build_object('bot_id', p_bot_id, 'status', 'suspended');
end;
$$;

-- Public PostgREST wrappers: same posture as enqueue_mcp_brief.
-- Logic lives in mcp_internal; these exist only so the Data API can reach it
-- without exposing the mcp_internal schema.
create or replace function public.mcp_resolve_bot_token(p_token_hash text)
returns jsonb
language plpgsql
security definer
set search_path = mcp_internal, public
as $$
begin
  perform mcp_internal.require_service_role();
  return mcp_internal.resolve_bot_token(mcp_internal.decode_token_hash(p_token_hash));
end;
$$;

create or replace function public.mcp_issue_bot_token(
  p_bot_id text, p_token_hash text, p_actor text, p_label text default null, p_expires_at timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = mcp_internal, public
as $$
begin
  perform mcp_internal.require_service_role();
  return mcp_internal.issue_bot_token(
    p_bot_id, mcp_internal.decode_token_hash(p_token_hash), p_label, p_actor, p_expires_at
  );
end;
$$;

create or replace function public.mcp_rotate_bot_token(
  p_old_token_hash text, p_new_token_hash text, p_actor text, p_label text default null
)
returns jsonb
language plpgsql
security definer
set search_path = mcp_internal, public
as $$
begin
  perform mcp_internal.require_service_role();
  return mcp_internal.rotate_bot_token(
    mcp_internal.decode_token_hash(p_old_token_hash),
    mcp_internal.decode_token_hash(p_new_token_hash),
    p_label, p_actor
  );
end;
$$;

create or replace function public.mcp_revoke_bot_token(
  p_token_hash text, p_actor text, p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = mcp_internal, public
as $$
begin
  perform mcp_internal.require_service_role();
  return mcp_internal.revoke_bot_token(mcp_internal.decode_token_hash(p_token_hash), p_actor, p_reason);
end;
$$;

create or replace function public.mcp_suspend_bot(
  p_bot_id text, p_actor text, p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = mcp_internal, public
as $$
begin
  perform mcp_internal.require_service_role();
  return mcp_internal.suspend_bot(p_bot_id, p_actor, p_reason);
end;
$$;

revoke all on function public.mcp_resolve_bot_token(text) from public, anon, authenticated;
revoke all on function public.mcp_issue_bot_token(text, text, text, text, timestamptz) from public, anon, authenticated;
revoke all on function public.mcp_rotate_bot_token(text, text, text, text) from public, anon, authenticated;
revoke all on function public.mcp_revoke_bot_token(text, text, text) from public, anon, authenticated;
revoke all on function public.mcp_suspend_bot(text, text, text) from public, anon, authenticated;
grant execute on function public.mcp_resolve_bot_token(text) to service_role;
grant execute on function public.mcp_issue_bot_token(text, text, text, text, timestamptz) to service_role;
grant execute on function public.mcp_rotate_bot_token(text, text, text, text) to service_role;
grant execute on function public.mcp_revoke_bot_token(text, text, text) to service_role;
grant execute on function public.mcp_suspend_bot(text, text, text) to service_role;

revoke all on function mcp_internal.resolve_bot_token(bytea) from public, anon, authenticated;
revoke all on function mcp_internal.issue_bot_token(text, bytea, text, text, timestamptz) from public, anon, authenticated;
revoke all on function mcp_internal.rotate_bot_token(bytea, bytea, text, text) from public, anon, authenticated;
revoke all on function mcp_internal.revoke_bot_token(bytea, text, text) from public, anon, authenticated;
revoke all on function mcp_internal.suspend_bot(text, text, text) from public, anon, authenticated;
grant execute on function mcp_internal.resolve_bot_token(bytea) to service_role;
grant execute on function mcp_internal.issue_bot_token(text, bytea, text, text, timestamptz) to service_role;
grant execute on function mcp_internal.rotate_bot_token(bytea, bytea, text, text) to service_role;
grant execute on function mcp_internal.revoke_bot_token(bytea, text, text) to service_role;
grant execute on function mcp_internal.suspend_bot(text, text, text) to service_role;

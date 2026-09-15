-- Phase 16b: Sales Ops attach/enable/build + Proof Bank + production assign/submit.
-- Additive only. Do not apply to production without Alex via Chief of Staff.
--
-- Realize (not sales_agents.deploy, not approved_at, not usage_rights clearance):
--   sales_agents.attach_to_page, set_deployment_enabled, build
--   proof.search/get/create/attach_asset/get_for_avatar/get_for_claim
--   content.assign_production, content.submit_asset
--
-- Sales Ops ceiling after THIS migration: exactly 25 (Phase 11b's 22 + the
-- three names above). Phase 16c (PR #46, mig 91) additively grants
-- brand.get_profile, sites.provision, sites.publish_page → 28. Do not DELETE
-- attach/enable/build. Assert count=25 after this mig only.
--
-- Binding bars unchanged: require_active_bot + require_bot_client_grant on every
-- new Bot RPC; never can_access_client; no workflow.record_decision; deploy and
-- record_sale stay stub+ungranted.

begin;

-- ---------------------------------------------------------------------------
-- Ledger constraint expansions
-- ---------------------------------------------------------------------------

do $$
declare
  v_conname text;
begin
  select c.conname into v_conname
    from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
    join pg_attribute a on a.attrelid = t.oid and a.attname = 'tool'
   where n.nspname = 'mcp_internal'
     and t.relname = 'mcp_sales_agent_requests'
     and c.contype = 'c'
     and c.conkey = array[a.attnum];
  if v_conname is not null then
    execute format('alter table mcp_internal.mcp_sales_agent_requests drop constraint %I', v_conname);
  end if;
end $$;

alter table mcp_internal.mcp_sales_agent_requests
  add constraint mcp_sales_agent_requests_tool_check check (tool in (
    'sales_agents.generate_config',
    'sales_agents.create',
    'sales_agents.update_knowledge',
    'sales_agents.update_qualification_rules',
    'sales_agents.test',
    'sales_agents.attach_to_page',
    'sales_agents.set_deployment_enabled',
    'sales_agents.build'
  ));

do $$
declare
  v_conname text;
begin
  select c.conname into v_conname
    from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
    join pg_attribute a on a.attrelid = t.oid and a.attname = 'tool'
   where n.nspname = 'mcp_internal'
     and t.relname = 'mcp_content_requests'
     and c.contype = 'c'
     and c.conkey = array[a.attnum];
  if v_conname is not null then
    execute format('alter table mcp_internal.mcp_content_requests drop constraint %I', v_conname);
  end if;
end $$;

alter table mcp_internal.mcp_content_requests
  add constraint mcp_content_requests_tool_check check (tool in (
    'content.request_revision',
    'content.request_approval',
    'content.create_repurpose_plan',
    'content.select_idea',
    'content.approve_asset',
    'content.queue_distribution',
    'content.record_publication',
    'content.assign_production',
    'content.submit_asset'
  ));

-- Proof write ledger. Separate domain from content/sales-agent ledgers.
create table mcp_internal.mcp_proof_requests (
  bot_id text not null,
  execution_id text not null
    check (execution_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  request_id text not null
    check (request_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  tool text not null check (tool in (
    'proof.create',
    'proof.attach_asset'
  )),
  client_id uuid not null references public.clients(id),
  proof_id uuid references public.client_proof_assets(id),
  payload jsonb not null default '{}'::jsonb,
  result jsonb not null,
  created_at timestamptz not null default now(),
  primary key (bot_id, execution_id)
);
create index mcp_proof_requests_client_idx
  on mcp_internal.mcp_proof_requests (client_id, created_at desc);
alter table mcp_internal.mcp_proof_requests enable row level security;
alter table mcp_internal.mcp_proof_requests force row level security;
revoke all on mcp_internal.mcp_proof_requests
  from public, anon, authenticated, service_role;

create or replace function mcp_internal.take_proof_request(
  p_bot_id text, p_execution_id text, p_tool text, p_client_id uuid, p_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = mcp_internal, public
as $$
declare
  v_row mcp_internal.mcp_proof_requests;
begin
  perform mcp_internal.require_service_role();
  perform pg_advisory_xact_lock(hashtextextended(p_bot_id || ':' || p_execution_id, 3));
  select * into v_row
    from mcp_internal.mcp_proof_requests
   where bot_id = p_bot_id and execution_id = p_execution_id;
  if found then
    if v_row.tool is distinct from p_tool
       or v_row.client_id is distinct from p_client_id
       or v_row.payload is distinct from p_payload then
      raise exception using message = 'idempotency_conflict', errcode = 'P0001';
    end if;
    return v_row.result || jsonb_build_object('replayed', true);
  end if;
  return null;
end;
$$;
revoke all on function mcp_internal.take_proof_request(text, text, text, uuid, jsonb)
  from public, anon, authenticated;
grant execute on function mcp_internal.take_proof_request(text, text, text, uuid, jsonb)
  to service_role;

-- Origin from a published URL: scheme+host only, same as originForPage().
create or replace function mcp_internal.origin_for_page(p_url text)
returns text
language plpgsql
immutable
set search_path = pg_catalog
as $$
declare
  v_match text[];
begin
  if p_url is null or length(trim(p_url)) = 0 then
    return null;
  end if;
  v_match := regexp_match(p_url, '^(https?://[^/]+)');
  if v_match is null then
    return null;
  end if;
  return v_match[1];
end;
$$;
revoke all on function mcp_internal.origin_for_page(text)
  from public, anon, authenticated;
grant execute on function mcp_internal.origin_for_page(text) to service_role;

create or replace function mcp_internal.enqueue_sales_agent_build(
  p_client_id uuid, p_sales_agent_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = mcp_internal, public
as $$
declare
  v_job uuid;
begin
  begin
    v_job := public.enqueue_agent_job_internal(
      'sales_agent', p_client_id, 'client_sales_agents', p_sales_agent_id,
      null, '{}'::jsonb, 'Queued by MCP sales_agents.build');
  exception
    when raise_exception then
      raise exception using message = 'queue_failure', errcode = 'P0001';
    when others then
      raise exception using message = 'queue_failure', errcode = 'P0001';
  end;
  update client_sales_agents set job_id = v_job, updated_at = now()
   where id = p_sales_agent_id;
  return v_job;
end;
$$;
revoke all on function mcp_internal.enqueue_sales_agent_build(uuid, uuid)
  from public, anon, authenticated, service_role;

create or replace function mcp_internal.proof_json(p client_proof_assets)
returns jsonb
language plpgsql
stable
security definer
set search_path = mcp_internal, public
as $$
declare r jsonb := to_jsonb(p);
begin
  return jsonb_build_object(
    'id', r->>'id',
    'client_id', r->>'client_id',
    'ref_number', r->>'ref_number',
    'media_type', r->>'media_type',
    'title', mcp_internal.clip_text(r->>'title'),
    'body', mcp_internal.clip_text(r->>'body'),
    'storage_path', r->>'storage_path',
    'source', mcp_internal.clip_text(r->>'source'),
    'proof_type', r->>'proof_type',
    'claim', mcp_internal.clip_text(r->>'claim'),
    'evidence', mcp_internal.clip_text(r->>'evidence'),
    'avatar_relevance', mcp_internal.clip_text(r->>'avatar_relevance'),
    'strength', r->>'strength',
    'usage_rights', r->>'usage_rights',
    'captured_on', r->>'captured_on',
    'expires_on', r->>'expires_on',
    'created_at', r->>'created_at'
  );
end;
$$;
revoke all on function mcp_internal.proof_json(client_proof_assets)
  from public, anon, authenticated;
grant execute on function mcp_internal.proof_json(client_proof_assets) to service_role;

create or replace function mcp_internal.deployment_json(d client_sales_agent_deployments)
returns jsonb
language plpgsql
stable
security definer
set search_path = mcp_internal, public
as $$
declare r jsonb := to_jsonb(d);
begin
  return jsonb_build_object(
    'id', r->>'id',
    'client_id', r->>'client_id',
    'sales_agent_id', r->>'sales_agent_id',
    'page_id', r->>'page_id',
    'public_id', r->>'public_id',
    'allowed_origin', r->>'allowed_origin',
    'enabled', (r->>'enabled')::boolean,
    'deployed_at', r->>'deployed_at',
    'disabled_at', r->>'disabled_at',
    'created_at', r->>'created_at'
  );
end;
$$;
revoke all on function mcp_internal.deployment_json(client_sales_agent_deployments)
  from public, anon, authenticated;
grant execute on function mcp_internal.deployment_json(client_sales_agent_deployments) to service_role;

-- ---------------------------------------------------------------------------
-- sales_agents.attach_to_page
-- ---------------------------------------------------------------------------

create or replace function mcp_internal.attach_sales_agent_to_page(
  p_bot_id text, p_request_id text, p_execution_id text, p_client_id uuid,
  p_sales_agent_id uuid, p_page_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = mcp_internal, public
as $$
declare
  v_agent client_sales_agents;
  v_page client_pages;
  v_origin text;
  v_existing jsonb;
  v_payload jsonb;
  v_dep client_sales_agent_deployments;
  v_result jsonb;
begin
  perform mcp_internal.require_active_bot(p_bot_id);
  perform mcp_internal.require_bot_client_grant(p_bot_id, p_client_id);
  if p_bot_id <> 'bot_sales_ops' then
    raise exception using message = 'bot_forbidden', errcode = 'P0001';
  end if;
  perform mcp_internal.require_mcp_ids(p_request_id, p_execution_id);
  if p_sales_agent_id is null or p_page_id is null then
    raise exception using message = 'invalid_request', errcode = 'P0001';
  end if;

  v_payload := jsonb_build_object('sales_agent_id', p_sales_agent_id, 'page_id', p_page_id);
  v_existing := mcp_internal.take_sales_agent_request(
    p_bot_id, p_execution_id, 'sales_agents.attach_to_page', p_client_id, v_payload);
  if v_existing is not null then
    return v_existing;
  end if;

  select * into v_agent from client_sales_agents where id = p_sales_agent_id for update;
  if not found then
    raise exception using message = 'sales_agent_not_found', errcode = 'P0001';
  end if;
  if v_agent.client_id <> p_client_id then
    raise exception using message = 'client_mismatch', errcode = 'P0001';
  end if;
  -- Same order as deployBlocker in src/pages/sites/readiness.ts.
  if v_agent.built_at is null then
    raise exception using message = 'agent_not_ready', errcode = 'P0001';
  end if;
  if v_agent.approved_at is null then
    raise exception using message = 'agent_not_ready', errcode = 'P0001';
  end if;
  if v_agent.status is distinct from 'live' then
    raise exception using message = 'agent_not_ready', errcode = 'P0001';
  end if;

  select * into v_page from client_pages where id = p_page_id for share;
  if not found then
    raise exception using message = 'page_not_found', errcode = 'P0001';
  end if;
  if v_page.client_id <> p_client_id then
    raise exception using message = 'client_mismatch', errcode = 'P0001';
  end if;
  if v_page.publish_status is distinct from 'published' or v_page.published_url is null then
    raise exception using message = 'page_not_published', errcode = 'P0001';
  end if;
  v_origin := mcp_internal.origin_for_page(v_page.published_url);
  if v_origin is null then
    raise exception using message = 'origin_unavailable', errcode = 'P0001';
  end if;

  select * into v_dep
    from client_sales_agent_deployments
   where sales_agent_id = p_sales_agent_id and page_id = p_page_id
   limit 1;
  if found then
    raise exception using message = 'already_attached', errcode = 'P0001';
  end if;

  insert into client_sales_agent_deployments (
    client_id, sales_agent_id, page_id, site_repository_id, allowed_origin, enabled
  ) values (
    p_client_id, p_sales_agent_id, p_page_id, v_page.site_repository_id, v_origin, false
  ) returning * into v_dep;

  v_result := jsonb_build_object('client_id', p_client_id, 'replayed', false)
    || mcp_internal.deployment_json(v_dep);
  insert into mcp_internal.mcp_sales_agent_requests (
    bot_id, execution_id, request_id, tool, client_id, sales_agent_id, payload, result
  ) values (
    p_bot_id, p_execution_id, p_request_id, 'sales_agents.attach_to_page',
    p_client_id, p_sales_agent_id, v_payload, v_result
  );
  return v_result;
end;
$$;
revoke all on function mcp_internal.attach_sales_agent_to_page(text, text, text, uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function mcp_internal.attach_sales_agent_to_page(text, text, text, uuid, uuid, uuid)
  to service_role;

create or replace function public.mcp_attach_sales_agent_to_page(
  p_bot_id text, p_request_id text, p_execution_id text, p_client_id uuid,
  p_sales_agent_id uuid, p_page_id uuid
)
returns jsonb language plpgsql security definer set search_path = mcp_internal, public as $$
begin
  perform mcp_internal.require_service_role();
  return mcp_internal.attach_sales_agent_to_page(
    p_bot_id, p_request_id, p_execution_id, p_client_id, p_sales_agent_id, p_page_id);
end;
$$;
revoke all on function public.mcp_attach_sales_agent_to_page(text, text, text, uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.mcp_attach_sales_agent_to_page(text, text, text, uuid, uuid, uuid)
  to service_role;

-- ---------------------------------------------------------------------------
-- sales_agents.set_deployment_enabled
-- ---------------------------------------------------------------------------

create or replace function mcp_internal.set_sales_agent_deployment_enabled(
  p_bot_id text, p_request_id text, p_execution_id text, p_client_id uuid,
  p_deployment_id uuid, p_enabled boolean
)
returns jsonb
language plpgsql
security definer
set search_path = mcp_internal, public
as $$
declare
  v_dep client_sales_agent_deployments;
  v_existing jsonb;
  v_payload jsonb;
  v_result jsonb;
begin
  perform mcp_internal.require_active_bot(p_bot_id);
  perform mcp_internal.require_bot_client_grant(p_bot_id, p_client_id);
  if p_bot_id <> 'bot_sales_ops' then
    raise exception using message = 'bot_forbidden', errcode = 'P0001';
  end if;
  perform mcp_internal.require_mcp_ids(p_request_id, p_execution_id);
  if p_deployment_id is null or p_enabled is null then
    raise exception using message = 'invalid_request', errcode = 'P0001';
  end if;

  v_payload := jsonb_build_object('deployment_id', p_deployment_id, 'enabled', p_enabled);
  v_existing := mcp_internal.take_sales_agent_request(
    p_bot_id, p_execution_id, 'sales_agents.set_deployment_enabled', p_client_id, v_payload);
  if v_existing is not null then
    return v_existing;
  end if;

  select * into v_dep from client_sales_agent_deployments where id = p_deployment_id for update;
  if not found then
    raise exception using message = 'deployment_not_found', errcode = 'P0001';
  end if;
  if v_dep.client_id <> p_client_id then
    raise exception using message = 'client_mismatch', errcode = 'P0001';
  end if;

  begin
    if p_enabled then
      update client_sales_agent_deployments
         set enabled = true,
             disabled_at = null,
             deployed_at = now(),
             updated_at = now()
       where id = p_deployment_id
       returning * into v_dep;
    else
      update client_sales_agent_deployments
         set enabled = false,
             disabled_at = now(),
             updated_at = now()
       where id = p_deployment_id
       returning * into v_dep;
    end if;
  exception
    when unique_violation then
      raise exception using message = 'deployment_conflict', errcode = 'P0001';
  end;

  v_result := jsonb_build_object('client_id', p_client_id, 'replayed', false)
    || mcp_internal.deployment_json(v_dep);
  insert into mcp_internal.mcp_sales_agent_requests (
    bot_id, execution_id, request_id, tool, client_id, sales_agent_id, payload, result
  ) values (
    p_bot_id, p_execution_id, p_request_id, 'sales_agents.set_deployment_enabled',
    p_client_id, v_dep.sales_agent_id, v_payload, v_result
  );
  return v_result;
end;
$$;
revoke all on function mcp_internal.set_sales_agent_deployment_enabled(text, text, text, uuid, uuid, boolean)
  from public, anon, authenticated;
grant execute on function mcp_internal.set_sales_agent_deployment_enabled(text, text, text, uuid, uuid, boolean)
  to service_role;

create or replace function public.mcp_set_sales_agent_deployment_enabled(
  p_bot_id text, p_request_id text, p_execution_id text, p_client_id uuid,
  p_deployment_id uuid, p_enabled boolean
)
returns jsonb language plpgsql security definer set search_path = mcp_internal, public as $$
begin
  perform mcp_internal.require_service_role();
  return mcp_internal.set_sales_agent_deployment_enabled(
    p_bot_id, p_request_id, p_execution_id, p_client_id, p_deployment_id, p_enabled);
end;
$$;
revoke all on function public.mcp_set_sales_agent_deployment_enabled(text, text, text, uuid, uuid, boolean)
  from public, anon, authenticated;
grant execute on function public.mcp_set_sales_agent_deployment_enabled(text, text, text, uuid, uuid, boolean)
  to service_role;

-- ---------------------------------------------------------------------------
-- sales_agents.build — enqueue sales_agent job for an existing draft/live row.
-- create stays draft-only (mig 84); this is the Console enqueue step.
-- ---------------------------------------------------------------------------

create or replace function mcp_internal.build_sales_agent(
  p_bot_id text, p_request_id text, p_execution_id text, p_client_id uuid,
  p_sales_agent_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = mcp_internal, public
as $$
declare
  v_agent client_sales_agents;
  v_existing jsonb;
  v_payload jsonb;
  v_job uuid;
  v_result jsonb;
begin
  perform mcp_internal.require_active_bot(p_bot_id);
  perform mcp_internal.require_bot_client_grant(p_bot_id, p_client_id);
  if p_bot_id <> 'bot_sales_ops' then
    raise exception using message = 'bot_forbidden', errcode = 'P0001';
  end if;
  perform mcp_internal.require_mcp_ids(p_request_id, p_execution_id);
  if p_sales_agent_id is null then
    raise exception using message = 'invalid_request', errcode = 'P0001';
  end if;

  v_payload := jsonb_build_object('sales_agent_id', p_sales_agent_id);
  v_existing := mcp_internal.take_sales_agent_request(
    p_bot_id, p_execution_id, 'sales_agents.build', p_client_id, v_payload);
  if v_existing is not null then
    return v_existing;
  end if;

  select * into v_agent from client_sales_agents where id = p_sales_agent_id for update;
  if not found then
    raise exception using message = 'sales_agent_not_found', errcode = 'P0001';
  end if;
  if v_agent.client_id <> p_client_id then
    raise exception using message = 'client_mismatch', errcode = 'P0001';
  end if;

  v_job := mcp_internal.enqueue_sales_agent_build(p_client_id, p_sales_agent_id);
  select * into v_agent from client_sales_agents where id = p_sales_agent_id;

  v_result := jsonb_build_object(
    'client_id', p_client_id, 'replayed', false, 'job_id', v_job
  ) || mcp_internal.sales_agent_json(v_agent);
  insert into mcp_internal.mcp_sales_agent_requests (
    bot_id, execution_id, request_id, tool, client_id, sales_agent_id, payload, result
  ) values (
    p_bot_id, p_execution_id, p_request_id, 'sales_agents.build',
    p_client_id, p_sales_agent_id, v_payload, v_result
  );
  return v_result;
end;
$$;
revoke all on function mcp_internal.build_sales_agent(text, text, text, uuid, uuid)
  from public, anon, authenticated;
grant execute on function mcp_internal.build_sales_agent(text, text, text, uuid, uuid)
  to service_role;

create or replace function public.mcp_build_sales_agent(
  p_bot_id text, p_request_id text, p_execution_id text, p_client_id uuid,
  p_sales_agent_id uuid
)
returns jsonb language plpgsql security definer set search_path = mcp_internal, public as $$
begin
  perform mcp_internal.require_service_role();
  return mcp_internal.build_sales_agent(
    p_bot_id, p_request_id, p_execution_id, p_client_id, p_sales_agent_id);
end;
$$;
revoke all on function public.mcp_build_sales_agent(text, text, text, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.mcp_build_sales_agent(text, text, text, uuid, uuid)
  to service_role;

-- ---------------------------------------------------------------------------
-- proof reads (bot_production granted; any granted bot may call at RPC layer)
-- ---------------------------------------------------------------------------

create or replace function mcp_internal.proof_search(
  p_bot_id text, p_client_id uuid, p_limit integer default 25,
  p_q text default null, p_media_type text default null, p_proof_type text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = mcp_internal, public
as $$
declare
  v_limit integer;
  v_rows jsonb;
begin
  perform mcp_internal.require_active_bot(p_bot_id);
  perform mcp_internal.require_bot_client_grant(p_bot_id, p_client_id);
  v_limit := least(greatest(coalesce(p_limit, 25), 1), 100);
  if p_media_type is not null and p_media_type not in ('image', 'video', 'text') then
    raise exception using message = 'invalid_request', errcode = 'P0001';
  end if;

  select coalesce(jsonb_agg(mcp_internal.proof_json(p) order by p.created_at desc), '[]'::jsonb)
    into v_rows
    from (
      select *
        from client_proof_assets x
       where x.client_id = p_client_id
         and (p_media_type is null or x.media_type::text = p_media_type)
         and (p_proof_type is null or x.proof_type = p_proof_type)
         and (
           p_q is null or length(trim(p_q)) = 0
           or x.claim ilike '%' || p_q || '%'
           or x.title ilike '%' || p_q || '%'
           or x.body ilike '%' || p_q || '%'
           or x.source ilike '%' || p_q || '%'
           or x.evidence ilike '%' || p_q || '%'
         )
       order by x.created_at desc
       limit v_limit
    ) p;

  return jsonb_build_object(
    'client_id', p_client_id,
    'proof', v_rows,
    'count', jsonb_array_length(v_rows)
  );
end;
$$;
revoke all on function mcp_internal.proof_search(text, uuid, integer, text, text, text)
  from public, anon, authenticated;
grant execute on function mcp_internal.proof_search(text, uuid, integer, text, text, text)
  to service_role;

create or replace function public.mcp_proof_search(
  p_bot_id text, p_client_id uuid, p_limit integer default 25,
  p_q text default null, p_media_type text default null, p_proof_type text default null
)
returns jsonb language plpgsql security definer set search_path = mcp_internal, public as $$
begin
  perform mcp_internal.require_service_role();
  return mcp_internal.proof_search(p_bot_id, p_client_id, p_limit, p_q, p_media_type, p_proof_type);
end;
$$;
revoke all on function public.mcp_proof_search(text, uuid, integer, text, text, text)
  from public, anon, authenticated;
grant execute on function public.mcp_proof_search(text, uuid, integer, text, text, text)
  to service_role;

create or replace function mcp_internal.proof_get(
  p_bot_id text, p_client_id uuid, p_proof_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = mcp_internal, public
as $$
declare
  v_proof client_proof_assets;
begin
  perform mcp_internal.require_active_bot(p_bot_id);
  perform mcp_internal.require_bot_client_grant(p_bot_id, p_client_id);
  if p_proof_id is null then
    raise exception using message = 'invalid_request', errcode = 'P0001';
  end if;
  select * into v_proof from client_proof_assets where id = p_proof_id;
  if not found then
    raise exception using message = 'proof_not_found', errcode = 'P0001';
  end if;
  if v_proof.client_id <> p_client_id then
    raise exception using message = 'client_mismatch', errcode = 'P0001';
  end if;
  return jsonb_build_object('client_id', p_client_id) || mcp_internal.proof_json(v_proof);
end;
$$;
revoke all on function mcp_internal.proof_get(text, uuid, uuid)
  from public, anon, authenticated;
grant execute on function mcp_internal.proof_get(text, uuid, uuid)
  to service_role;

create or replace function public.mcp_proof_get(
  p_bot_id text, p_client_id uuid, p_proof_id uuid
)
returns jsonb language plpgsql security definer set search_path = mcp_internal, public as $$
begin
  perform mcp_internal.require_service_role();
  return mcp_internal.proof_get(p_bot_id, p_client_id, p_proof_id);
end;
$$;
revoke all on function public.mcp_proof_get(text, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.mcp_proof_get(text, uuid, uuid)
  to service_role;

create or replace function mcp_internal.proof_get_for_avatar(
  p_bot_id text, p_client_id uuid, p_avatar text, p_limit integer default 10
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = mcp_internal, public
as $$
declare
  v_limit integer;
  v_rows jsonb;
begin
  perform mcp_internal.require_active_bot(p_bot_id);
  perform mcp_internal.require_bot_client_grant(p_bot_id, p_client_id);
  if p_avatar is null or length(trim(p_avatar)) < 1 or length(p_avatar) > 300 then
    raise exception using message = 'invalid_request', errcode = 'P0001';
  end if;
  v_limit := least(greatest(coalesce(p_limit, 10), 1), 50);

  -- Same usable-proof rule as public.usable_proof, after Bot grant (never
  -- can_access_client). Only human-cleared, unexpired rows.
  select coalesce(jsonb_agg(mcp_internal.proof_json(p)), '[]'::jsonb)
    into v_rows
    from (
      select *
        from client_proof_assets x
       where x.client_id = p_client_id
         and x.usage_rights = 'approved'
         and (x.expires_on is null or x.expires_on >= current_date)
         and (x.avatar_relevance is null or x.avatar_relevance ilike '%' || p_avatar || '%')
       order by case x.strength when 'high' then 0 when 'medium' then 1 else 2 end,
                x.captured_on desc nulls last,
                x.created_at desc
       limit v_limit
    ) p;

  return jsonb_build_object(
    'client_id', p_client_id,
    'proof', v_rows,
    'count', jsonb_array_length(v_rows)
  );
end;
$$;
revoke all on function mcp_internal.proof_get_for_avatar(text, uuid, text, integer)
  from public, anon, authenticated;
grant execute on function mcp_internal.proof_get_for_avatar(text, uuid, text, integer)
  to service_role;

create or replace function public.mcp_proof_get_for_avatar(
  p_bot_id text, p_client_id uuid, p_avatar text, p_limit integer default 10
)
returns jsonb language plpgsql security definer set search_path = mcp_internal, public as $$
begin
  perform mcp_internal.require_service_role();
  return mcp_internal.proof_get_for_avatar(p_bot_id, p_client_id, p_avatar, p_limit);
end;
$$;
revoke all on function public.mcp_proof_get_for_avatar(text, uuid, text, integer)
  from public, anon, authenticated;
grant execute on function public.mcp_proof_get_for_avatar(text, uuid, text, integer)
  to service_role;

create or replace function mcp_internal.proof_get_for_claim(
  p_bot_id text, p_client_id uuid, p_claim text, p_limit integer default 10
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = mcp_internal, public
as $$
declare
  v_limit integer;
  v_rows jsonb;
begin
  perform mcp_internal.require_active_bot(p_bot_id);
  perform mcp_internal.require_bot_client_grant(p_bot_id, p_client_id);
  if p_claim is null or length(trim(p_claim)) < 1 or length(p_claim) > 400 then
    raise exception using message = 'invalid_request', errcode = 'P0001';
  end if;
  v_limit := least(greatest(coalesce(p_limit, 10), 1), 50);

  select coalesce(jsonb_agg(mcp_internal.proof_json(p)), '[]'::jsonb)
    into v_rows
    from (
      select *
        from client_proof_assets x
       where x.client_id = p_client_id
         and x.usage_rights = 'approved'
         and (x.expires_on is null or x.expires_on >= current_date)
         and x.claim ilike '%' || p_claim || '%'
       order by case x.strength when 'high' then 0 when 'medium' then 1 else 2 end,
                x.created_at desc
       limit v_limit
    ) p;

  return jsonb_build_object(
    'client_id', p_client_id,
    'proof', v_rows,
    'count', jsonb_array_length(v_rows)
  );
end;
$$;
revoke all on function mcp_internal.proof_get_for_claim(text, uuid, text, integer)
  from public, anon, authenticated;
grant execute on function mcp_internal.proof_get_for_claim(text, uuid, text, integer)
  to service_role;

create or replace function public.mcp_proof_get_for_claim(
  p_bot_id text, p_client_id uuid, p_claim text, p_limit integer default 10
)
returns jsonb language plpgsql security definer set search_path = mcp_internal, public as $$
begin
  perform mcp_internal.require_service_role();
  return mcp_internal.proof_get_for_claim(p_bot_id, p_client_id, p_claim, p_limit);
end;
$$;
revoke all on function public.mcp_proof_get_for_claim(text, uuid, text, integer)
  from public, anon, authenticated;
grant execute on function public.mcp_proof_get_for_claim(text, uuid, text, integer)
  to service_role;

-- ---------------------------------------------------------------------------
-- proof.create / attach_asset — usage_rights is forced not_cleared; no param.
-- ---------------------------------------------------------------------------

create or replace function mcp_internal.proof_create(
  p_bot_id text, p_request_id text, p_execution_id text, p_client_id uuid,
  p_media_type text, p_title text default null, p_body text default null,
  p_source text default null, p_storage_path text default null,
  p_claim text default null, p_evidence text default null,
  p_avatar_relevance text default null, p_proof_type text default null,
  p_strength text default 'medium'
)
returns jsonb
language plpgsql
security definer
set search_path = mcp_internal, public
as $$
declare
  v_payload jsonb;
  v_existing jsonb;
  v_proof client_proof_assets;
  v_result jsonb;
  v_types text[] := array[
    'customer_result','testimonial','review','case_study','before_after',
    'stat','credential','award','press','process','team_expertise','customer_story'
  ];
begin
  perform mcp_internal.require_active_bot(p_bot_id);
  perform mcp_internal.require_bot_client_grant(p_bot_id, p_client_id);
  if p_bot_id <> 'bot_production' then
    raise exception using message = 'bot_forbidden', errcode = 'P0001';
  end if;
  perform mcp_internal.require_mcp_ids(p_request_id, p_execution_id);
  if p_media_type is null or p_media_type not in ('image', 'video', 'text') then
    raise exception using message = 'invalid_request', errcode = 'P0001';
  end if;
  if p_media_type = 'text' and (p_body is null or length(trim(p_body)) < 1) then
    raise exception using message = 'invalid_request', errcode = 'P0001';
  end if;
  if p_media_type in ('image', 'video') and (p_storage_path is null or length(trim(p_storage_path)) < 1) then
    raise exception using message = 'invalid_request', errcode = 'P0001';
  end if;
  if p_body is null and p_storage_path is null then
    raise exception using message = 'invalid_request', errcode = 'P0001';
  end if;
  if p_proof_type is not null and not (p_proof_type = any (v_types)) then
    raise exception using message = 'invalid_request', errcode = 'P0001';
  end if;
  if p_strength is not null and p_strength not in ('high', 'medium', 'low') then
    raise exception using message = 'invalid_request', errcode = 'P0001';
  end if;

  v_payload := jsonb_strip_nulls(jsonb_build_object(
    'media_type', p_media_type, 'title', p_title, 'body', p_body, 'source', p_source,
    'storage_path', p_storage_path, 'claim', p_claim, 'evidence', p_evidence,
    'avatar_relevance', p_avatar_relevance, 'proof_type', p_proof_type,
    'strength', coalesce(p_strength, 'medium')
  ));
  v_existing := mcp_internal.take_proof_request(
    p_bot_id, p_execution_id, 'proof.create', p_client_id, v_payload);
  if v_existing is not null then
    return v_existing;
  end if;

  insert into client_proof_assets (
    client_id, media_type, title, body, source, storage_path,
    claim, evidence, avatar_relevance, proof_type, strength, usage_rights
  ) values (
    p_client_id, p_media_type::media_type, p_title, p_body, p_source, p_storage_path,
    p_claim, p_evidence, p_avatar_relevance, p_proof_type,
    coalesce(p_strength, 'medium'), 'not_cleared'
  ) returning * into v_proof;

  v_result := jsonb_build_object('client_id', p_client_id, 'replayed', false)
    || mcp_internal.proof_json(v_proof);
  insert into mcp_internal.mcp_proof_requests (
    bot_id, execution_id, request_id, tool, client_id, proof_id, payload, result
  ) values (
    p_bot_id, p_execution_id, p_request_id, 'proof.create', p_client_id, v_proof.id, v_payload, v_result
  );
  return v_result;
end;
$$;
revoke all on function mcp_internal.proof_create(text, text, text, uuid, text, text, text, text, text, text, text, text, text, text)
  from public, anon, authenticated;
grant execute on function mcp_internal.proof_create(text, text, text, uuid, text, text, text, text, text, text, text, text, text, text)
  to service_role;

create or replace function public.mcp_proof_create(
  p_bot_id text, p_request_id text, p_execution_id text, p_client_id uuid,
  p_media_type text, p_title text default null, p_body text default null,
  p_source text default null, p_storage_path text default null,
  p_claim text default null, p_evidence text default null,
  p_avatar_relevance text default null, p_proof_type text default null,
  p_strength text default 'medium'
)
returns jsonb language plpgsql security definer set search_path = mcp_internal, public as $$
begin
  perform mcp_internal.require_service_role();
  return mcp_internal.proof_create(
    p_bot_id, p_request_id, p_execution_id, p_client_id, p_media_type, p_title, p_body,
    p_source, p_storage_path, p_claim, p_evidence, p_avatar_relevance, p_proof_type, p_strength);
end;
$$;
revoke all on function public.mcp_proof_create(text, text, text, uuid, text, text, text, text, text, text, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.mcp_proof_create(text, text, text, uuid, text, text, text, text, text, text, text, text, text, text)
  to service_role;

create or replace function mcp_internal.proof_attach_asset(
  p_bot_id text, p_request_id text, p_execution_id text, p_client_id uuid,
  p_proof_id uuid, p_storage_path text, p_brief_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = mcp_internal, public
as $$
declare
  v_proof client_proof_assets;
  v_brief client_briefs;
  v_payload jsonb;
  v_existing jsonb;
  v_result jsonb;
begin
  perform mcp_internal.require_active_bot(p_bot_id);
  perform mcp_internal.require_bot_client_grant(p_bot_id, p_client_id);
  if p_bot_id <> 'bot_production' then
    raise exception using message = 'bot_forbidden', errcode = 'P0001';
  end if;
  perform mcp_internal.require_mcp_ids(p_request_id, p_execution_id);
  if p_proof_id is null or p_storage_path is null or length(trim(p_storage_path)) < 1
     or length(p_storage_path) > 500 then
    raise exception using message = 'invalid_request', errcode = 'P0001';
  end if;

  v_payload := jsonb_strip_nulls(jsonb_build_object(
    'proof_id', p_proof_id, 'storage_path', p_storage_path, 'brief_id', p_brief_id
  ));
  v_existing := mcp_internal.take_proof_request(
    p_bot_id, p_execution_id, 'proof.attach_asset', p_client_id, v_payload);
  if v_existing is not null then
    return v_existing;
  end if;

  select * into v_proof from client_proof_assets where id = p_proof_id for update;
  if not found then
    raise exception using message = 'proof_not_found', errcode = 'P0001';
  end if;
  if v_proof.client_id <> p_client_id then
    raise exception using message = 'client_mismatch', errcode = 'P0001';
  end if;

  -- Never touch usage_rights. Finding/attaching a file is not clearance.
  update client_proof_assets
     set storage_path = p_storage_path, updated_at = now()
   where id = p_proof_id
   returning * into v_proof;

  if p_brief_id is not null then
    select * into v_brief from client_briefs where id = p_brief_id for update;
    if not found then
      raise exception using message = 'brief_not_found', errcode = 'P0001';
    end if;
    if v_brief.client_id <> p_client_id then
      raise exception using message = 'client_mismatch', errcode = 'P0001';
    end if;
    if exists (
      select 1 from information_schema.columns
       where table_schema = 'public' and table_name = 'client_briefs' and column_name = 'proof_asset_id'
    ) then
      update client_briefs set proof_asset_id = p_proof_id where id = p_brief_id;
    end if;
  end if;

  v_result := jsonb_build_object('client_id', p_client_id, 'replayed', false)
    || mcp_internal.proof_json(v_proof);
  insert into mcp_internal.mcp_proof_requests (
    bot_id, execution_id, request_id, tool, client_id, proof_id, payload, result
  ) values (
    p_bot_id, p_execution_id, p_request_id, 'proof.attach_asset', p_client_id, p_proof_id, v_payload, v_result
  );
  return v_result;
end;
$$;
revoke all on function mcp_internal.proof_attach_asset(text, text, text, uuid, uuid, text, uuid)
  from public, anon, authenticated;
grant execute on function mcp_internal.proof_attach_asset(text, text, text, uuid, uuid, text, uuid)
  to service_role;

create or replace function public.mcp_proof_attach_asset(
  p_bot_id text, p_request_id text, p_execution_id text, p_client_id uuid,
  p_proof_id uuid, p_storage_path text, p_brief_id uuid default null
)
returns jsonb language plpgsql security definer set search_path = mcp_internal, public as $$
begin
  perform mcp_internal.require_service_role();
  return mcp_internal.proof_attach_asset(
    p_bot_id, p_request_id, p_execution_id, p_client_id, p_proof_id, p_storage_path, p_brief_id);
end;
$$;
revoke all on function public.mcp_proof_attach_asset(text, text, text, uuid, uuid, text, uuid)
  from public, anon, authenticated;
grant execute on function public.mcp_proof_attach_asset(text, text, text, uuid, uuid, text, uuid)
  to service_role;

-- ---------------------------------------------------------------------------
-- content.assign_production — Approve & Build sibling (AI or human dispatch)
-- ---------------------------------------------------------------------------

create or replace function mcp_internal.assign_production(
  p_bot_id text, p_request_id text, p_execution_id text, p_client_id uuid,
  p_brief_id uuid, p_route text, p_member_ids uuid[] default null,
  p_due_date date default null, p_compensation numeric default null,
  p_quality text default 'medium', p_size text default '1024x1536'
)
returns jsonb
language plpgsql
security definer
set search_path = mcp_internal, public
as $$
declare
  v_brief client_briefs;
  v_payload jsonb;
  v_existing jsonb;
  v_gen uuid;
  v_job uuid;
  v_member record;
  v_assign_id uuid;
  v_disp_id uuid;
  v_count integer := 0;
  v_result jsonb;
  v_assignments jsonb := '[]'::jsonb;
begin
  perform mcp_internal.require_active_bot(p_bot_id);
  perform mcp_internal.require_bot_client_grant(p_bot_id, p_client_id);
  if p_bot_id <> 'bot_production' then
    raise exception using message = 'bot_forbidden', errcode = 'P0001';
  end if;
  perform mcp_internal.require_mcp_ids(p_request_id, p_execution_id);
  if p_brief_id is null or p_route is null or p_route not in ('ai', 'human') then
    raise exception using message = 'invalid_production_route', errcode = 'P0001';
  end if;
  if p_route = 'human' and (p_member_ids is null or array_length(p_member_ids, 1) is null) then
    raise exception using message = 'invalid_request', errcode = 'P0001';
  end if;
  if p_quality is not null and p_quality not in ('low', 'medium', 'high') then
    raise exception using message = 'invalid_request', errcode = 'P0001';
  end if;
  if p_size is not null and p_size not in ('1024x1536', '1024x1024', '1536x1024') then
    raise exception using message = 'invalid_request', errcode = 'P0001';
  end if;

  v_payload := jsonb_strip_nulls(jsonb_build_object(
    'brief_id', p_brief_id, 'route', p_route,
    'member_ids', to_jsonb(p_member_ids),
    'due_date', p_due_date, 'compensation', p_compensation,
    'quality', coalesce(p_quality, 'medium'), 'size', coalesce(p_size, '1024x1536')
  ));
  v_existing := mcp_internal.take_content_request(
    p_bot_id, p_execution_id, 'content.assign_production', p_client_id, v_payload);
  if v_existing is not null then
    return v_existing;
  end if;

  select * into v_brief from client_briefs where id = p_brief_id for update;
  if not found then
    raise exception using message = 'brief_not_found', errcode = 'P0001';
  end if;
  if v_brief.client_id <> p_client_id then
    raise exception using message = 'client_mismatch', errcode = 'P0001';
  end if;
  if v_brief.status not in ('draft', 'approved') then
    raise exception using message = 'invalid_brief_status', errcode = 'P0001';
  end if;

  if p_route = 'ai' then
    if v_brief.media_type = 'video' then
      raise exception using message = 'invalid_production_route', errcode = 'P0001';
    end if;
    insert into creative_generations (client_id, brief_id, media_type, quality, size)
    values (
      p_client_id, p_brief_id, v_brief.media_type,
      coalesce(p_quality, 'medium'), coalesce(p_size, '1024x1536')
    ) returning id into v_gen;
    begin
      v_job := public.enqueue_agent_job_internal(
        'creative_build', p_client_id, 'creative_generations', v_gen,
        null, jsonb_build_object('generation_id', v_gen), 'Queued by MCP content.assign_production');
    exception
      when raise_exception then
        raise exception using message = 'queue_failure', errcode = 'P0001';
      when others then
        raise exception using message = 'queue_failure', errcode = 'P0001';
    end;
    update creative_generations set job_id = v_job where id = v_gen;
    update client_briefs set status = 'in_production' where id = p_brief_id;
    v_result := jsonb_build_object(
      'client_id', p_client_id, 'brief_id', p_brief_id, 'route', 'ai',
      'generation_id', v_gen, 'job_id', v_job, 'replayed', false
    );
  else
    for v_member in
      select id, name, category from team_members
       where id = any (p_member_ids) and active = true
    loop
      if v_member.category not in ('editors', 'avatars') then
        raise exception using message = 'member_not_found', errcode = 'P0001';
      end if;
      insert into job_assignments (member_id, client_id, brief_id, title, due_date, compensation)
      values (v_member.id, p_client_id, p_brief_id, v_brief.title, p_due_date, p_compensation)
      returning id into v_assign_id;
      insert into brief_dispatches (client_id, brief_id, member_id, assignment_id, sent_by)
      values (p_client_id, p_brief_id, v_member.id, v_assign_id, null)
      on conflict (brief_id, member_id) do update
        set assignment_id = excluded.assignment_id,
            email_status = 'pending',
            email_error = null,
            emailed_at = null
      returning id into v_disp_id;
      begin
        v_job := public.enqueue_agent_job_internal(
          'brief_dispatch', p_client_id, 'brief_dispatches', v_disp_id,
          null, jsonb_build_object('dispatch_id', v_disp_id), 'Queued by MCP content.assign_production');
      exception
        when raise_exception then
          raise exception using message = 'queue_failure', errcode = 'P0001';
        when others then
          raise exception using message = 'queue_failure', errcode = 'P0001';
      end;
      update brief_dispatches set job_id = v_job where id = v_disp_id;
      v_assignments := v_assignments || jsonb_build_array(jsonb_build_object(
        'assignment_id', v_assign_id, 'member_id', v_member.id, 'dispatch_id', v_disp_id, 'job_id', v_job
      ));
      v_count := v_count + 1;
    end loop;
    if v_count = 0 then
      raise exception using message = 'member_not_found', errcode = 'P0001';
    end if;
    update client_briefs set status = 'in_production' where id = p_brief_id;
    v_result := jsonb_build_object(
      'client_id', p_client_id, 'brief_id', p_brief_id, 'route', 'human',
      'assigned', v_count, 'assignments', v_assignments, 'replayed', false
    );
  end if;

  insert into mcp_internal.mcp_content_requests (
    bot_id, execution_id, request_id, tool, client_id, brief_id, payload, result
  ) values (
    p_bot_id, p_execution_id, p_request_id, 'content.assign_production',
    p_client_id, p_brief_id, v_payload, v_result
  );
  return v_result;
end;
$$;
revoke all on function mcp_internal.assign_production(text, text, text, uuid, uuid, text, uuid[], date, numeric, text, text)
  from public, anon, authenticated;
grant execute on function mcp_internal.assign_production(text, text, text, uuid, uuid, text, uuid[], date, numeric, text, text)
  to service_role;

create or replace function public.mcp_assign_production(
  p_bot_id text, p_request_id text, p_execution_id text, p_client_id uuid,
  p_brief_id uuid, p_route text, p_member_ids uuid[] default null,
  p_due_date date default null, p_compensation numeric default null,
  p_quality text default 'medium', p_size text default '1024x1536'
)
returns jsonb language plpgsql security definer set search_path = mcp_internal, public as $$
begin
  perform mcp_internal.require_service_role();
  return mcp_internal.assign_production(
    p_bot_id, p_request_id, p_execution_id, p_client_id, p_brief_id, p_route,
    p_member_ids, p_due_date, p_compensation, p_quality, p_size);
end;
$$;
revoke all on function public.mcp_assign_production(text, text, text, uuid, uuid, text, uuid[], date, numeric, text, text)
  from public, anon, authenticated;
grant execute on function public.mcp_assign_production(text, text, text, uuid, uuid, text, uuid[], date, numeric, text, text)
  to service_role;

-- ---------------------------------------------------------------------------
-- content.submit_asset — file a pending media row against a brief/assignment
-- ---------------------------------------------------------------------------

create or replace function mcp_internal.submit_asset(
  p_bot_id text, p_request_id text, p_execution_id text, p_client_id uuid,
  p_storage_path text, p_media_type text, p_brief_id uuid default null,
  p_assignment_id uuid default null, p_title text default null
)
returns jsonb
language plpgsql
security definer
set search_path = mcp_internal, public
as $$
declare
  v_brief client_briefs;
  v_job job_assignments;
  v_payload jsonb;
  v_existing jsonb;
  v_asset client_media_assets;
  v_result jsonb;
begin
  perform mcp_internal.require_active_bot(p_bot_id);
  perform mcp_internal.require_bot_client_grant(p_bot_id, p_client_id);
  if p_bot_id <> 'bot_production' then
    raise exception using message = 'bot_forbidden', errcode = 'P0001';
  end if;
  perform mcp_internal.require_mcp_ids(p_request_id, p_execution_id);
  if p_storage_path is null or length(trim(p_storage_path)) < 1 or length(p_storage_path) > 500 then
    raise exception using message = 'invalid_request', errcode = 'P0001';
  end if;
  if p_media_type is null or p_media_type not in ('image', 'video', 'text') then
    raise exception using message = 'invalid_request', errcode = 'P0001';
  end if;
  if p_brief_id is null and p_assignment_id is null then
    raise exception using message = 'invalid_request', errcode = 'P0001';
  end if;

  v_payload := jsonb_strip_nulls(jsonb_build_object(
    'storage_path', p_storage_path, 'media_type', p_media_type,
    'brief_id', p_brief_id, 'assignment_id', p_assignment_id, 'title', p_title
  ));
  v_existing := mcp_internal.take_content_request(
    p_bot_id, p_execution_id, 'content.submit_asset', p_client_id, v_payload);
  if v_existing is not null then
    return v_existing;
  end if;

  if p_assignment_id is not null then
    select * into v_job from job_assignments where id = p_assignment_id for update;
    if not found then
      raise exception using message = 'job_not_found', errcode = 'P0001';
    end if;
    if v_job.client_id is distinct from p_client_id then
      raise exception using message = 'client_mismatch', errcode = 'P0001';
    end if;
    if p_brief_id is null then
      p_brief_id := v_job.brief_id;
    elsif v_job.brief_id is not null and v_job.brief_id is distinct from p_brief_id then
      raise exception using message = 'client_mismatch', errcode = 'P0001';
    end if;
  end if;

  if p_brief_id is not null then
    select * into v_brief from client_briefs where id = p_brief_id for share;
    if not found then
      raise exception using message = 'brief_not_found', errcode = 'P0001';
    end if;
    if v_brief.client_id <> p_client_id then
      raise exception using message = 'client_mismatch', errcode = 'P0001';
    end if;
  end if;

  insert into client_media_assets (
    client_id, brief_id, media_type, storage_path, title, review_status
  ) values (
    p_client_id, p_brief_id, p_media_type::media_type, p_storage_path,
    coalesce(p_title, v_brief.title, v_job.title, 'Submitted asset'),
    'pending'
  ) returning * into v_asset;

  if v_job.id is not null and v_job.completed_at is null then
    update job_assignments set completed_at = now() where id = v_job.id;
  end if;

  v_result := jsonb_build_object(
    'client_id', p_client_id,
    'asset_id', v_asset.id,
    'brief_id', v_asset.brief_id,
    'assignment_id', v_job.id,
    'review_status', v_asset.review_status,
    'replayed', false
  );
  insert into mcp_internal.mcp_content_requests (
    bot_id, execution_id, request_id, tool, client_id, brief_id, asset_id, payload, result
  ) values (
    p_bot_id, p_execution_id, p_request_id, 'content.submit_asset',
    p_client_id, p_brief_id, v_asset.id, v_payload, v_result
  );
  return v_result;
end;
$$;
revoke all on function mcp_internal.submit_asset(text, text, text, uuid, text, text, uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function mcp_internal.submit_asset(text, text, text, uuid, text, text, uuid, uuid, text)
  to service_role;

create or replace function public.mcp_submit_asset(
  p_bot_id text, p_request_id text, p_execution_id text, p_client_id uuid,
  p_storage_path text, p_media_type text, p_brief_id uuid default null,
  p_assignment_id uuid default null, p_title text default null
)
returns jsonb language plpgsql security definer set search_path = mcp_internal, public as $$
begin
  perform mcp_internal.require_service_role();
  return mcp_internal.submit_asset(
    p_bot_id, p_request_id, p_execution_id, p_client_id, p_storage_path, p_media_type,
    p_brief_id, p_assignment_id, p_title);
end;
$$;
revoke all on function public.mcp_submit_asset(text, text, text, uuid, text, text, uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.mcp_submit_asset(text, text, text, uuid, text, text, uuid, uuid, text)
  to service_role;

-- ---------------------------------------------------------------------------
-- Permissions + prohibitions
-- ---------------------------------------------------------------------------

-- Seed (mig 65) granted bot_marketing `proof.*` while those tools were stubs.
-- Realizing them here would otherwise let Marketing discover/call create/attach.
-- Sales Ops already dropped proof.search/get in Phase 11; this sweep is the
-- same exact-allowlist cleanup for every non-production leftover.
delete from mcp_internal.mcp_bot_permissions
 where bot_id <> 'bot_production'
   and (
     permission_pattern like 'proof.%'
     or permission_pattern = 'proof.*'
   );

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
  if exists (
    select 1 from mcp_internal.mcp_bot_permissions p
    where p.bot_id <> 'bot_production'
      and p.permission_pattern like 'proof.%'
  ) then
    raise exception 'Phase 16b: proof.* must not be granted outside bot_production';
  end if;
end
$$;
revoke all on function mcp_internal.assert_cos_prohibitions() from public, anon, authenticated;
grant execute on function mcp_internal.assert_cos_prohibitions() to service_role;

insert into mcp_internal.mcp_bot_permissions (bot_id, permission_pattern, granted_by)
values
  ('bot_sales_ops', 'sales_agents.attach_to_page', 'phase-16b:sales-ops-attach-enable-build'),
  ('bot_sales_ops', 'sales_agents.set_deployment_enabled', 'phase-16b:sales-ops-attach-enable-build'),
  ('bot_sales_ops', 'sales_agents.build', 'phase-16b:sales-ops-attach-enable-build')
on conflict (bot_id, permission_pattern) do nothing;

insert into mcp_internal.mcp_bot_permissions (bot_id, permission_pattern, granted_by)
values
  ('bot_production', 'proof.create', 'phase-16b:proof-writes'),
  ('bot_production', 'proof.attach_asset', 'phase-16b:proof-writes')
on conflict (bot_id, permission_pattern) do nothing;

do $$
declare n integer;
begin
  -- Count 25 is for THIS migration only (Phase 11b's 22 + attach/enable/build).
  -- Phase 16c (PR #46, mig 91) additively grants brand.get_profile,
  -- sites.provision, sites.publish_page → 28. Do not DELETE these three rows.
  select count(*) into n from mcp_internal.mcp_bot_permissions where bot_id = 'bot_sales_ops';
  if n is distinct from 25 then
    raise exception 'Phase 16b: bot_sales_ops must have exactly 25 permission rows after this migration (22+attach/enable/build), found %', n;
  end if;
  if exists (
    select 1 from mcp_internal.mcp_bot_permissions
     where bot_id = 'bot_sales_ops'
       and permission_pattern in ('sales_agents.deploy', 'pipeline.record_sale')
  ) then
    raise exception 'Phase 16b: sales_agents.deploy / pipeline.record_sale must stay ungranted';
  end if;
  if not exists (
    select 1 from mcp_internal.mcp_bot_permissions
     where bot_id = 'bot_production' and permission_pattern = 'proof.create'
  ) then
    raise exception 'Phase 16b: bot_production must hold proof.create';
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
    ('public', 'client_sales_agent_deployments'),
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
    ('mcp_internal', 'mcp_proof_requests'),
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

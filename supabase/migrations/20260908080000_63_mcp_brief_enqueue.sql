-- AA-owned, deny-by-default scope for the gateway. Provision/revoke using
-- trusted database administration; never grant the gateway direct table access.
create table mcp_bot_clients (
  bot_id text not null check (bot_id ~ '^bot_[a-z0-9_]{1,60}$'),
  client_id uuid not null references clients(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (bot_id, client_id)
);
alter table mcp_bot_clients enable row level security;
revoke all on mcp_bot_clients from public, anon, authenticated;
grant select, insert, delete on mcp_bot_clients to service_role;

-- Kept for the lifetime of the request; deleting a job/client/idea must not
-- silently free an execution key for reuse. No automatic expiry.
create table mcp_brief_requests (
  bot_id text not null,
  execution_id text not null check (execution_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  request_id text not null check (request_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  client_id uuid not null references clients(id),
  idea_id uuid not null references client_ideas(id),
  job_id uuid not null references agent_jobs(id),
  created_at timestamptz not null default now(),
  primary key (bot_id, execution_id),
  unique (job_id)
);
alter table mcp_brief_requests enable row level security;
revoke all on mcp_brief_requests from public, anon, authenticated;
grant select on mcp_brief_requests to service_role;

-- Authorization stays at each entry point. Only SECURITY DEFINER wrappers
-- can call this shared implementation, including the unchanged human RPC.
create function enqueue_agent_job_internal(
  p_agent_key text, p_client_id uuid, p_input_table text, p_input_id uuid,
  p_actor uuid, p_params jsonb default '{}'::jsonb, p_description text default 'Queued'
)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_agent agents;
  v_job uuid;
begin
  select * into v_agent from agents where agent_key = p_agent_key for share;
  if not found then raise exception 'Unknown agent: %', p_agent_key; end if;
  if v_agent.paused then raise exception 'Agent % is paused', p_agent_key; end if;
  if v_agent.archived_at is not null then raise exception 'Agent % is archived', p_agent_key; end if;
  if p_client_id is not null and not can_run_agent(p_agent_key, p_client_id) then
    raise exception 'Agent % is missing required upstream intelligence', p_agent_key;
  end if;
  insert into agent_jobs (agent_key, client_id, input_table, input_id, created_by, params)
  values (p_agent_key, p_client_id, p_input_table, p_input_id, p_actor, p_params)
  returning id into v_job;
  insert into agent_job_events (job_id, description, payload)
  values (v_job, p_description, p_params);
  return v_job;
end;
$$;
revoke all on function enqueue_agent_job_internal(text, uuid, text, uuid, uuid, jsonb, text)
  from public, anon, authenticated, service_role;

create or replace function enqueue_agent_job(
  p_agent_key text, p_client_id uuid default null,
  p_input_table text default null, p_input_id uuid default null
)
returns uuid language plpgsql security definer set search_path = public as $$
begin
  if p_client_id is not null and not can_access_client(p_client_id) then
    raise exception 'Not permitted for this client';
  end if;
  return enqueue_agent_job_internal(p_agent_key, p_client_id, p_input_table, p_input_id, auth.uid());
end;
$$;

create function enqueue_mcp_brief(
  p_bot_id text, p_request_id text, p_execution_id text,
  p_client_id uuid, p_idea_id uuid
)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_idea client_ideas;
  v_request mcp_brief_requests;
  v_job uuid;
  v_meta jsonb;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using message = 'unauthorized', errcode = 'P0001';
  end if;
  if p_bot_id is null or p_bot_id !~ '^bot_[a-z0-9_]{1,60}$' then
    raise exception 'invalid_bot';
  end if;
  if p_client_id is null or p_idea_id is null
     or p_request_id is null or p_request_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
     or p_execution_id is null or p_execution_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' then
    raise exception 'invalid_request';
  end if;
  -- Check current scope even on replay. Hold the grant so revocation and
  -- enqueue have a defined transaction order. No rows are seeded by default.
  perform 1 from mcp_bot_clients
    where bot_id = p_bot_id and client_id = p_client_id for share;
  if not found then raise exception 'client_forbidden'; end if;

  -- Serializes the same bot/execution across processes, including different
  -- payloads. Hash collisions only serialize unrelated requests, never alias them.
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
  -- Same queued marker as the human path, with no approval performed here.
  update client_ideas set status = 'briefed' where id = p_idea_id;
  return jsonb_build_object('job_id', v_job, 'client_id', p_client_id, 'replayed', false);
end;
$$;
revoke all on function enqueue_mcp_brief(text, text, text, uuid, uuid) from public, anon, authenticated;
grant execute on function enqueue_mcp_brief(text, text, text, uuid, uuid) to service_role;

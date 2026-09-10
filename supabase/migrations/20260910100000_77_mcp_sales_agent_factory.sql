-- Phase 11b: Sales Agent Factory. Bot-safe factory writes for bot_sales_ops,
-- additive to Phase 11's exact allowlist (mig 76). DO NOT APPLY TO PRODUCTION
-- without Alex approval. Sec design note required before merge/cutover:
-- aa-mcp-gateway/docs/phase-11b-sales-agent-factory.md. Additive only.
--
-- Sec Phase 11b bar (SEC_BAR.md, locked 2026-09-10, all 9 points addressed
-- here and in the design note):
--   1. Additive only on bot_sales_ops -- Phase 11 pipeline surface unchanged;
--      allowlist grows by exactly 5 factory names (17 -> 22). Same ceiling
--      mechanism as Phase 11 (permissions.ts allowed()), no new gateway gate
--      needed (see design note Sec question 2). Every new RPC below also
--      hard-codes bot_sales_ops, belt-and-suspenders like Phase 9b/10/11.
--   2. Per-client agent configs only -- every RPC opens with
--      require_active_bot + require_bot_client_grant, never can_access_client;
--      writes on an existing agent additionally lock and check
--      client_id match before touching a row.
--   3. Realize: generate_config, create, update_knowledge,
--      update_qualification_rules, test (sandbox -- no live channel send;
--      this RPC layer has no HTTP client, so "no live send" is structural,
--      not policy).
--   4. sales_agents.deploy stays untouched: no permission row, not added to
--      realSalesAgents in src/registry/tools.ts, stays CRITICAL+approval.
--   5. Harbour-only grant is a separate, later, Alex-approved step (this
--      migration does not touch mcp_bot_clients).
--   6. No bank/finance/security/deploy paths touched; pipeline.record_sale
--      and workflow.record_decision remain untouched/hard-denied.
--   7. Isolation tests (agent-runtime/src/mcp/isolation-rls.test.ts, new
--      "Phase 11b Sales Agent Factory isolation" block) green before any of
--      these 5 leave "stub" in src/registry/tools.ts.
--   8. assert_cos_prohibitions() extended: bot_sales_ops's forbidden-name list
--      drops the 4 now-legitimately-granted names (create/update_knowledge/
--      update_qualification_rules/test) but keeps deploy/record_sale/proof.*;
--      the existing pattern-based "no other Bot holds pipeline.%/sales_agents.%"
--      check already covers these 5 new names for free.
--   9. generate_config/create/update_knowledge/update_qualification_rules/
--      test were never on the gateway's HIGH-risk `approval` array -- they
--      land at MEDIUM risk, AA-RPC-only authorization, same posture Phase
--      9b/10/11 settled on. See design note Sec question 1.

-- ---------------------------------------------------------------------------
-- client_sales_agents gains a role column (additive, nullable: existing rows
-- built by the human Sales Agent Builder before this phase have no role and
-- are left alone).
-- ---------------------------------------------------------------------------

alter table client_sales_agents
  add column role text
  check (role in ('inbound_qualifier','appointment_setter','nurture','reactivation','closer_assist'));
comment on column client_sales_agents.role is
  'Phase 11b: which execution surface this agent is (inbound_qualifier | appointment_setter | nurture | reactivation | closer_assist). Null for agents built before this phase via the human Sales Agent Builder.';

-- sales_agent_json (migration 67) gains the role field. Additive: existing
-- callers get one more key, nothing removed.
create or replace function mcp_internal.sales_agent_json(p client_sales_agents)
returns jsonb
language plpgsql
stable
set search_path = mcp_internal, public
as $$
declare r jsonb := to_jsonb(p);
begin
  return jsonb_build_object(
    'id', r->>'id',
    'client_id', r->>'client_id',
    'page_id', r->>'page_id',
    'name', r->>'name',
    'role', r->>'role',
    'purpose', mcp_internal.clip_text(r->>'purpose'),
    'status', r->>'status',
    'greeting', mcp_internal.clip_text(r->>'greeting'),
    'qualification', r->'qualification',
    'objections', r->'objections',
    'booking_rule', mcp_internal.clip_text(r->>'booking_rule'),
    'escalation_rule', mcp_internal.clip_text(r->>'escalation_rule'),
    'guardrails', mcp_internal.clip_text(r->>'guardrails'),
    'built_at', r->>'built_at',
    'created_at', r->>'created_at',
    'updated_at', r->>'updated_at'
  );
end;
$$;
revoke all on function mcp_internal.sales_agent_json(client_sales_agents)
  from public, anon, authenticated;
grant execute on function mcp_internal.sales_agent_json(client_sales_agents) to service_role;

-- ---------------------------------------------------------------------------
-- Ledger for Bot factory writes. Separate table from mcp_pipeline_requests:
-- different domain, different resource (sales_agent, not lead) -- same shape,
-- RLS posture and replay helper. sales_agent_id is nullable: generate_config
-- has no agent yet (it returns a draft), and even for the other four tools
-- the replay-conflict check below never compares it, only tool/client/payload
-- -- an audit column, not a control.
-- ---------------------------------------------------------------------------

create table mcp_internal.mcp_sales_agent_requests (
  bot_id text not null,
  execution_id text not null
    check (execution_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  request_id text not null
    check (request_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  tool text not null check (tool in (
    'sales_agents.generate_config',
    'sales_agents.create',
    'sales_agents.update_knowledge',
    'sales_agents.update_qualification_rules',
    'sales_agents.test'
  )),
  client_id uuid not null references public.clients(id),
  sales_agent_id uuid references public.client_sales_agents(id),
  payload jsonb not null default '{}'::jsonb,
  result jsonb not null,
  created_at timestamptz not null default now(),
  primary key (bot_id, execution_id)
);
create index mcp_sales_agent_requests_client_idx
  on mcp_internal.mcp_sales_agent_requests (client_id, created_at desc);
alter table mcp_internal.mcp_sales_agent_requests enable row level security;
alter table mcp_internal.mcp_sales_agent_requests force row level security;
revoke all on mcp_internal.mcp_sales_agent_requests
  from public, anon, authenticated, service_role;

create or replace function mcp_internal.take_sales_agent_request(
  p_bot_id text, p_execution_id text, p_tool text, p_client_id uuid, p_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = mcp_internal, public
as $$
declare
  v_row mcp_internal.mcp_sales_agent_requests;
begin
  perform mcp_internal.require_service_role();
  perform pg_advisory_xact_lock(hashtextextended(p_bot_id || ':' || p_execution_id, 2));
  select * into v_row
    from mcp_internal.mcp_sales_agent_requests
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
revoke all on function mcp_internal.take_sales_agent_request(text, text, text, uuid, jsonb)
  from public, anon, authenticated;
grant execute on function mcp_internal.take_sales_agent_request(text, text, text, uuid, jsonb)
  to service_role;

-- ---------------------------------------------------------------------------
-- 1. generate_config -- server-side compose only, no table write besides the
-- ledger. Intel sources are what exists in this schema today: the one-row-
-- per-client client_business_context (main_offer/ideal_customer/sales_process/
-- brand_voice/proof_testimonials/competitors -- offer, avatar, sales process,
-- brand and market signal in the brief's terms) plus client_brand_profiles's
-- never_do (a guardrails seed). Campaign-level intel is NOT joined here: there
-- is no campaign-scoped table shaped for sales-agent generation yet (campaigns
-- carries spend/targeting, not messaging intel) -- documented as an honest
-- gap in the design note, not invented. This is a read in effect, but is
-- classified MEDIUM/write in the registry (like content.generate_brief before
-- it) because it composes cross-table client intelligence and Sec wants it
-- audited, not because it mutates business state.
-- ---------------------------------------------------------------------------

create or replace function mcp_internal.generate_sales_agent_config(
  p_bot_id text, p_request_id text, p_execution_id text, p_client_id uuid, p_role text
)
returns jsonb
language plpgsql
security definer
set search_path = mcp_internal, public
as $$
declare
  v_ctx client_business_context;
  v_never_do text;
  v_payload jsonb;
  v_existing jsonb;
  v_result jsonb;
begin
  perform mcp_internal.require_active_bot(p_bot_id);
  perform mcp_internal.require_bot_client_grant(p_bot_id, p_client_id);
  if p_bot_id <> 'bot_sales_ops' then
    raise exception using message = 'bot_forbidden', errcode = 'P0001';
  end if;
  perform mcp_internal.require_mcp_ids(p_request_id, p_execution_id);
  if p_role is null or p_role not in
    ('inbound_qualifier','appointment_setter','nurture','reactivation','closer_assist') then
    raise exception using message = 'invalid_role', errcode = 'P0001';
  end if;

  v_payload := jsonb_build_object('role', p_role);
  v_existing := mcp_internal.take_sales_agent_request(
    p_bot_id, p_execution_id, 'sales_agents.generate_config', p_client_id, v_payload);
  if v_existing is not null then
    return v_existing;
  end if;

  select * into v_ctx from client_business_context where client_id = p_client_id;
  select never_do into v_never_do from client_brand_profiles where client_id = p_client_id;

  v_result := jsonb_build_object(
    'client_id', p_client_id,
    'role', p_role,
    'draft', jsonb_build_object(
      'greeting', case when v_ctx.main_offer is not null
        then 'Hi! I can help with ' || mcp_internal.clip_text(v_ctx.main_offer, 200) || '. What brought you here today?'
        else 'Hi! What brought you here today?' end,
      'qualification', jsonb_build_array(
        jsonb_build_object(
          'question', 'What are you hoping to get help with?',
          'why', 'Surfaces the need before anything else.',
          'good_answer', mcp_internal.clip_text(v_ctx.ideal_customer, 300),
          'disqualifier', null),
        jsonb_build_object(
          'question', 'What is your timeline?',
          'why', 'Timing rules out a visitor who is not ready to move.',
          'good_answer', null,
          'disqualifier', 'No plan to move in the next 90 days.'),
        jsonb_build_object(
          'question', 'Who else is involved in this decision?',
          'why', 'Finds out whether the visitor can say yes alone.',
          'good_answer', null,
          'disqualifier', null)
      ),
      'objections', jsonb_build_array(
        jsonb_build_object(
          'objection', 'This costs too much.',
          'response', coalesce(mcp_internal.clip_text(v_ctx.proof_testimonials, 500),
            'No proof on file yet for this client -- do not invent a claim; escalate to a person.')),
        jsonb_build_object(
          'objection', 'I need to think about it.',
          'response', 'Ask what specifically needs more thought, then offer one concrete next step.')
      ),
      'booking_rule', 'Offer a booking link once the visitor is qualified and has agreed on next steps.',
      'escalation_rule', 'Hand over to a person once qualified, or immediately if the visitor asks for one.',
      'guardrails', coalesce(mcp_internal.clip_text(v_never_do, 2000),
        'Never promise a price, timeline or outcome that is not explicitly on file for this client.')
    ),
    'sources_used', jsonb_build_object(
      'business_context', v_ctx.client_id is not null,
      'brand_profile', v_never_do is not null
    ),
    'replayed', false
  );
  insert into mcp_internal.mcp_sales_agent_requests (
    bot_id, execution_id, request_id, tool, client_id, sales_agent_id, payload, result
  ) values (
    p_bot_id, p_execution_id, p_request_id, 'sales_agents.generate_config', p_client_id, null, v_payload, v_result
  );
  return v_result;
end;
$$;
revoke all on function mcp_internal.generate_sales_agent_config(text, text, text, uuid, text)
  from public, anon, authenticated;
grant execute on function mcp_internal.generate_sales_agent_config(text, text, text, uuid, text)
  to service_role;

create or replace function public.mcp_generate_sales_agent_config(
  p_bot_id text, p_request_id text, p_execution_id text, p_client_id uuid, p_role text
)
returns jsonb language plpgsql security definer set search_path = mcp_internal, public as $$
begin
  perform mcp_internal.require_service_role();
  return mcp_internal.generate_sales_agent_config(p_bot_id, p_request_id, p_execution_id, p_client_id, p_role);
end;
$$;
revoke all on function public.mcp_generate_sales_agent_config(text, text, text, uuid, text)
  from public, anon, authenticated;
grant execute on function public.mcp_generate_sales_agent_config(text, text, text, uuid, text)
  to service_role;

-- ---------------------------------------------------------------------------
-- 2. create -- persists a new per-client agent row. Draft status, same as the
-- human Sales Agent Builder path (migration 67); does not accept a full
-- config body -- knowledge/qualification are separate calls (Gate 11b happy
-- path), so a partial factory run never leaves a half-written config that
-- looks finished.
-- ---------------------------------------------------------------------------

create or replace function mcp_internal.create_sales_agent(
  p_bot_id text, p_request_id text, p_execution_id text, p_client_id uuid,
  p_role text, p_name text, p_purpose text
)
returns jsonb
language plpgsql
security definer
set search_path = mcp_internal, public
as $$
declare
  v_payload jsonb;
  v_existing jsonb;
  v_agent client_sales_agents;
  v_result jsonb;
begin
  perform mcp_internal.require_active_bot(p_bot_id);
  perform mcp_internal.require_bot_client_grant(p_bot_id, p_client_id);
  if p_bot_id <> 'bot_sales_ops' then
    raise exception using message = 'bot_forbidden', errcode = 'P0001';
  end if;
  perform mcp_internal.require_mcp_ids(p_request_id, p_execution_id);
  if p_role is null or p_role not in
    ('inbound_qualifier','appointment_setter','nurture','reactivation','closer_assist') then
    raise exception using message = 'invalid_role', errcode = 'P0001';
  end if;
  if p_name is null or length(trim(p_name)) < 1 or length(p_name) > 200
     or p_purpose is null or length(trim(p_purpose)) < 1 or length(p_purpose) > 4000 then
    raise exception using message = 'invalid_request', errcode = 'P0001';
  end if;

  v_payload := jsonb_build_object('role', p_role, 'name', p_name, 'purpose', p_purpose);
  v_existing := mcp_internal.take_sales_agent_request(
    p_bot_id, p_execution_id, 'sales_agents.create', p_client_id, v_payload);
  if v_existing is not null then
    return v_existing;
  end if;

  insert into client_sales_agents (client_id, role, name, purpose, status)
  values (p_client_id, p_role, p_name, p_purpose, 'draft')
  returning * into v_agent;

  v_result := jsonb_build_object('client_id', p_client_id, 'replayed', false)
    || mcp_internal.sales_agent_json(v_agent);
  insert into mcp_internal.mcp_sales_agent_requests (
    bot_id, execution_id, request_id, tool, client_id, sales_agent_id, payload, result
  ) values (
    p_bot_id, p_execution_id, p_request_id, 'sales_agents.create', p_client_id, v_agent.id, v_payload, v_result
  );
  return v_result;
end;
$$;
revoke all on function mcp_internal.create_sales_agent(text, text, text, uuid, text, text, text)
  from public, anon, authenticated;
grant execute on function mcp_internal.create_sales_agent(text, text, text, uuid, text, text, text)
  to service_role;

create or replace function public.mcp_create_sales_agent(
  p_bot_id text, p_request_id text, p_execution_id text, p_client_id uuid,
  p_role text, p_name text, p_purpose text
)
returns jsonb language plpgsql security definer set search_path = mcp_internal, public as $$
begin
  perform mcp_internal.require_service_role();
  return mcp_internal.create_sales_agent(p_bot_id, p_request_id, p_execution_id, p_client_id, p_role, p_name, p_purpose);
end;
$$;
revoke all on function public.mcp_create_sales_agent(text, text, text, uuid, text, text, text)
  from public, anon, authenticated;
grant execute on function public.mcp_create_sales_agent(text, text, text, uuid, text, text, text)
  to service_role;

-- ---------------------------------------------------------------------------
-- 3. update_knowledge -- the objection library / greeting / guardrails slice.
-- At least one field required; unset fields are left unchanged (coalesce).
-- ---------------------------------------------------------------------------

create or replace function mcp_internal.update_sales_agent_knowledge(
  p_bot_id text, p_request_id text, p_execution_id text, p_client_id uuid,
  p_sales_agent_id uuid, p_objections jsonb default null,
  p_guardrails text default null, p_greeting text default null
)
returns jsonb
language plpgsql
security definer
set search_path = mcp_internal, public
as $$
declare
  v_agent client_sales_agents;
  v_payload jsonb;
  v_existing jsonb;
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
  if p_objections is null and p_guardrails is null and p_greeting is null then
    raise exception using message = 'invalid_request', errcode = 'P0001';
  end if;
  if p_objections is not null and (
    jsonb_typeof(p_objections) <> 'array'
    or jsonb_array_length(p_objections) < 1
    or jsonb_array_length(p_objections) > 30
  ) then
    raise exception using message = 'invalid_request', errcode = 'P0001';
  end if;
  if p_guardrails is not null and length(p_guardrails) > 4000 then
    raise exception using message = 'invalid_request', errcode = 'P0001';
  end if;
  if p_greeting is not null and length(p_greeting) > 2000 then
    raise exception using message = 'invalid_request', errcode = 'P0001';
  end if;

  v_payload := jsonb_strip_nulls(jsonb_build_object(
    'sales_agent_id', p_sales_agent_id, 'objections', p_objections,
    'guardrails', p_guardrails, 'greeting', p_greeting));
  v_existing := mcp_internal.take_sales_agent_request(
    p_bot_id, p_execution_id, 'sales_agents.update_knowledge', p_client_id, v_payload);
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

  update client_sales_agents
     set objections = coalesce(p_objections, objections),
         guardrails = coalesce(p_guardrails, guardrails),
         greeting = coalesce(p_greeting, greeting),
         updated_at = now()
   where id = p_sales_agent_id
   returning * into v_agent;

  v_result := jsonb_build_object('client_id', p_client_id, 'replayed', false)
    || mcp_internal.sales_agent_json(v_agent);
  insert into mcp_internal.mcp_sales_agent_requests (
    bot_id, execution_id, request_id, tool, client_id, sales_agent_id, payload, result
  ) values (
    p_bot_id, p_execution_id, p_request_id, 'sales_agents.update_knowledge', p_client_id, p_sales_agent_id, v_payload, v_result
  );
  return v_result;
end;
$$;
revoke all on function mcp_internal.update_sales_agent_knowledge(text, text, text, uuid, uuid, jsonb, text, text)
  from public, anon, authenticated;
grant execute on function mcp_internal.update_sales_agent_knowledge(text, text, text, uuid, uuid, jsonb, text, text)
  to service_role;

create or replace function public.mcp_update_sales_agent_knowledge(
  p_bot_id text, p_request_id text, p_execution_id text, p_client_id uuid,
  p_sales_agent_id uuid, p_objections jsonb default null,
  p_guardrails text default null, p_greeting text default null
)
returns jsonb language plpgsql security definer set search_path = mcp_internal, public as $$
begin
  perform mcp_internal.require_service_role();
  return mcp_internal.update_sales_agent_knowledge(
    p_bot_id, p_request_id, p_execution_id, p_client_id, p_sales_agent_id, p_objections, p_guardrails, p_greeting);
end;
$$;
revoke all on function public.mcp_update_sales_agent_knowledge(text, text, text, uuid, uuid, jsonb, text, text)
  from public, anon, authenticated;
grant execute on function public.mcp_update_sales_agent_knowledge(text, text, text, uuid, uuid, jsonb, text, text)
  to service_role;

-- ---------------------------------------------------------------------------
-- 4. update_qualification_rules -- replaces the qualification column whole
-- (an ordered list; there is no stable per-question id to patch one entry).
-- ---------------------------------------------------------------------------

create or replace function mcp_internal.update_sales_agent_qualification_rules(
  p_bot_id text, p_request_id text, p_execution_id text, p_client_id uuid,
  p_sales_agent_id uuid, p_qualification jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = mcp_internal, public
as $$
declare
  v_agent client_sales_agents;
  v_payload jsonb;
  v_existing jsonb;
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
  if p_qualification is null or jsonb_typeof(p_qualification) <> 'array'
     or jsonb_array_length(p_qualification) < 1 or jsonb_array_length(p_qualification) > 20 then
    raise exception using message = 'invalid_request', errcode = 'P0001';
  end if;

  v_payload := jsonb_build_object('sales_agent_id', p_sales_agent_id, 'qualification', p_qualification);
  v_existing := mcp_internal.take_sales_agent_request(
    p_bot_id, p_execution_id, 'sales_agents.update_qualification_rules', p_client_id, v_payload);
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

  update client_sales_agents
     set qualification = p_qualification,
         updated_at = now()
   where id = p_sales_agent_id
   returning * into v_agent;

  v_result := jsonb_build_object('client_id', p_client_id, 'replayed', false)
    || mcp_internal.sales_agent_json(v_agent);
  insert into mcp_internal.mcp_sales_agent_requests (
    bot_id, execution_id, request_id, tool, client_id, sales_agent_id, payload, result
  ) values (
    p_bot_id, p_execution_id, p_request_id, 'sales_agents.update_qualification_rules', p_client_id, p_sales_agent_id, v_payload, v_result
  );
  return v_result;
end;
$$;
revoke all on function mcp_internal.update_sales_agent_qualification_rules(text, text, text, uuid, uuid, jsonb)
  from public, anon, authenticated;
grant execute on function mcp_internal.update_sales_agent_qualification_rules(text, text, text, uuid, uuid, jsonb)
  to service_role;

create or replace function public.mcp_update_sales_agent_qualification_rules(
  p_bot_id text, p_request_id text, p_execution_id text, p_client_id uuid,
  p_sales_agent_id uuid, p_qualification jsonb
)
returns jsonb language plpgsql security definer set search_path = mcp_internal, public as $$
begin
  perform mcp_internal.require_service_role();
  return mcp_internal.update_sales_agent_qualification_rules(
    p_bot_id, p_request_id, p_execution_id, p_client_id, p_sales_agent_id, p_qualification);
end;
$$;
revoke all on function public.mcp_update_sales_agent_qualification_rules(text, text, text, uuid, uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.mcp_update_sales_agent_qualification_rules(text, text, text, uuid, uuid, jsonb)
  to service_role;

-- ---------------------------------------------------------------------------
-- 5. test -- sandbox / dry-run rule check. Structural, not a simulated
-- conversation: this RPC layer has no HTTP client and never touches
-- sales_agent_conversations (that table is live-channel data only), so "no
-- live channel send" is a structural guarantee of this function's inputs and
-- outputs, not a policy this function has to enforce. Honestly scoped: it
-- checks the transcript against the agent's own qualification/guardrails
-- shape, it does not run an LLM.
-- ---------------------------------------------------------------------------

create or replace function mcp_internal.test_sales_agent(
  p_bot_id text, p_request_id text, p_execution_id text, p_client_id uuid,
  p_sales_agent_id uuid, p_transcript jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = mcp_internal, public
as $$
declare
  v_agent client_sales_agents;
  v_payload jsonb;
  v_existing jsonb;
  v_result jsonb;
  v_turns integer;
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
  if p_transcript is null or jsonb_typeof(p_transcript) <> 'array'
     or jsonb_array_length(p_transcript) < 1 or jsonb_array_length(p_transcript) > 60 then
    raise exception using message = 'invalid_request', errcode = 'P0001';
  end if;

  v_payload := jsonb_build_object('sales_agent_id', p_sales_agent_id, 'transcript', p_transcript);
  v_existing := mcp_internal.take_sales_agent_request(
    p_bot_id, p_execution_id, 'sales_agents.test', p_client_id, v_payload);
  if v_existing is not null then
    return v_existing;
  end if;

  select * into v_agent from client_sales_agents where id = p_sales_agent_id;
  if not found then
    raise exception using message = 'sales_agent_not_found', errcode = 'P0001';
  end if;
  if v_agent.client_id <> p_client_id then
    raise exception using message = 'client_mismatch', errcode = 'P0001';
  end if;

  v_turns := jsonb_array_length(p_transcript);
  v_result := jsonb_build_object(
    'client_id', p_client_id,
    'sales_agent_id', p_sales_agent_id,
    'sandbox', true,
    'live_channel_send', false,
    'turns_evaluated', v_turns,
    'qualification_questions_on_file', jsonb_array_length(coalesce(v_agent.qualification, '[]'::jsonb)),
    'guardrails_on_file', v_agent.guardrails is not null,
    'would_escalate', v_turns >= 6,
    'replayed', false
  );
  insert into mcp_internal.mcp_sales_agent_requests (
    bot_id, execution_id, request_id, tool, client_id, sales_agent_id, payload, result
  ) values (
    p_bot_id, p_execution_id, p_request_id, 'sales_agents.test', p_client_id, p_sales_agent_id, v_payload, v_result
  );
  return v_result;
end;
$$;
revoke all on function mcp_internal.test_sales_agent(text, text, text, uuid, uuid, jsonb)
  from public, anon, authenticated;
grant execute on function mcp_internal.test_sales_agent(text, text, text, uuid, uuid, jsonb)
  to service_role;

create or replace function public.mcp_test_sales_agent(
  p_bot_id text, p_request_id text, p_execution_id text, p_client_id uuid,
  p_sales_agent_id uuid, p_transcript jsonb
)
returns jsonb language plpgsql security definer set search_path = mcp_internal, public as $$
begin
  perform mcp_internal.require_service_role();
  return mcp_internal.test_sales_agent(
    p_bot_id, p_request_id, p_execution_id, p_client_id, p_sales_agent_id, p_transcript);
end;
$$;
revoke all on function public.mcp_test_sales_agent(text, text, text, uuid, uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.mcp_test_sales_agent(text, text, text, uuid, uuid, jsonb)
  to service_role;

-- ---------------------------------------------------------------------------
-- Ongoing guard (Sec-bar item 8) FIRST, before the permission-row insert
-- below: bot_sales_ops's forbidden-name list drops the 4 tools this phase
-- legitimately grants (create/update_knowledge/update_qualification_rules/
-- test) but keeps deploy/record_sale/proof.* -- those remain hard-denied. The
-- existing "no other Bot holds pipeline.%/sales_agents.%" check (unchanged)
-- already covers all 5 new names for free, since it matches by pattern, not
-- by an enumerated list. This function replace must land before the insert
-- immediately below: the AFTER INSERT trigger (migration 65/66) that calls it
-- fires on that very insert, and the outgoing Phase 11 version of this
-- function still forbids the 4 names this phase is about to grant.
-- ---------------------------------------------------------------------------

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
  -- Phase 11/11b (Sec-bar item 8): pipeline.*/sales_agents.* stay bot_sales_ops
  -- only. Pattern-based, so it covers every current and future name in either
  -- domain -- including this phase's 5 new sales_agents names -- without
  -- needing an update each time a name is added.
  if exists (
    select 1 from mcp_internal.mcp_bot_permissions p
    where p.bot_id <> 'bot_sales_ops'
      and (p.permission_pattern like 'pipeline.%' or p.permission_pattern like 'sales_agents.%')
  ) then
    raise exception 'Phase 11: pipeline.*/sales_agents.* must not be granted outside bot_sales_ops';
  end if;
  -- Phase 11b: bot_sales_ops must never hold deploy/record_sale/proof.* or a
  -- domain wildcard via any future row. create/update_knowledge/
  -- update_qualification_rules/test are deliberately absent from this list --
  -- this phase grants them -- unlike Phase 11's version of this function,
  -- which still forbade them.
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
end;
$$;
revoke all on function mcp_internal.assert_cos_prohibitions() from public, anon, authenticated;
grant execute on function mcp_internal.assert_cos_prohibitions() to service_role;

do $$ begin perform mcp_internal.assert_cos_prohibitions(); end $$;

-- ---------------------------------------------------------------------------
-- Permission grow: insert the exact 5 new names for bot_sales_ops. Nothing
-- else changes -- the Phase 11 17-name set stays exactly as migration 76 left
-- it; this is additive only, per Alex CLEAR #2. Runs after the trigger
-- function above is replaced, so the AFTER INSERT trigger it fires evaluates
-- against the new (Phase 11b) prohibition list, not the outgoing Phase 11 one.
-- ---------------------------------------------------------------------------

insert into mcp_internal.mcp_bot_permissions (bot_id, permission_pattern, granted_by)
select 'bot_sales_ops', name, 'phase-11b:factory-allowlist'
from (values
  ('sales_agents.generate_config'),
  ('sales_agents.create'),
  ('sales_agents.update_knowledge'),
  ('sales_agents.update_qualification_rules'),
  ('sales_agents.test')
) as t(name)
where not exists (
  select 1 from mcp_internal.mcp_bot_permissions p
   where p.bot_id = 'bot_sales_ops' and p.permission_pattern = t.name
);

do $$
begin
  if not exists (
    select 1 from mcp_internal.mcp_bot_permissions
     where bot_id = 'bot_sales_ops' and permission_pattern = 'sales_agents.generate_config'
  ) then
    raise exception 'Phase 11b: bot_sales_ops must hold the exact-name sales_agents.generate_config grant';
  end if;
  if exists (
    select 1 from mcp_internal.mcp_bot_permissions
     where bot_id = 'bot_sales_ops' and permission_pattern in ('sales_agents.deploy', 'pipeline.record_sale')
  ) then
    raise exception 'Phase 11b: bot_sales_ops must not hold deploy or record_sale';
  end if;
  if (select count(*) from mcp_internal.mcp_bot_permissions where bot_id = 'bot_sales_ops') <> 22 then
    raise exception 'Phase 11b: bot_sales_ops must hold exactly 22 permission rows (Phase 11''s 17 + this phase''s 5)';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Catalog the new ledger table in the Phase 4 RLS inventory.
-- ---------------------------------------------------------------------------

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
    ('mcp_internal', 'mcp_sales_agent_requests')
  ) as t(nsp, rel)
  left join pg_class c
    on c.relname = t.rel
   and c.relnamespace = (select n.oid from pg_namespace n where n.nspname = t.nsp);
end;
$$;
revoke all on function mcp_internal.bot_touched_rls_status() from public, anon, authenticated;
grant execute on function mcp_internal.bot_touched_rls_status() to service_role;

comment on function mcp_internal.generate_sales_agent_config(text, text, text, uuid, text) is
  'Phase 11b Bot factory compose. bot_sales_ops only (hard-coded). Server-side intel join, granted client only. Draft only -- no table write besides the ledger. Never can_access_client.';
comment on function mcp_internal.create_sales_agent(text, text, text, uuid, text, text, text) is
  'Phase 11b Bot factory write. bot_sales_ops only (hard-coded). Grant + client bind on insert. Never can_access_client.';
comment on function mcp_internal.update_sales_agent_knowledge(text, text, text, uuid, uuid, jsonb, text, text) is
  'Phase 11b Bot factory write. bot_sales_ops only (hard-coded). Grant + client + agent-ownership match. Never can_access_client.';
comment on function mcp_internal.update_sales_agent_qualification_rules(text, text, text, uuid, uuid, jsonb) is
  'Phase 11b Bot factory write. bot_sales_ops only (hard-coded). Grant + client + agent-ownership match. Never can_access_client.';
comment on function mcp_internal.test_sales_agent(text, text, text, uuid, uuid, jsonb) is
  'Phase 11b Bot factory sandbox check. bot_sales_ops only (hard-coded). No HTTP client in this layer -- structurally cannot reach a live channel. Grant + client + agent-ownership match.';
comment on table mcp_internal.mcp_sales_agent_requests is
  'Phase 11b idempotency + audit ledger for the 5 Sales Agent Factory writes. Alex approval required before applying this migration to production.';

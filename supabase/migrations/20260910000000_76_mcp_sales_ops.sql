-- Phase 11: Sales Ops Bot-safe pipeline + sales_agents RPCs, exact-allowlist
-- permission replace for bot_sales_ops. DO NOT APPLY TO PRODUCTION without
-- Alex approval. Sec design note required before merge/cutover:
-- aa-mcp-gateway/docs/phase-11-sales-ops.md. Additive only.
--
-- Sec Phase 11 bar (SEC_BAR.md, locked 2026-09-10, all 9 points addressed
-- here and in the design note):
--   1. Exact 17-tool allowlist + code ceiling; replace pipeline.*/sales_agents.*
--      wildcards for bot_sales_ops. Permission-row DELETE+INSERT below.
--   2. record_sale and sales_agents.deploy (and every other CRITICAL/HIGH
--      money-or-deploy action) stay stub/forbidden -- not realized, not
--      granted, no permission row. Nothing in this migration touches them.
--   3. proof.search / proof.get dropped from bot_sales_ops grants.
--   4. require_active_bot + require_bot_client_grant on every new RPC below.
--      Never can_access_client.
--   5. Harbour-only mcp_bot_clients grant for the first token -- this
--      migration does not issue a token or insert an mcp_bot_clients row;
--      that is a separate, later, Alex-approved step.
--   6. workflow.record_decision stays hard-denied in gateway code; untouched.
--   7. Isolation tests (agent-runtime/src/mcp/isolation-rls.test.ts, Phase 11
--      block) must be green before any of these tools leave "stub" in
--      src/registry/tools.ts.
--   8. Hard per-tool gate vs. other Bots: not needed via the permission
--      matrix -- no other Bot holds pipeline.*/sales_agents.* today (grep
--      migration 65's seed). Enforced on an ongoing basis instead by
--      extending assert_cos_prohibitions() below, plus a belt-and-suspenders
--      hard-coded bot check inside every new RPC (Phase 9b/10 pattern, and
--      PHASE11_BRIEF.md Sec-bar item 1).
--   9. update_stage / create_followup were never on the gateway's HIGH-risk
--      `approval` array in src/registry/tools.ts (only deploy/record_sale/
--      record_decision are) -- unlike Phase 9b's content.approve_asset, there
--      is no gateway reviewer gate to remove here. They land at MEDIUM risk,
--      AA-RPC-only authorization, same posture Phase 9b settled on. See
--      design note §9 for the explicit Sec question/confirmation.

-- ---------------------------------------------------------------------------
-- Ledger for Bot pipeline writes (update_stage / create_followup). Separate
-- table from mcp_content_requests: different domain, different resource
-- (lead, not idea/brief/asset), same shape and posture.
-- ---------------------------------------------------------------------------

create table mcp_internal.mcp_pipeline_requests (
  bot_id text not null,
  execution_id text not null
    check (execution_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  request_id text not null
    check (request_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  tool text not null check (tool in (
    'pipeline.update_stage',
    'pipeline.create_followup'
  )),
  client_id uuid not null references public.clients(id),
  lead_id uuid references public.client_leads(id),
  payload jsonb not null default '{}'::jsonb,
  result jsonb not null,
  created_at timestamptz not null default now(),
  primary key (bot_id, execution_id)
);
create index mcp_pipeline_requests_client_idx
  on mcp_internal.mcp_pipeline_requests (client_id, created_at desc);
alter table mcp_internal.mcp_pipeline_requests enable row level security;
alter table mcp_internal.mcp_pipeline_requests force row level security;
revoke all on mcp_internal.mcp_pipeline_requests
  from public, anon, authenticated, service_role;

create or replace function mcp_internal.take_pipeline_request(
  p_bot_id text, p_execution_id text, p_tool text, p_client_id uuid, p_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = mcp_internal, public
as $$
declare
  v_row mcp_internal.mcp_pipeline_requests;
begin
  perform mcp_internal.require_service_role();
  perform pg_advisory_xact_lock(hashtextextended(p_bot_id || ':' || p_execution_id, 1));
  select * into v_row
    from mcp_internal.mcp_pipeline_requests
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
revoke all on function mcp_internal.take_pipeline_request(text, text, text, uuid, jsonb)
  from public, anon, authenticated;
grant execute on function mcp_internal.take_pipeline_request(text, text, text, uuid, jsonb)
  to service_role;

-- lead_events gains a 'followup' kind (additive) and Bot attribution, mirroring
-- Phase 9b's client_asset_reviews.reviewed_by_bot. created_by (human, profiles)
-- and created_by_bot (Bot) are mutually exclusive on a single event row.
do $$
declare
  v_conname text;
begin
  select c.conname into v_conname
    from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
    join pg_attribute a on a.attrelid = t.oid and a.attname = 'kind'
   where n.nspname = 'public'
     and t.relname = 'lead_events'
     and c.contype = 'c'
     and c.conkey = array[a.attnum];
  if v_conname is not null then
    execute format('alter table lead_events drop constraint %I', v_conname);
  end if;
end $$;
alter table lead_events
  add constraint lead_events_kind_check
  check (kind in ('note', 'conversation', 'stage_change', 'appointment', 'outcome', 'followup'));

alter table lead_events
  add column created_by_bot text references mcp_internal.mcp_bots(bot_id);
alter table lead_events
  add constraint le_single_actor_source
  check (created_by is null or created_by_bot is null);
create index le_bot_idx on lead_events (created_by_bot) where created_by_bot is not null;

-- ---------------------------------------------------------------------------
-- Reads -- VOLATILE (not STABLE): require_bot_client_grant uses FOR SHARE.
-- ---------------------------------------------------------------------------

create or replace function mcp_internal.lead_json(p client_leads)
returns jsonb
language sql
stable
set search_path = mcp_internal, public
as $$
  select jsonb_build_object(
    'id', p.id,
    'client_id', p.client_id,
    'name', p.name,
    'email', p.email,
    'phone', p.phone,
    'stage', p.stage,
    'stage_at', p.stage_at,
    'lost_reason', p.lost_reason,
    'owner_member_id', p.owner_member_id,
    'next_action', p.next_action,
    'next_action_due', p.next_action_due,
    'opportunity_value', p.opportunity_value,
    'sale_value', p.sale_value,
    'cash_collected', p.cash_collected,
    'appointment_at', p.appointment_at,
    'appointment_outcome', p.appointment_outcome,
    'source_channel', p.source_channel,
    'source_sales_agent_id', p.source_sales_agent_id,
    'notes', mcp_internal.clip_text(p.notes),
    'created_at', p.created_at,
    'updated_at', p.updated_at
  );
$$;
revoke all on function mcp_internal.lead_json(client_leads) from public, anon, authenticated;
grant execute on function mcp_internal.lead_json(client_leads) to service_role;

create or replace function mcp_internal.list_leads(
  p_bot_id text, p_client_id uuid, p_limit integer default 25, p_stage text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = mcp_internal, public
as $$
declare
  v_limit integer;
  v_leads jsonb;
begin
  perform mcp_internal.require_active_bot(p_bot_id);
  perform mcp_internal.require_bot_client_grant(p_bot_id, p_client_id);
  v_limit := least(greatest(coalesce(p_limit, 25), 1), 100);
  if p_stage is not null and p_stage not in
    ('lead','conversation','qualified_conversation','appointment',
     'qualified_appointment','shown','sale','cash','lost') then
    raise exception using message = 'invalid_request', errcode = 'P0001';
  end if;
  select coalesce(jsonb_agg(x.obj order by x.stage_at desc), '[]'::jsonb)
    into v_leads
    from (
      select mcp_internal.lead_json(l) as obj, l.stage_at
        from client_leads l
       where l.client_id = p_client_id
         and (p_stage is null or l.stage::text = p_stage)
       order by l.stage_at desc
       limit v_limit
    ) x;
  return jsonb_build_object(
    'client_id', p_client_id,
    'leads', v_leads,
    'count', jsonb_array_length(v_leads)
  );
end;
$$;

create or replace function mcp_internal.get_lead(
  p_bot_id text, p_client_id uuid, p_lead_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = mcp_internal, public
as $$
declare
  v_lead client_leads;
begin
  perform mcp_internal.require_active_bot(p_bot_id);
  perform mcp_internal.require_bot_client_grant(p_bot_id, p_client_id);
  if p_lead_id is null then
    raise exception using message = 'invalid_request', errcode = 'P0001';
  end if;
  select * into v_lead from client_leads where id = p_lead_id;
  if not found then
    raise exception using message = 'lead_not_found', errcode = 'P0001';
  end if;
  if v_lead.client_id <> p_client_id then
    raise exception using message = 'client_mismatch', errcode = 'P0001';
  end if;
  return jsonb_build_object('client_id', p_client_id) || mcp_internal.lead_json(v_lead);
end;
$$;

create or replace function mcp_internal.get_stalled_leads(
  p_bot_id text, p_client_id uuid, p_limit integer default 25, p_days integer default 7
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
  select coalesce(jsonb_agg(to_jsonb(s) order by s.days_in_stage desc), '[]'::jsonb)
    into v_rows
    from (
      select * from public.stalled_leads(p_client_id, p_days) limit v_limit
    ) s;
  return jsonb_build_object(
    'client_id', p_client_id,
    'stalled_leads', v_rows,
    'count', jsonb_array_length(v_rows)
  );
end;
$$;

create or replace function mcp_internal.get_pipeline_summary(
  p_bot_id text, p_client_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = mcp_internal, public
as $$
declare
  v_by_stage jsonb;
  v_totals record;
  v_stalled integer;
begin
  perform mcp_internal.require_active_bot(p_bot_id);
  perform mcp_internal.require_bot_client_grant(p_bot_id, p_client_id);
  select coalesce(jsonb_agg(jsonb_build_object(
      'stage', x.stage, 'count', x.n, 'opportunity_value', x.value
    ) order by x.stage), '[]'::jsonb)
    into v_by_stage
    from (
      select l.stage::text as stage, count(*) as n,
             coalesce(sum(l.opportunity_value), 0) as value
        from client_leads l
       where l.client_id = p_client_id
       group by l.stage
    ) x;
  select count(*) as total_leads,
         coalesce(sum(opportunity_value), 0) as total_opportunity_value,
         coalesce(sum(cash_collected), 0) as total_cash_collected
    into v_totals
    from client_leads
   where client_id = p_client_id;
  select count(*) into v_stalled
    from public.stalled_leads(p_client_id, 7);
  return jsonb_build_object(
    'client_id', p_client_id,
    'by_stage', v_by_stage,
    'total_leads', v_totals.total_leads,
    'total_opportunity_value', v_totals.total_opportunity_value,
    'total_cash_collected', v_totals.total_cash_collected,
    'stalled_count', v_stalled
  );
end;
$$;

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

create or replace function mcp_internal.list_sales_agents(
  p_bot_id text, p_client_id uuid, p_limit integer default 25
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = mcp_internal, public
as $$
declare
  v_limit integer;
  v_agents jsonb;
begin
  perform mcp_internal.require_active_bot(p_bot_id);
  perform mcp_internal.require_bot_client_grant(p_bot_id, p_client_id);
  v_limit := least(greatest(coalesce(p_limit, 25), 1), 100);
  select coalesce(jsonb_agg(x.obj order by x.created_at desc), '[]'::jsonb)
    into v_agents
    from (
      select mcp_internal.sales_agent_json(a) as obj, a.created_at
        from client_sales_agents a
       where a.client_id = p_client_id
       order by a.created_at desc
       limit v_limit
    ) x;
  return jsonb_build_object(
    'client_id', p_client_id,
    'sales_agents', v_agents,
    'count', jsonb_array_length(v_agents)
  );
end;
$$;

create or replace function mcp_internal.get_sales_agent(
  p_bot_id text, p_client_id uuid, p_sales_agent_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = mcp_internal, public
as $$
declare
  v_agent client_sales_agents;
begin
  perform mcp_internal.require_active_bot(p_bot_id);
  perform mcp_internal.require_bot_client_grant(p_bot_id, p_client_id);
  if p_sales_agent_id is null then
    raise exception using message = 'invalid_request', errcode = 'P0001';
  end if;
  select * into v_agent from client_sales_agents where id = p_sales_agent_id;
  if not found then
    raise exception using message = 'sales_agent_not_found', errcode = 'P0001';
  end if;
  if v_agent.client_id <> p_client_id then
    raise exception using message = 'client_mismatch', errcode = 'P0001';
  end if;
  return jsonb_build_object('client_id', p_client_id) || mcp_internal.sales_agent_json(v_agent);
end;
$$;

-- Transcript is summarized as a turn count, not returned in full: the
-- conversation-level roster (who, whether qualified, what happened) is what
-- Sales Ops needs for pipeline visibility; the raw transcript (which may
-- carry more contact detail than the structured contact_* columns already
-- surface) is left out of this default read. See design note §Data
-- minimization.
create or replace function mcp_internal.sales_agent_conversation_json(p sales_agent_conversations)
returns jsonb
language sql
stable
set search_path = mcp_internal, public
as $$
  select jsonb_build_object(
    'id', p.id,
    'client_id', p.client_id,
    'sales_agent_id', p.sales_agent_id,
    'page_id', p.page_id,
    'contact_name', p.contact_name,
    'contact_email', p.contact_email,
    'contact_phone', p.contact_phone,
    'qualified', p.qualified,
    'outcome', p.outcome,
    'handed_over', p.handed_over,
    'lead_id', p.lead_id,
    'transcript_turns', jsonb_array_length(coalesce(p.transcript, '[]'::jsonb)),
    'started_at', p.started_at,
    'ended_at', p.ended_at
  );
$$;
revoke all on function mcp_internal.sales_agent_conversation_json(sales_agent_conversations)
  from public, anon, authenticated;
grant execute on function mcp_internal.sales_agent_conversation_json(sales_agent_conversations)
  to service_role;

create or replace function mcp_internal.get_sales_agent_conversations(
  p_bot_id text, p_client_id uuid, p_sales_agent_id uuid default null, p_limit integer default 25
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = mcp_internal, public
as $$
declare
  v_limit integer;
  v_agent client_sales_agents;
  v_rows jsonb;
begin
  perform mcp_internal.require_active_bot(p_bot_id);
  perform mcp_internal.require_bot_client_grant(p_bot_id, p_client_id);
  v_limit := least(greatest(coalesce(p_limit, 25), 1), 100);
  if p_sales_agent_id is not null then
    select * into v_agent from client_sales_agents where id = p_sales_agent_id;
    if not found then
      raise exception using message = 'sales_agent_not_found', errcode = 'P0001';
    end if;
    if v_agent.client_id <> p_client_id then
      raise exception using message = 'client_mismatch', errcode = 'P0001';
    end if;
  end if;
  select coalesce(jsonb_agg(x.obj order by x.started_at desc), '[]'::jsonb)
    into v_rows
    from (
      select mcp_internal.sales_agent_conversation_json(c) as obj, c.started_at
        from sales_agent_conversations c
       where c.client_id = p_client_id
         and (p_sales_agent_id is null or c.sales_agent_id = p_sales_agent_id)
       order by c.started_at desc
       limit v_limit
    ) x;
  return jsonb_build_object(
    'client_id', p_client_id,
    'conversations', v_rows,
    'count', jsonb_array_length(v_rows)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Writes. Both hard-code p_bot_id <> 'bot_sales_ops' -> bot_forbidden,
-- belt-and-suspenders alongside the exact-allowlist gateway ceiling and the
-- ongoing assert_cos_prohibitions() guard below (Sec-bar item 1 / item 8).
-- ---------------------------------------------------------------------------

-- Bot-safe sibling of advance_lead (migration 61): same two business rules
-- (a 'lost' stage needs a reason; a completed next_action is cleared), but
-- require_active_bot + require_bot_client_grant instead of can_access_client,
-- explicit client_id match, idempotency ledger, and Bot attribution on the
-- event row. Not a call-through to advance_lead: that function's own
-- can_access_client check is the human/Console posture, a different check
-- than the Bot grant check this RPC must enforce first, and it has no
-- idempotency key or explicit resource-ownership error shape to reuse.
--
-- Money-adjacent guard: 'sale' and 'cash' are excluded target stages. Those
-- two terminal states are where revenue gets declared, and Alex's CLEAR
-- defers pipeline.record_sale to a later phase -- a Bot must not reach the
-- same outcome by stage-walking around record_sale via this RPC. Moving a
-- lead to 'sale'/'cash' remains human-only (Console) or a future, separately
-- CLEARed record_sale, until then.
create or replace function mcp_internal.update_lead_stage(
  p_bot_id text, p_request_id text, p_execution_id text, p_client_id uuid,
  p_lead_id uuid, p_stage text, p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = mcp_internal, public
as $$
declare
  v_lead client_leads;
  v_from text;
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
  if p_lead_id is null or p_stage is null then
    raise exception using message = 'invalid_request', errcode = 'P0001';
  end if;
  if p_stage not in
    ('lead','conversation','qualified_conversation','appointment',
     'qualified_appointment','shown','lost') then
    raise exception using message = 'invalid_stage', errcode = 'P0001';
  end if;
  if p_note is not null and length(p_note) > 4000 then
    raise exception using message = 'invalid_request', errcode = 'P0001';
  end if;

  v_payload := jsonb_strip_nulls(jsonb_build_object(
    'lead_id', p_lead_id, 'stage', p_stage, 'note', p_note));
  v_existing := mcp_internal.take_pipeline_request(
    p_bot_id, p_execution_id, 'pipeline.update_stage', p_client_id, v_payload);
  if v_existing is not null then
    return v_existing;
  end if;

  select * into v_lead from client_leads where id = p_lead_id for update;
  if not found then
    raise exception using message = 'lead_not_found', errcode = 'P0001';
  end if;
  if v_lead.client_id <> p_client_id then
    raise exception using message = 'client_mismatch', errcode = 'P0001';
  end if;
  if p_stage = 'lost' and coalesce(trim(p_note), '') = '' then
    raise exception using message = 'lost_reason_required', errcode = 'P0001';
  end if;

  v_from := v_lead.stage::text;
  update client_leads
     set stage = p_stage::lead_stage,
         stage_at = now(),
         lost_reason = case when p_stage = 'lost' then p_note else lost_reason end,
         next_action = case when p_stage = v_from then next_action else null end,
         next_action_due = case when p_stage = v_from then next_action_due else null end,
         updated_at = now()
   where id = p_lead_id;
  insert into lead_events (lead_id, client_id, kind, body, from_stage, to_stage, created_by_bot)
  values (p_lead_id, p_client_id, 'stage_change', nullif(trim(coalesce(p_note, '')), ''),
          v_from::lead_stage, p_stage::lead_stage, p_bot_id);

  v_result := jsonb_build_object(
    'client_id', p_client_id,
    'lead_id', p_lead_id,
    'from_stage', v_from,
    'stage', p_stage,
    'replayed', false
  );
  insert into mcp_internal.mcp_pipeline_requests (
    bot_id, execution_id, request_id, tool, client_id, lead_id, payload, result
  ) values (
    p_bot_id, p_execution_id, p_request_id, 'pipeline.update_stage', p_client_id, p_lead_id, v_payload, v_result
  );
  return v_result;
end;
$$;
revoke all on function mcp_internal.update_lead_stage(text, text, text, uuid, uuid, text, text)
  from public, anon, authenticated;
grant execute on function mcp_internal.update_lead_stage(text, text, text, uuid, uuid, text, text)
  to service_role;

create or replace function public.mcp_update_lead_stage(
  p_bot_id text, p_request_id text, p_execution_id text, p_client_id uuid,
  p_lead_id uuid, p_stage text, p_note text default null
)
returns jsonb language plpgsql security definer set search_path = mcp_internal, public as $$
begin
  perform mcp_internal.require_service_role();
  return mcp_internal.update_lead_stage(
    p_bot_id, p_request_id, p_execution_id, p_client_id, p_lead_id, p_stage, p_note);
end;
$$;
revoke all on function public.mcp_update_lead_stage(text, text, text, uuid, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.mcp_update_lead_stage(text, text, text, uuid, uuid, text, text)
  to service_role;

-- Schedules/records the single next action on a lead. Timeline gets a
-- 'followup' event so "what did we say we'd do, and when" survives an
-- overwrite of next_action by a later call -- same reasoning migration 60's
-- comment gives for lead_events existing at all.
create or replace function mcp_internal.create_followup(
  p_bot_id text, p_request_id text, p_execution_id text, p_client_id uuid,
  p_lead_id uuid, p_next_action text, p_next_action_due date default null
)
returns jsonb
language plpgsql
security definer
set search_path = mcp_internal, public
as $$
declare
  v_lead client_leads;
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
  if p_lead_id is null or p_next_action is null
     or length(trim(p_next_action)) < 1 or length(p_next_action) > 500 then
    raise exception using message = 'invalid_request', errcode = 'P0001';
  end if;

  v_payload := jsonb_strip_nulls(jsonb_build_object(
    'lead_id', p_lead_id, 'next_action', p_next_action, 'next_action_due', p_next_action_due));
  v_existing := mcp_internal.take_pipeline_request(
    p_bot_id, p_execution_id, 'pipeline.create_followup', p_client_id, v_payload);
  if v_existing is not null then
    return v_existing;
  end if;

  select * into v_lead from client_leads where id = p_lead_id for update;
  if not found then
    raise exception using message = 'lead_not_found', errcode = 'P0001';
  end if;
  if v_lead.client_id <> p_client_id then
    raise exception using message = 'client_mismatch', errcode = 'P0001';
  end if;

  update client_leads
     set next_action = p_next_action,
         next_action_due = p_next_action_due,
         updated_at = now()
   where id = p_lead_id;
  insert into lead_events (lead_id, client_id, kind, body, created_by_bot)
  values (p_lead_id, p_client_id, 'followup', p_next_action, p_bot_id);

  v_result := jsonb_build_object(
    'client_id', p_client_id,
    'lead_id', p_lead_id,
    'next_action', p_next_action,
    'next_action_due', p_next_action_due,
    'replayed', false
  );
  insert into mcp_internal.mcp_pipeline_requests (
    bot_id, execution_id, request_id, tool, client_id, lead_id, payload, result
  ) values (
    p_bot_id, p_execution_id, p_request_id, 'pipeline.create_followup', p_client_id, p_lead_id, v_payload, v_result
  );
  return v_result;
end;
$$;
revoke all on function mcp_internal.create_followup(text, text, text, uuid, uuid, text, date)
  from public, anon, authenticated;
grant execute on function mcp_internal.create_followup(text, text, text, uuid, uuid, text, date)
  to service_role;

create or replace function public.mcp_create_followup(
  p_bot_id text, p_request_id text, p_execution_id text, p_client_id uuid,
  p_lead_id uuid, p_next_action text, p_next_action_due date default null
)
returns jsonb language plpgsql security definer set search_path = mcp_internal, public as $$
begin
  perform mcp_internal.require_service_role();
  return mcp_internal.create_followup(
    p_bot_id, p_request_id, p_execution_id, p_client_id, p_lead_id, p_next_action, p_next_action_due);
end;
$$;
revoke all on function public.mcp_create_followup(text, text, text, uuid, uuid, text, date)
  from public, anon, authenticated;
grant execute on function public.mcp_create_followup(text, text, text, uuid, uuid, text, date)
  to service_role;

-- ---------------------------------------------------------------------------
-- Public read wrappers. Same posture as every other public.mcp_* wrapper:
-- logic lives in mcp_internal, this only exists so PostgREST can reach it.
-- ---------------------------------------------------------------------------

create or replace function public.mcp_list_leads(
  p_bot_id text, p_client_id uuid, p_limit integer default 25, p_stage text default null
)
returns jsonb language plpgsql security definer set search_path = mcp_internal, public as $$
begin
  perform mcp_internal.require_service_role();
  return mcp_internal.list_leads(p_bot_id, p_client_id, p_limit, p_stage);
end;
$$;

create or replace function public.mcp_get_lead(
  p_bot_id text, p_client_id uuid, p_lead_id uuid
)
returns jsonb language plpgsql security definer set search_path = mcp_internal, public as $$
begin
  perform mcp_internal.require_service_role();
  return mcp_internal.get_lead(p_bot_id, p_client_id, p_lead_id);
end;
$$;

create or replace function public.mcp_get_stalled_leads(
  p_bot_id text, p_client_id uuid, p_limit integer default 25, p_days integer default 7
)
returns jsonb language plpgsql security definer set search_path = mcp_internal, public as $$
begin
  perform mcp_internal.require_service_role();
  return mcp_internal.get_stalled_leads(p_bot_id, p_client_id, p_limit, p_days);
end;
$$;

create or replace function public.mcp_get_pipeline_summary(
  p_bot_id text, p_client_id uuid
)
returns jsonb language plpgsql security definer set search_path = mcp_internal, public as $$
begin
  perform mcp_internal.require_service_role();
  return mcp_internal.get_pipeline_summary(p_bot_id, p_client_id);
end;
$$;

create or replace function public.mcp_list_sales_agents(
  p_bot_id text, p_client_id uuid, p_limit integer default 25
)
returns jsonb language plpgsql security definer set search_path = mcp_internal, public as $$
begin
  perform mcp_internal.require_service_role();
  return mcp_internal.list_sales_agents(p_bot_id, p_client_id, p_limit);
end;
$$;

create or replace function public.mcp_get_sales_agent(
  p_bot_id text, p_client_id uuid, p_sales_agent_id uuid
)
returns jsonb language plpgsql security definer set search_path = mcp_internal, public as $$
begin
  perform mcp_internal.require_service_role();
  return mcp_internal.get_sales_agent(p_bot_id, p_client_id, p_sales_agent_id);
end;
$$;

create or replace function public.mcp_get_sales_agent_conversations(
  p_bot_id text, p_client_id uuid, p_sales_agent_id uuid default null, p_limit integer default 25
)
returns jsonb language plpgsql security definer set search_path = mcp_internal, public as $$
begin
  perform mcp_internal.require_service_role();
  return mcp_internal.get_sales_agent_conversations(p_bot_id, p_client_id, p_sales_agent_id, p_limit);
end;
$$;

revoke all on function public.mcp_list_leads(text, uuid, integer, text) from public, anon, authenticated;
revoke all on function public.mcp_get_lead(text, uuid, uuid) from public, anon, authenticated;
revoke all on function public.mcp_get_stalled_leads(text, uuid, integer, integer) from public, anon, authenticated;
revoke all on function public.mcp_get_pipeline_summary(text, uuid) from public, anon, authenticated;
revoke all on function public.mcp_list_sales_agents(text, uuid, integer) from public, anon, authenticated;
revoke all on function public.mcp_get_sales_agent(text, uuid, uuid) from public, anon, authenticated;
revoke all on function public.mcp_get_sales_agent_conversations(text, uuid, uuid, integer) from public, anon, authenticated;
grant execute on function public.mcp_list_leads(text, uuid, integer, text) to service_role;
grant execute on function public.mcp_get_lead(text, uuid, uuid) to service_role;
grant execute on function public.mcp_get_stalled_leads(text, uuid, integer, integer) to service_role;
grant execute on function public.mcp_get_pipeline_summary(text, uuid) to service_role;
grant execute on function public.mcp_list_sales_agents(text, uuid, integer) to service_role;
grant execute on function public.mcp_get_sales_agent(text, uuid, uuid) to service_role;
grant execute on function public.mcp_get_sales_agent_conversations(text, uuid, uuid, integer) to service_role;

-- ---------------------------------------------------------------------------
-- Permission replace: delete the wildcard + proof.* rows, insert the exact
-- 17-name allowlist. bot_sales_ops only; every other Bot's grants untouched.
-- ---------------------------------------------------------------------------

delete from mcp_internal.mcp_bot_permissions
 where bot_id = 'bot_sales_ops'
   and permission_pattern in ('pipeline.*', 'sales_agents.*', 'proof.search', 'proof.get');

insert into mcp_internal.mcp_bot_permissions (bot_id, permission_pattern, granted_by)
select 'bot_sales_ops', name, 'phase-11:exact-allowlist'
from (values
  ('pipeline.list_leads'),
  ('pipeline.get_lead'),
  ('pipeline.get_stalled_leads'),
  ('pipeline.get_pipeline_summary'),
  ('pipeline.update_stage'),
  ('pipeline.create_followup'),
  ('sales_agents.list'),
  ('sales_agents.get'),
  ('sales_agents.get_conversations')
) as t(name)
where not exists (
  select 1 from mcp_internal.mcp_bot_permissions p
   where p.bot_id = 'bot_sales_ops' and p.permission_pattern = t.name
);

-- ---------------------------------------------------------------------------
-- Ongoing guard (Sec-bar item 8): extend the existing CoS prohibition
-- function/trigger (migration 65/66) so this check runs on every future
-- mcp_bot_permissions write, not just at migration-apply time. No other Bot
-- holds pipeline.*/sales_agents.* today; this keeps it that way.
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
  -- Phase 11 (Sec-bar item 8): pipeline.*/sales_agents.* stay bot_sales_ops
  -- only. No other Bot holds either domain today; this keeps it that way for
  -- every future permission write, not just this migration.
  if exists (
    select 1 from mcp_internal.mcp_bot_permissions p
    where p.bot_id <> 'bot_sales_ops'
      and (p.permission_pattern like 'pipeline.%' or p.permission_pattern like 'sales_agents.%')
  ) then
    raise exception 'Phase 11: pipeline.*/sales_agents.* must not be granted outside bot_sales_ops';
  end if;
  -- Phase 11 (Sec-bar item 2/3): bot_sales_ops must never hold the deferred
  -- money/deploy actions or the dropped proof.* grants via any future row.
  if exists (
    select 1 from mcp_internal.mcp_bot_permissions p
    where p.bot_id = 'bot_sales_ops'
      and (
        p.permission_pattern in ('pipeline.record_sale', 'sales_agents.deploy',
          'sales_agents.create', 'sales_agents.update_knowledge',
          'sales_agents.update_qualification_rules', 'sales_agents.test',
          'proof.search', 'proof.get', 'proof.*')
        or p.permission_pattern = 'pipeline.*'
        or p.permission_pattern = 'sales_agents.*'
      )
  ) then
    raise exception 'Phase 11: bot_sales_ops must not hold record_sale/deploy/proof.* or a domain wildcard';
  end if;
end;
$$;
revoke all on function mcp_internal.assert_cos_prohibitions() from public, anon, authenticated;
grant execute on function mcp_internal.assert_cos_prohibitions() to service_role;

do $$ begin perform mcp_internal.assert_cos_prohibitions(); end $$;

do $$
begin
  if not exists (
    select 1 from mcp_internal.mcp_bot_permissions
     where bot_id = 'bot_sales_ops' and permission_pattern = 'pipeline.update_stage'
  ) then
    raise exception 'Phase 11: bot_sales_ops must hold the exact-name pipeline.update_stage grant';
  end if;
  if exists (
    select 1 from mcp_internal.mcp_bot_permissions
     where bot_id = 'bot_sales_ops' and permission_pattern in ('pipeline.*', 'sales_agents.*')
  ) then
    raise exception 'Phase 11: bot_sales_ops must not retain the pipeline.*/sales_agents.* wildcards';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Catalog the new ledger + sales tables in the Phase 4 RLS inventory.
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
    ('mcp_internal', 'mcp_pipeline_requests')
  ) as t(nsp, rel)
  left join pg_class c
    on c.relname = t.rel
   and c.relnamespace = (select n.oid from pg_namespace n where n.nspname = t.nsp);
end;
$$;
revoke all on function mcp_internal.bot_touched_rls_status() from public, anon, authenticated;
grant execute on function mcp_internal.bot_touched_rls_status() to service_role;

comment on function mcp_internal.update_lead_stage(text, text, text, uuid, uuid, text, text) is
  'Phase 11 Bot lead stage move. bot_sales_ops only (hard-coded). Excludes sale/cash target stages (money-adjacent; deferred to pipeline.record_sale). Grant + client match. Never can_access_client.';
comment on function mcp_internal.create_followup(text, text, text, uuid, uuid, text, date) is
  'Phase 11 Bot follow-up write. bot_sales_ops only (hard-coded). Grant + client match. Never can_access_client.';
comment on column lead_events.created_by_bot is
  'Phase 11: Bot attribution for a Bot-written event row. Mutually exclusive with created_by (human). Alex approval required before applying this migration to production.';
comment on table mcp_internal.mcp_pipeline_requests is
  'Phase 11 idempotency ledger for pipeline.update_stage / pipeline.create_followup. Alex approval required before applying this migration to production.';

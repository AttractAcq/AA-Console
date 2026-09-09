-- Phase 9b: Production Bot decide path (idea approve + real asset approve).
-- Alex CLEAR 2026-09-09: bot_production only. Sec design note required before
-- merge/cutover: aa-mcp-gateway/docs/phase-9b-production-bot-decide.md.
-- DO NOT APPLY TO PRODUCTION without Alex approval. Additive only.
--
-- Both new RPCs use the same require_active_bot + require_bot_client_grant
-- posture as every Phase 5/6 Bot content RPC, plus a hard-coded
-- p_bot_id <> 'bot_production' check (bot_forbidden). That hard check, not a
-- mcp_bot_permissions row, is what keeps this off bot_marketing (which
-- already holds content.* for its other real content tools), bot_chief_of_staff
-- and bot_client_delivery. No permission-row inserts. workflow.record_decision
-- remains hard-denied in gateway code. No SQL from Bots (unchanged: gateway
-- has no Postgres client).

-- ---------------------------------------------------------------------------
-- Ledger: allow the two new tool names on the existing Phase 5 write ledger.
-- One ledger, not a second table.
-- ---------------------------------------------------------------------------

do $$
declare
  v_conname text;
begin
  -- Match by constrained column, not by rendered definition text: Postgres
  -- prints `tool in (...)` back as `tool = ANY (ARRAY[...])`, so a substring
  -- match on the definition (e.g. '%tool%in%') silently fails to find it.
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
    'content.approve_asset'
  ));

-- ---------------------------------------------------------------------------
-- Single ledger for asset decisions: extend client_asset_reviews rather than
-- add a second decision table. Exactly one attribution source per row; the
-- check is deliberately not "exactly one non-null" because reviewed_by has
-- on delete set null against profiles and a stricter check would break that
-- existing cascade if a reviewer's profile is later deleted.
-- ---------------------------------------------------------------------------

alter table client_asset_reviews
  add column reviewed_by_bot text references mcp_internal.mcp_bots(bot_id);
alter table client_asset_reviews
  add constraint car_single_reviewer_source
  check (reviewed_by is null or reviewed_by_bot is null);
create index car_bot_idx on client_asset_reviews (reviewed_by_bot)
  where reviewed_by_bot is not null;

-- ---------------------------------------------------------------------------
-- Idea approve. draft -> approved. Does not generate a brief (decoupled from
-- Console's combined approve+generate on purpose). generate_brief already
-- requires status = 'approved' (migration 66 enqueue_mcp_brief), so no change
-- is needed there for the two to compose.
-- ---------------------------------------------------------------------------

create or replace function mcp_internal.approve_idea(
  p_bot_id text, p_request_id text, p_execution_id text, p_client_id uuid, p_idea_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = mcp_internal, public
as $$
declare
  v_idea client_ideas;
  v_payload jsonb;
  v_existing jsonb;
  v_result jsonb;
  v_status text;
begin
  -- Sec Phase 5 posture: active bot + mcp_bot_clients grant. Never can_access_client.
  perform mcp_internal.require_active_bot(p_bot_id);
  perform mcp_internal.require_bot_client_grant(p_bot_id, p_client_id);
  -- Phase 9b Alex CLEAR: idea-approve Bot decide is bot_production only. Hard-coded,
  -- not expressed as a permission row (bot_marketing keeps content.* for other tools).
  if p_bot_id <> 'bot_production' then
    raise exception using message = 'bot_forbidden', errcode = 'P0001';
  end if;
  perform mcp_internal.require_mcp_ids(p_request_id, p_execution_id);
  if p_idea_id is null then
    raise exception using message = 'invalid_request', errcode = 'P0001';
  end if;

  v_payload := jsonb_build_object('idea_id', p_idea_id);
  v_existing := mcp_internal.take_content_request(
    p_bot_id, p_execution_id, 'content.select_idea', p_client_id, v_payload);
  if v_existing is not null then
    return v_existing;
  end if;

  select * into v_idea from client_ideas where id = p_idea_id for update;
  if not found then
    raise exception using message = 'idea_not_found', errcode = 'P0001';
  end if;
  if v_idea.client_id <> p_client_id then
    raise exception using message = 'client_mismatch', errcode = 'P0001';
  end if;

  if v_idea.status = 'rejected' then
    raise exception using message = 'invalid_idea_status', errcode = 'P0001';
  end if;
  if v_idea.status = 'draft' then
    update client_ideas set status = 'approved' where id = p_idea_id;
    v_status := 'approved';
  else
    -- Already approved or briefed: idempotent no-op, desired end state already holds.
    v_status := v_idea.status;
  end if;

  v_result := jsonb_build_object(
    'client_id', p_client_id,
    'idea_id', p_idea_id,
    'idea_status', v_status,
    'replayed', false
  );
  insert into mcp_internal.mcp_content_requests (
    bot_id, execution_id, request_id, tool, client_id, idea_id, payload, result
  ) values (
    p_bot_id, p_execution_id, p_request_id, 'content.select_idea', p_client_id, p_idea_id, v_payload, v_result
  );
  return v_result;
end;
$$;
revoke all on function mcp_internal.approve_idea(text, text, text, uuid, uuid)
  from public, anon, authenticated;
grant execute on function mcp_internal.approve_idea(text, text, text, uuid, uuid) to service_role;

create or replace function public.mcp_approve_idea(
  p_bot_id text, p_request_id text, p_execution_id text, p_client_id uuid, p_idea_id uuid
)
returns jsonb language plpgsql security definer set search_path = mcp_internal, public as $$
begin
  perform mcp_internal.require_service_role();
  return mcp_internal.approve_idea(p_bot_id, p_request_id, p_execution_id, p_client_id, p_idea_id);
end;
$$;
revoke all on function public.mcp_approve_idea(text, text, text, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.mcp_approve_idea(text, text, text, uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- Asset approve/reject. Single ledger with review_media_asset: same two
-- tables (client_media_assets.review_status, client_asset_reviews), never a
-- second decision table. Only decides a currently-pending asset (no override
-- of an existing decision); Console review_media_asset is unchanged and can
-- still decide or override any asset, including a Bot-decided one.
-- ---------------------------------------------------------------------------

create or replace function mcp_internal.approve_asset(
  p_bot_id text, p_request_id text, p_execution_id text, p_client_id uuid,
  p_asset_id uuid, p_decision text, p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = mcp_internal, public
as $$
declare
  v_asset client_media_assets;
  v_payload jsonb;
  v_existing jsonb;
  v_result jsonb;
begin
  -- Sec Phase 5 posture: active bot + mcp_bot_clients grant. Never can_access_client.
  perform mcp_internal.require_active_bot(p_bot_id);
  perform mcp_internal.require_bot_client_grant(p_bot_id, p_client_id);
  -- Phase 9b Alex CLEAR: asset-decide Bot decide is bot_production only. Hard-coded,
  -- not expressed as a permission row (bot_marketing keeps content.* for other tools).
  if p_bot_id <> 'bot_production' then
    raise exception using message = 'bot_forbidden', errcode = 'P0001';
  end if;
  perform mcp_internal.require_mcp_ids(p_request_id, p_execution_id);
  if p_decision is null or p_decision not in ('approved', 'rejected') then
    raise exception using message = 'invalid_request', errcode = 'P0001';
  end if;
  if p_reason is not null and length(p_reason) > 4000 then
    raise exception using message = 'invalid_request', errcode = 'P0001';
  end if;

  v_payload := jsonb_strip_nulls(jsonb_build_object(
    'asset_id', p_asset_id, 'decision', p_decision, 'reason', p_reason));
  v_existing := mcp_internal.take_content_request(
    p_bot_id, p_execution_id, 'content.approve_asset', p_client_id, v_payload);
  if v_existing is not null then
    return v_existing;
  end if;

  select * into v_asset from client_media_assets where id = p_asset_id for update;
  if not found then
    raise exception using message = 'asset_not_found', errcode = 'P0001';
  end if;
  if v_asset.client_id <> p_client_id then
    raise exception using message = 'client_mismatch', errcode = 'P0001';
  end if;
  if v_asset.review_status <> 'pending' then
    raise exception using message = 'invalid_asset_status', errcode = 'P0001';
  end if;

  update client_media_assets
     set review_status = p_decision::review_status
   where id = p_asset_id;
  insert into client_asset_reviews (asset_id, decision, reason, reviewed_by_bot)
  values (p_asset_id, p_decision::review_status, p_reason, p_bot_id);

  v_result := jsonb_build_object(
    'client_id', p_client_id,
    'asset_id', p_asset_id,
    'decision', p_decision,
    'reviewed_by_bot', p_bot_id,
    'replayed', false
  );
  insert into mcp_internal.mcp_content_requests (
    bot_id, execution_id, request_id, tool, client_id, asset_id, payload, result
  ) values (
    p_bot_id, p_execution_id, p_request_id, 'content.approve_asset', p_client_id, p_asset_id, v_payload, v_result
  );
  return v_result;
end;
$$;
revoke all on function mcp_internal.approve_asset(text, text, text, uuid, uuid, text, text)
  from public, anon, authenticated;
grant execute on function mcp_internal.approve_asset(text, text, text, uuid, uuid, text, text)
  to service_role;

create or replace function public.mcp_approve_asset(
  p_bot_id text, p_request_id text, p_execution_id text, p_client_id uuid,
  p_asset_id uuid, p_decision text, p_reason text default null
)
returns jsonb language plpgsql security definer set search_path = mcp_internal, public as $$
begin
  perform mcp_internal.require_service_role();
  return mcp_internal.approve_asset(
    p_bot_id, p_request_id, p_execution_id, p_client_id, p_asset_id, p_decision, p_reason);
end;
$$;
revoke all on function public.mcp_approve_asset(text, text, text, uuid, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.mcp_approve_asset(text, text, text, uuid, uuid, text, text)
  to service_role;

-- ---------------------------------------------------------------------------
-- Catalog + guard assertions.
-- ---------------------------------------------------------------------------

-- Informational guard: no future exact-name grant row for either new tool
-- outside bot_production. Cannot see through bot_marketing's content.*
-- wildcard match at the permission-matcher level -- the hard p_bot_id checks
-- above and the gateway allowed() hard-code are the real control.
do $$
begin
  if exists (
    select 1 from mcp_internal.mcp_bot_permissions
     where permission_pattern in ('content.select_idea', 'content.approve_asset')
       and bot_id <> 'bot_production'
  ) then
    raise exception
      'Phase 9b: content.select_idea / content.approve_asset must not be granted outside bot_production';
  end if;
  perform mcp_internal.assert_cos_prohibitions();
  if not exists (
    select 1 from mcp_internal.mcp_bot_permissions
     where bot_id = 'bot_production' and permission_pattern = 'content.*'
  ) then
    raise exception 'Phase 9b: Production Manager content grant missing';
  end if;
end $$;

comment on function mcp_internal.approve_idea(text, text, text, uuid, uuid) is
  'Phase 9b Bot idea approve. bot_production only (hard-coded). Grant + client match. Never can_access_client. Does not generate a brief.';
comment on function public.mcp_approve_idea(text, text, text, uuid, uuid) is
  'Phase 9b public wrapper for mcp_internal.approve_idea. service_role only.';
comment on function mcp_internal.approve_asset(text, text, text, uuid, uuid, text, text) is
  'Phase 9b Bot asset decide. bot_production only (hard-coded). Same ledger as review_media_asset (client_media_assets + client_asset_reviews). Only decides a pending asset.';
comment on function public.mcp_approve_asset(text, text, text, uuid, uuid, text, text) is
  'Phase 9b public wrapper for mcp_internal.approve_asset. service_role only.';
comment on column client_asset_reviews.reviewed_by_bot is
  'Phase 9b: Bot attribution for a Bot-decided review row. Mutually exclusive with reviewed_by (human). Alex approval required before applying this migration to production.';

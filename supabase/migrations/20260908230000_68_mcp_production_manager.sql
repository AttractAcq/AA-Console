-- Phase 5 Production Manager v1: Bot content RPCs for Gate 5.
-- DO NOT APPLY TO PRODUCTION without Alex approval.
-- Additive only: mcp_internal ledger + RPCs + public wrappers.
-- No live token hashes. No permission-row inserts (bot_production already
-- has content.*). Does not replace enqueue_mcp_brief or human RPCs.

-- ---------------------------------------------------------------------------
-- Ledger for Bot content writes (revision / approval-request / repurpose).
-- Same revoke/force-RLS posture as mcp_brief_requests, in mcp_internal.
-- ---------------------------------------------------------------------------

create table mcp_internal.mcp_content_requests (
  bot_id text not null,
  execution_id text not null
    check (execution_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  request_id text not null
    check (request_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  tool text not null check (tool in (
    'content.request_revision',
    'content.request_approval',
    'content.create_repurpose_plan'
  )),
  client_id uuid not null references public.clients(id),
  idea_id uuid references public.client_ideas(id),
  brief_id uuid references public.client_briefs(id),
  asset_id uuid references public.client_media_assets(id),
  payload jsonb not null default '{}'::jsonb,
  result jsonb not null,
  created_at timestamptz not null default now(),
  primary key (bot_id, execution_id)
);
create index mcp_content_requests_client_idx
  on mcp_internal.mcp_content_requests (client_id, created_at desc);
alter table mcp_internal.mcp_content_requests enable row level security;
alter table mcp_internal.mcp_content_requests force row level security;
revoke all on mcp_internal.mcp_content_requests
  from public, anon, authenticated, service_role;

-- Seed check: Production Manager already has content.* from migration 65.
-- Do not insert duplicate exact-name grants; wildcard is authoritative.
do $$
begin
  if not exists (
    select 1 from mcp_internal.mcp_bot_permissions
     where bot_id = 'bot_production'
       and permission_pattern = 'content.*'
  ) then
    raise exception
      'Phase 5: bot_production must retain content.* for Production Manager tools';
  end if;
  perform mcp_internal.assert_cos_prohibitions();
end $$;

-- Catalog the new ledger in the Phase 4 RLS inventory.
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
    ('mcp_internal', 'mcp_bot_token_audit'),
    ('mcp_internal', 'mcp_content_requests')
  ) as t(nsp, rel)
  left join pg_class c
    on c.relname = t.rel
   and c.relnamespace = (select n.oid from pg_namespace n where n.nspname = t.nsp);
end;
$$;
revoke all on function mcp_internal.bot_touched_rls_status() from public, anon, authenticated;
grant execute on function mcp_internal.bot_touched_rls_status() to service_role;

create or replace function mcp_internal.require_mcp_ids(p_request_id text, p_execution_id text)
returns void
language plpgsql
stable
set search_path = mcp_internal
as $$
begin
  if p_request_id is null or p_request_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
     or p_execution_id is null or p_execution_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' then
    raise exception using message = 'invalid_request', errcode = 'P0001';
  end if;
end;
$$;
revoke all on function mcp_internal.require_mcp_ids(text, text) from public, anon, authenticated;
grant execute on function mcp_internal.require_mcp_ids(text, text) to service_role;

create or replace function mcp_internal.clip_text(p text, p_max integer default 8000)
returns text
language sql
immutable
as $$
  select case
    when p is null then null
    when char_length(p) <= p_max then p
    else left(p, p_max)
  end;
$$;
revoke all on function mcp_internal.clip_text(text, integer) from public, anon, authenticated;
grant execute on function mcp_internal.clip_text(text, integer) to service_role;

-- Shared resource resolution. Grant already checked. Never returns another
-- client's row: mismatch raises before the row is used.
create or replace function mcp_internal.resolve_content_target(
  p_client_id uuid,
  p_idea_id uuid,
  p_brief_id uuid,
  p_asset_id uuid
)
returns table (
  idea_id uuid,
  brief_id uuid,
  asset_id uuid,
  idea public.client_ideas,
  brief public.client_briefs,
  asset public.client_media_assets
)
language plpgsql
stable
security definer
set search_path = mcp_internal, public
as $$
declare
  v_idea client_ideas;
  v_brief client_briefs;
  v_asset client_media_assets;
begin
  perform mcp_internal.require_service_role();
  if p_idea_id is null and p_brief_id is null and p_asset_id is null then
    raise exception using message = 'invalid_request', errcode = 'P0001';
  end if;

  if p_asset_id is not null then
    select * into v_asset from client_media_assets where id = p_asset_id;
    if not found then
      raise exception using message = 'asset_not_found', errcode = 'P0001';
    end if;
    if v_asset.client_id <> p_client_id then
      raise exception using message = 'client_mismatch', errcode = 'P0001';
    end if;
  end if;

  if p_brief_id is not null then
    select * into v_brief from client_briefs where id = p_brief_id;
    if not found then
      raise exception using message = 'brief_not_found', errcode = 'P0001';
    end if;
    if v_brief.client_id <> p_client_id then
      raise exception using message = 'client_mismatch', errcode = 'P0001';
    end if;
  elsif v_asset.brief_id is not null then
    select * into v_brief from client_briefs where id = v_asset.brief_id;
  elsif p_idea_id is not null then
    select * into v_brief from client_briefs
      where source_idea_id = p_idea_id
        and client_id = p_client_id
        and repurpose_format is null
      order by created_at desc
      limit 1;
  end if;

  if p_idea_id is not null then
    select * into v_idea from client_ideas where id = p_idea_id;
    if not found then
      raise exception using message = 'idea_not_found', errcode = 'P0001';
    end if;
    if v_idea.client_id <> p_client_id then
      raise exception using message = 'client_mismatch', errcode = 'P0001';
    end if;
  elsif v_brief.source_idea_id is not null then
    select * into v_idea from client_ideas where id = v_brief.source_idea_id;
  end if;

  if v_brief.id is not null and v_brief.client_id <> p_client_id then
    raise exception using message = 'client_mismatch', errcode = 'P0001';
  end if;

  idea_id := v_idea.id;
  brief_id := v_brief.id;
  asset_id := v_asset.id;
  idea := v_idea;
  brief := v_brief;
  asset := v_asset;
  return next;
end;
$$;
revoke all on function mcp_internal.resolve_content_target(uuid, uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function mcp_internal.resolve_content_target(uuid, uuid, uuid, uuid) to service_role;

create or replace function mcp_internal.idea_json(p client_ideas, p_include_body boolean)
returns jsonb
language plpgsql
stable
set search_path = mcp_internal, public
as $$
declare
  r jsonb := to_jsonb(p);
  v jsonb;
begin
  v := jsonb_build_object(
    'id', r->>'id',
    'client_id', r->>'client_id',
    'title', r->>'title',
    'source', r->>'source',
    'status', r->>'status',
    'media_type', r->>'media_type',
    'content_territory', r->>'content_territory',
    'strategic_reason', mcp_internal.clip_text(r->>'strategic_reason'),
    'created_at', r->>'created_at',
    'updated_at', r->>'updated_at',
    'job_id', r->>'job_id',
    'proof_id', r->>'proof_id'
  );
  if p_include_body then
    v := v || jsonb_build_object(
      'body', mcp_internal.clip_text(r->>'body'),
      'body_truncated', r->>'body' is not null and char_length(r->>'body') > 8000,
      'source_question', mcp_internal.clip_text(r->>'source_question')
    );
  end if;
  return v;
end;
$$;
revoke all on function mcp_internal.idea_json(client_ideas, boolean)
  from public, anon, authenticated;
grant execute on function mcp_internal.idea_json(client_ideas, boolean) to service_role;

create or replace function mcp_internal.brief_json(p client_briefs)
returns jsonb
language plpgsql
stable
set search_path = mcp_internal, public
as $$
declare
  r jsonb := to_jsonb(p);
begin
  return jsonb_build_object(
    'id', r->>'id',
    'client_id', r->>'client_id',
    'source_idea_id', r->>'source_idea_id',
    'title', r->>'title',
    'body', mcp_internal.clip_text(r->>'body'),
    'body_truncated', r->>'body' is not null and char_length(r->>'body') > 8000,
    'media_type', r->>'media_type',
    'status', r->>'status',
    'brief_ref', r->>'brief_ref',
    'job_id', r->>'job_id',
    'hook', mcp_internal.clip_text(r->>'hook'),
    'premise', mcp_internal.clip_text(r->>'premise'),
    'argument', mcp_internal.clip_text(r->>'argument'),
    'proof', mcp_internal.clip_text(r->>'proof'),
    'proof_asset_id', r->>'proof_asset_id',
    'script', mcp_internal.clip_text(r->>'script'),
    'visual_direction', mcp_internal.clip_text(r->>'visual_direction'),
    'shot_requirements', mcp_internal.clip_text(r->>'shot_requirements'),
    'b_roll', mcp_internal.clip_text(r->>'b_roll'),
    'call_to_action', mcp_internal.clip_text(r->>'call_to_action'),
    'channel_intent', mcp_internal.clip_text(r->>'channel_intent'),
    'production_method', r->>'production_method',
    'derived_from_asset_id', r->>'derived_from_asset_id',
    'repurpose_format', r->>'repurpose_format',
    'created_at', r->>'created_at',
    'updated_at', r->>'updated_at'
  );
end;
$$;
revoke all on function mcp_internal.brief_json(client_briefs)
  from public, anon, authenticated;
grant execute on function mcp_internal.brief_json(client_briefs) to service_role;

-- Replay helper. Locks (bot, execution). Returns existing result or null.
create or replace function mcp_internal.take_content_request(
  p_bot_id text,
  p_execution_id text,
  p_tool text,
  p_client_id uuid,
  p_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = mcp_internal, public
as $$
declare
  v_row mcp_internal.mcp_content_requests;
begin
  perform mcp_internal.require_service_role();
  perform pg_advisory_xact_lock(hashtextextended(p_bot_id || ':' || p_execution_id, 0));
  select * into v_row
    from mcp_internal.mcp_content_requests
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
revoke all on function mcp_internal.take_content_request(text, text, text, uuid, jsonb)
  from public, anon, authenticated;
grant execute on function mcp_internal.take_content_request(text, text, text, uuid, jsonb)
  to service_role;

-- ---------------------------------------------------------------------------
-- Reads
-- ---------------------------------------------------------------------------

create or replace function mcp_internal.list_ideas(
  p_bot_id text, p_client_id uuid, p_limit integer default 25, p_status text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = mcp_internal, public
as $$
declare
  v_limit integer;
  v_ideas jsonb;
begin
  perform mcp_internal.require_bot_client_grant(p_bot_id, p_client_id);
  v_limit := least(greatest(coalesce(p_limit, 25), 1), 100);
  if p_status is not null and p_status not in ('draft', 'approved', 'rejected', 'briefed') then
    raise exception using message = 'invalid_request', errcode = 'P0001';
  end if;
  select coalesce(jsonb_agg(x.obj order by x.created_at desc), '[]'::jsonb)
    into v_ideas
    from (
      select mcp_internal.idea_json(i, false) as obj, i.created_at
        from client_ideas i
       where i.client_id = p_client_id
         and (p_status is null or i.status::text = p_status)
       order by i.created_at desc
       limit v_limit
    ) x;
  return jsonb_build_object(
    'client_id', p_client_id,
    'ideas', v_ideas,
    'count', jsonb_array_length(v_ideas)
  );
end;
$$;

create or replace function mcp_internal.get_idea(
  p_bot_id text, p_client_id uuid, p_idea_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = mcp_internal, public
as $$
declare
  v_idea client_ideas;
begin
  perform mcp_internal.require_bot_client_grant(p_bot_id, p_client_id);
  if p_idea_id is null then
    raise exception using message = 'invalid_request', errcode = 'P0001';
  end if;
  select * into v_idea from client_ideas where id = p_idea_id;
  if not found then
    raise exception using message = 'idea_not_found', errcode = 'P0001';
  end if;
  if v_idea.client_id <> p_client_id then
    raise exception using message = 'client_mismatch', errcode = 'P0001';
  end if;
  return mcp_internal.idea_json(v_idea, true);
end;
$$;

create or replace function mcp_internal.get_brief(
  p_bot_id text, p_client_id uuid, p_brief_id uuid default null, p_idea_id uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = mcp_internal, public
as $$
declare
  v record;
begin
  perform mcp_internal.require_bot_client_grant(p_bot_id, p_client_id);
  if p_brief_id is null and p_idea_id is null then
    raise exception using message = 'invalid_request', errcode = 'P0001';
  end if;
  select * into v from mcp_internal.resolve_content_target(p_client_id, p_idea_id, p_brief_id, null);
  if v.brief_id is null then
    raise exception using message = 'brief_not_found', errcode = 'P0001';
  end if;
  return mcp_internal.brief_json(v.brief);
end;
$$;

create or replace function mcp_internal.get_production_status(
  p_bot_id text, p_client_id uuid,
  p_idea_id uuid default null, p_brief_id uuid default null, p_asset_id uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = mcp_internal, public
as $$
declare
  v record;
  v_assets jsonb := '[]'::jsonb;
  v_jobs jsonb := '[]'::jsonb;
  v_actions jsonb := '[]'::jsonb;
  v_generations jsonb := '[]'::jsonb;
  v_dispatches jsonb := '[]'::jsonb;
  v_assignments jsonb := '[]'::jsonb;
  v_approved uuid;
  v_pending integer := 0;
  v_rejected integer := 0;
  v_revision boolean := false;
  v_blocked text;
  v_ready boolean := false;
begin
  perform mcp_internal.require_bot_client_grant(p_bot_id, p_client_id);
  select * into v from mcp_internal.resolve_content_target(p_client_id, p_idea_id, p_brief_id, p_asset_id);

  if v.brief_id is not null then
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', a.id, 'brief_id', a.brief_id, 'ref_number', a.ref_number,
      'media_type', a.media_type, 'title', a.title,
      'review_status', a.review_status, 'created_at', a.created_at
    ) order by a.created_at desc), '[]'::jsonb),
           count(*) filter (where a.review_status = 'pending'),
           count(*) filter (where a.review_status = 'rejected'),
           (array_agg(a.id) filter (where a.review_status = 'approved'))[1]
      into v_assets, v_pending, v_rejected, v_approved
      from client_media_assets a
     where a.client_id = p_client_id and a.brief_id = v.brief_id;

    select coalesce(jsonb_agg(jsonb_build_object(
      'id', j.id, 'agent_key', j.agent_key, 'status', j.status,
      'error', j.error, 'created_at', j.created_at, 'completed_at', j.completed_at
    ) order by j.created_at desc), '[]'::jsonb)
      into v_jobs
      from agent_jobs j
     where j.client_id = p_client_id
       and (
         j.id = (v.brief).job_id
         or (j.input_table = 'client_ideas' and j.input_id = v.idea_id)
         or (j.input_table = 'client_media_assets' and j.input_id in (
           select id from client_media_assets where brief_id = v.brief_id
         ))
       );

    select coalesce(jsonb_agg(jsonb_build_object(
      'id', ja.id, 'member_id', ja.member_id, 'title', ja.title,
      'due_date', ja.due_date, 'completed_at', ja.completed_at
    ) order by ja.created_at desc), '[]'::jsonb)
      into v_assignments
      from job_assignments ja
     where ja.client_id = p_client_id and ja.brief_id = v.brief_id;

    if to_regclass('public.creative_generations') is not null then
      execute $q$
        select coalesce(jsonb_agg(jsonb_build_object(
          'id', g.id, 'stage', g.stage, 'media_type', g.media_type,
          'asset_id', g.asset_id, 'error', g.error, 'created_at', g.created_at
        ) order by g.created_at desc), '[]'::jsonb)
          from creative_generations g
         where g.client_id = $1 and g.brief_id = $2
      $q$ into v_generations using p_client_id, v.brief_id;
    end if;

    if to_regclass('public.brief_dispatches') is not null then
      execute $q$
        select coalesce(jsonb_agg(jsonb_build_object(
          'id', d.id, 'member_id', d.member_id, 'email_status', d.email_status,
          'created_at', d.created_at
        ) order by d.created_at desc), '[]'::jsonb)
          from brief_dispatches d
         where d.client_id = $1 and d.brief_id = $2
      $q$ into v_dispatches using p_client_id, v.brief_id;
    end if;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'tool', r.tool, 'created_at', r.created_at,
    'brief_id', r.brief_id, 'asset_id', r.asset_id
  ) order by r.created_at desc), '[]'::jsonb),
         exists (
           select 1 from mcp_internal.mcp_content_requests x
            where x.client_id = p_client_id
              and x.tool = 'content.request_revision'
              and (x.brief_id = v.brief_id or (v.brief_id is null and x.idea_id = v.idea_id))
         )
    into v_actions, v_revision
    from mcp_internal.mcp_content_requests r
   where r.client_id = p_client_id
     and (
       (v.brief_id is not null and r.brief_id = v.brief_id)
       or (v.idea_id is not null and r.idea_id = v.idea_id)
       or (v.asset_id is not null and r.asset_id = v.asset_id)
     );

  if v.idea_id is not null and (v.idea).status is distinct from 'briefed' and v.brief_id is null then
    v_blocked := 'idea_not_briefed';
  elsif v.brief_id is null then
    v_blocked := 'brief_missing';
  elsif v_revision and (v.brief).status = 'draft' then
    v_blocked := 'brief_needs_revision';
  elsif v_rejected > 0 and v_approved is null then
    v_blocked := 'asset_rejected';
  elsif v_pending > 0 then
    v_blocked := 'awaiting_asset_approval';
  elsif v_approved is null then
    v_blocked := 'awaiting_production';
  else
    v_ready := true;
    v_blocked := null;
  end if;

  return jsonb_build_object(
    'client_id', p_client_id,
    'idea', case when v.idea_id is null then null else mcp_internal.idea_json(v.idea, false) end,
    'brief', case when v.brief_id is null then null else mcp_internal.brief_json(v.brief) end,
    'assets', v_assets,
    'jobs', v_jobs,
    'assignments', v_assignments,
    'generations', v_generations,
    'dispatches', v_dispatches,
    'actions', v_actions,
    'handoff', jsonb_build_object(
      'ready_for_distribution', v_ready,
      'blocked_on', v_blocked,
      'approved_asset_id', v_approved,
      'next', case
        when v_ready then
          'Ready for distribution. content.queue_distribution remains a Distribution Manager stub.'
        when v_blocked = 'idea_not_briefed' then 'content.generate_brief'
        when v_blocked = 'brief_missing' then 'content.generate_brief'
        when v_blocked = 'brief_needs_revision' then 'Inspect the revised brief, then content.request_approval'
        when v_blocked = 'asset_rejected' then 'content.request_revision'
        when v_blocked = 'awaiting_asset_approval' then
          'Human Console review (review_media_asset). Bot cannot approve.'
        else 'Await production (Approve & Build in Console, or an in-flight creative_build job).'
      end
    )
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Writes
-- ---------------------------------------------------------------------------

create or replace function mcp_internal.request_revision(
  p_bot_id text, p_request_id text, p_execution_id text, p_client_id uuid,
  p_idea_id uuid, p_brief_id uuid, p_asset_id uuid, p_summary text
)
returns jsonb
language plpgsql
security definer
set search_path = mcp_internal, public
as $$
declare
  v record;
  v_payload jsonb;
  v_existing jsonb;
  v_result jsonb;
  v_brief client_briefs;
  v_asset client_media_assets;
begin
  perform mcp_internal.require_bot_client_grant(p_bot_id, p_client_id);
  perform mcp_internal.require_mcp_ids(p_request_id, p_execution_id);
  if p_summary is null or length(btrim(p_summary)) < 1 or length(p_summary) > 4000 then
    raise exception using message = 'invalid_request', errcode = 'P0001';
  end if;
  v_payload := jsonb_strip_nulls(jsonb_build_object(
    'idea_id', p_idea_id, 'brief_id', p_brief_id, 'asset_id', p_asset_id,
    'summary', p_summary
  ));
  v_existing := mcp_internal.take_content_request(
    p_bot_id, p_execution_id, 'content.request_revision', p_client_id, v_payload);
  if v_existing is not null then
    return v_existing;
  end if;

  select * into v from mcp_internal.resolve_content_target(p_client_id, p_idea_id, p_brief_id, p_asset_id);
  v_brief := v.brief;
  v_asset := v.asset;

  if v_asset.id is not null then
    if v_asset.review_status = 'approved' then
      raise exception using message = 'invalid_asset_status', errcode = 'P0001';
    end if;
    update client_media_assets
       set review_status = 'pending'
     where id = v_asset.id;
  end if;

  if v_brief.id is null then
    raise exception using message = 'brief_not_found', errcode = 'P0001';
  end if;
  if v_brief.status = 'complete' then
    raise exception using message = 'invalid_brief_status', errcode = 'P0001';
  end if;
  update client_briefs set status = 'draft' where id = v_brief.id;

  v_result := jsonb_build_object(
    'client_id', p_client_id,
    'idea_id', v.idea_id,
    'brief_id', v.brief_id,
    'asset_id', v.asset_id,
    'brief_status', 'draft',
    'reason', p_summary,
    'replayed', false
  );
  insert into mcp_internal.mcp_content_requests (
    bot_id, execution_id, request_id, tool, client_id,
    idea_id, brief_id, asset_id, payload, result
  ) values (
    p_bot_id, p_execution_id, p_request_id, 'content.request_revision', p_client_id,
    v.idea_id, v.brief_id, v.asset_id, v_payload, v_result
  );
  return v_result;
end;
$$;

create or replace function mcp_internal.request_approval(
  p_bot_id text, p_request_id text, p_execution_id text, p_client_id uuid,
  p_idea_id uuid, p_brief_id uuid, p_asset_id uuid, p_summary text default null
)
returns jsonb
language plpgsql
security definer
set search_path = mcp_internal, public
as $$
declare
  v record;
  v_payload jsonb;
  v_existing jsonb;
  v_result jsonb;
  v_brief client_briefs;
  v_asset client_media_assets;
  v_queue text;
  v_brief_status text;
begin
  perform mcp_internal.require_bot_client_grant(p_bot_id, p_client_id);
  perform mcp_internal.require_mcp_ids(p_request_id, p_execution_id);
  if p_summary is not null and length(p_summary) > 4000 then
    raise exception using message = 'invalid_request', errcode = 'P0001';
  end if;
  v_payload := jsonb_strip_nulls(jsonb_build_object(
    'idea_id', p_idea_id, 'brief_id', p_brief_id, 'asset_id', p_asset_id,
    'summary', p_summary
  ));
  v_existing := mcp_internal.take_content_request(
    p_bot_id, p_execution_id, 'content.request_approval', p_client_id, v_payload);
  if v_existing is not null then
    return v_existing;
  end if;

  select * into v from mcp_internal.resolve_content_target(p_client_id, p_idea_id, p_brief_id, p_asset_id);
  v_brief := v.brief;
  v_asset := v.asset;

  if v_asset.id is not null then
    if v_asset.review_status = 'rejected' then
      raise exception using message = 'invalid_asset_status', errcode = 'P0001';
    end if;
    v_queue := case
      when v_asset.review_status = 'approved' then 'already_approved'
      else 'console_approvals'
    end;
    v_brief_status := v_brief.status;
  elsif v_brief.id is not null then
    if v_brief.status = 'rejected' then
      raise exception using message = 'invalid_brief_status', errcode = 'P0001';
    end if;
    if v_brief.status = 'draft' then
      update client_briefs set status = 'approved' where id = v_brief.id;
      v_brief_status := 'approved';
    else
      v_brief_status := v_brief.status;
    end if;
    v_queue := 'brief_ready_for_build';
  else
    raise exception using message = 'brief_not_found', errcode = 'P0001';
  end if;

  v_result := jsonb_build_object(
    'client_id', p_client_id,
    'idea_id', v.idea_id,
    'brief_id', v.brief_id,
    'asset_id', v.asset_id,
    'brief_status', v_brief_status,
    'queue', v_queue,
    'message', case v_queue
      when 'console_approvals' then
        'Asset is in the Console approvals queue. Human review_media_asset required. Bot cannot approve.'
      when 'already_approved' then
        'Asset is already approved. content.create_repurpose_plan is available.'
      else
        'Brief marked approved for human Approve & Build. Bot did not produce or approve an asset.'
    end,
    'replayed', false
  );
  insert into mcp_internal.mcp_content_requests (
    bot_id, execution_id, request_id, tool, client_id,
    idea_id, brief_id, asset_id, payload, result
  ) values (
    p_bot_id, p_execution_id, p_request_id, 'content.request_approval', p_client_id,
    v.idea_id, v.brief_id, v.asset_id, v_payload, v_result
  );
  return v_result;
end;
$$;

create or replace function mcp_internal.create_repurpose_plan(
  p_bot_id text, p_request_id text, p_execution_id text,
  p_client_id uuid, p_asset_id uuid, p_formats text[]
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
  v_job uuid;
  v_result jsonb;
  v_meta jsonb;
  v_allowed text[] := array[
    'reel', 'short', 'carousel', 'quote_graphic',
    'text_post', 'email', 'ad_variation', 'story_clips'
  ];
begin
  perform mcp_internal.require_bot_client_grant(p_bot_id, p_client_id);
  perform mcp_internal.require_mcp_ids(p_request_id, p_execution_id);
  if p_asset_id is null
     or p_formats is null
     or array_length(p_formats, 1) is null
     or array_length(p_formats, 1) > 6 then
    raise exception using message = 'invalid_formats', errcode = 'P0001';
  end if;
  if exists (
    select 1 from unnest(p_formats) f(val)
     where f.val is null or not (f.val = any (v_allowed))
  ) then
    raise exception using message = 'invalid_formats', errcode = 'P0001';
  end if;

  v_payload := jsonb_build_object('asset_id', p_asset_id, 'formats', to_jsonb(p_formats));
  v_existing := mcp_internal.take_content_request(
    p_bot_id, p_execution_id, 'content.create_repurpose_plan', p_client_id, v_payload);
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
  if v_asset.review_status <> 'approved' then
    raise exception using message = 'invalid_asset_status', errcode = 'P0001';
  end if;

  v_meta := jsonb_build_object(
    'source', 'aa-mcp-gateway', 'bot_id', p_bot_id,
    'request_id', p_request_id, 'execution_id', p_execution_id,
    'client_id', p_client_id, 'asset_id', p_asset_id,
    'formats', to_jsonb(p_formats)
  );
  begin
    v_job := enqueue_agent_job_internal(
      'repurpose', p_client_id, 'client_media_assets', p_asset_id,
      null, v_meta, 'Queued by MCP gateway');
  exception
    when raise_exception then
      raise exception using message = 'repurpose_agent_unavailable', errcode = 'P0001';
    when others then
      raise exception using message = 'queue_failure', errcode = 'P0001';
  end;

  v_result := jsonb_build_object(
    'job_id', v_job,
    'client_id', p_client_id,
    'asset_id', p_asset_id,
    'formats', to_jsonb(p_formats),
    'replayed', false
  );
  insert into mcp_internal.mcp_content_requests (
    bot_id, execution_id, request_id, tool, client_id,
    asset_id, payload, result
  ) values (
    p_bot_id, p_execution_id, p_request_id, 'content.create_repurpose_plan', p_client_id,
    p_asset_id, v_payload, v_result
  );
  return v_result;
end;
$$;

-- ---------------------------------------------------------------------------
-- public wrappers — same posture as enqueue_mcp_brief / mcp_list_bot_clients
-- ---------------------------------------------------------------------------

create or replace function public.mcp_list_ideas(
  p_bot_id text, p_client_id uuid, p_limit integer default 25, p_status text default null
)
returns jsonb language plpgsql stable security definer set search_path = mcp_internal, public as $$
begin
  perform mcp_internal.require_service_role();
  return mcp_internal.list_ideas(p_bot_id, p_client_id, p_limit, p_status);
end;
$$;

create or replace function public.mcp_get_idea(
  p_bot_id text, p_client_id uuid, p_idea_id uuid
)
returns jsonb language plpgsql stable security definer set search_path = mcp_internal, public as $$
begin
  perform mcp_internal.require_service_role();
  return mcp_internal.get_idea(p_bot_id, p_client_id, p_idea_id);
end;
$$;

create or replace function public.mcp_get_brief(
  p_bot_id text, p_client_id uuid, p_brief_id uuid default null, p_idea_id uuid default null
)
returns jsonb language plpgsql stable security definer set search_path = mcp_internal, public as $$
begin
  perform mcp_internal.require_service_role();
  return mcp_internal.get_brief(p_bot_id, p_client_id, p_brief_id, p_idea_id);
end;
$$;

create or replace function public.mcp_get_production_status(
  p_bot_id text, p_client_id uuid,
  p_idea_id uuid default null, p_brief_id uuid default null, p_asset_id uuid default null
)
returns jsonb language plpgsql stable security definer set search_path = mcp_internal, public as $$
begin
  perform mcp_internal.require_service_role();
  return mcp_internal.get_production_status(p_bot_id, p_client_id, p_idea_id, p_brief_id, p_asset_id);
end;
$$;

create or replace function public.mcp_request_revision(
  p_bot_id text, p_request_id text, p_execution_id text, p_client_id uuid,
  p_idea_id uuid default null, p_brief_id uuid default null, p_asset_id uuid default null,
  p_summary text default null
)
returns jsonb language plpgsql security definer set search_path = mcp_internal, public as $$
begin
  perform mcp_internal.require_service_role();
  return mcp_internal.request_revision(
    p_bot_id, p_request_id, p_execution_id, p_client_id,
    p_idea_id, p_brief_id, p_asset_id, p_summary);
end;
$$;

create or replace function public.mcp_request_approval(
  p_bot_id text, p_request_id text, p_execution_id text, p_client_id uuid,
  p_idea_id uuid default null, p_brief_id uuid default null, p_asset_id uuid default null,
  p_summary text default null
)
returns jsonb language plpgsql security definer set search_path = mcp_internal, public as $$
begin
  perform mcp_internal.require_service_role();
  return mcp_internal.request_approval(
    p_bot_id, p_request_id, p_execution_id, p_client_id,
    p_idea_id, p_brief_id, p_asset_id, p_summary);
end;
$$;

create or replace function public.mcp_create_repurpose_plan(
  p_bot_id text, p_request_id text, p_execution_id text,
  p_client_id uuid, p_asset_id uuid, p_formats text[]
)
returns jsonb language plpgsql security definer set search_path = mcp_internal, public as $$
begin
  perform mcp_internal.require_service_role();
  return mcp_internal.create_repurpose_plan(
    p_bot_id, p_request_id, p_execution_id, p_client_id, p_asset_id, p_formats);
end;
$$;

do $$
declare
  r record;
begin
  for r in
    select p.oid::regprocedure as sig
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in (
         'mcp_list_ideas', 'mcp_get_idea', 'mcp_get_brief',
         'mcp_get_production_status', 'mcp_request_revision',
         'mcp_request_approval', 'mcp_create_repurpose_plan'
       )
  loop
    execute format('revoke all on function %s from public, anon, authenticated', r.sig);
    execute format('grant execute on function %s to service_role', r.sig);
  end loop;
  for r in
    select p.oid::regprocedure as sig
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'mcp_internal'
       and p.proname in (
         'list_ideas', 'get_idea', 'get_brief', 'get_production_status',
         'request_revision', 'request_approval', 'create_repurpose_plan'
       )
  loop
    execute format('revoke all on function %s from public, anon, authenticated', r.sig);
    execute format('grant execute on function %s to service_role', r.sig);
  end loop;
end $$;

comment on table mcp_internal.mcp_content_requests is
  'Phase 5 Bot content write ledger. service_role SECURITY DEFINER RPCs only. Do not apply to production without Alex approval.';
comment on function public.mcp_list_ideas(text, uuid, integer, text) is
  'Bot list of client_ideas. mcp_bot_clients scoped. service_role only.';
comment on function public.mcp_create_repurpose_plan(text, text, text, uuid, uuid, text[]) is
  'Bot repurpose enqueue. Approved asset + mcp_bot_clients. Never can_access_client.';

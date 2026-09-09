-- Phase 10: Distribution Manager (approved asset -> schedule -> record
-- publication -> read). Alex CLEAR 2026-09-09: bot_distribution only. Sec
-- design note required before merge/cutover:
-- aa-mcp-gateway/docs/phase-10-distribution-manager.md.
-- DO NOT APPLY TO PRODUCTION without Alex approval. Additive only.
--
-- Realizes content.queue_distribution as a Bot-safe wrapper around the
-- existing schedule_asset() / scheduled_posts insert (migration 06), and adds
-- one minimal companion write, content.record_publication, to mark a
-- scheduled row published/failed (Alex CLEAR: no live Meta/etc. publish yet,
-- record_publication on scheduled_posts is the Gate 10 "publish"). Both RPCs
-- use the same require_active_bot + require_bot_client_grant posture as every
-- Phase 5/9b Bot content RPC, plus a hard-coded p_bot_id <> 'bot_distribution'
-- check (bot_forbidden) -- the same belt-and-suspenders pattern Phase 9b used
-- for bot_production, needed here because bot_production's pre-existing
-- content.* wildcard also matches these two exact names. No permission-row
-- insert for queue_distribution (bot_distribution already has it, migration
-- 65); one additive permission row for the new record_publication name only.
-- workflow.record_decision remains hard-denied in gateway code. No SQL from
-- Bots (unchanged: gateway has no Postgres client). Never can_access_client.

-- ---------------------------------------------------------------------------
-- Ledger: allow the two tool names on the existing Phase 5 write ledger, and
-- add a nullable schedule_id so distribution writes are traceable to their
-- scheduled_posts row without a second ledger table.
-- ---------------------------------------------------------------------------

alter table mcp_internal.mcp_content_requests
  add column schedule_id uuid references public.scheduled_posts(id);

do $$
declare
  v_conname text;
begin
  -- Match by constrained column, not rendered definition text (Postgres
  -- prints `tool in (...)` back as `tool = ANY (ARRAY[...])`).
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
    'content.record_publication'
  ));

-- ---------------------------------------------------------------------------
-- scheduled_posts: additive columns for Bot-safe scheduling/publication.
-- Mirrors the Phase 9b reviewed_by_bot pattern -- one column per attribution
-- source, mutually exclusive with the human column, never a second table.
-- ---------------------------------------------------------------------------

alter table scheduled_posts
  add column created_by_bot text references mcp_internal.mcp_bots(bot_id);
alter table scheduled_posts
  add constraint sp_single_creator_source
  check (created_by is null or created_by_bot is null);
create index sp_created_by_bot_idx on scheduled_posts (created_by_bot)
  where created_by_bot is not null;

alter table scheduled_posts
  add column publication_status text not null default 'scheduled'
    check (publication_status in ('scheduled', 'published', 'failed'));
alter table scheduled_posts add column external_id text;
alter table scheduled_posts add column failure_reason text;
alter table scheduled_posts
  add column published_by_bot text references mcp_internal.mcp_bots(bot_id);
create index sp_published_by_bot_idx on scheduled_posts (published_by_bot)
  where published_by_bot is not null;

-- ---------------------------------------------------------------------------
-- Schedule: content.queue_distribution. Bot-safe wrapper around
-- schedule_asset()'s contract (approved-only) but writes scheduled_posts
-- directly under require_active_bot/require_bot_client_grant instead of
-- can_access_client, so it can run for a Bot identity. Does not replace or
-- call schedule_asset() (that stays the human/authenticated Console path).
-- ---------------------------------------------------------------------------

create or replace function mcp_internal.queue_distribution(
  p_bot_id text, p_request_id text, p_execution_id text, p_client_id uuid,
  p_asset_id uuid, p_scheduled_for date, p_channel text default 'organic'
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
  v_schedule_id uuid;
begin
  -- Sec Phase 5 posture: active bot + mcp_bot_clients grant. Never can_access_client.
  perform mcp_internal.require_active_bot(p_bot_id);
  perform mcp_internal.require_bot_client_grant(p_bot_id, p_client_id);
  -- Phase 10 Alex CLEAR: distribution schedule write is bot_distribution only.
  -- Hard-coded, not expressed as a permission row (bot_production keeps
  -- content.* for its other real content tools and already matches this name).
  if p_bot_id <> 'bot_distribution' then
    raise exception using message = 'bot_forbidden', errcode = 'P0001';
  end if;
  perform mcp_internal.require_mcp_ids(p_request_id, p_execution_id);
  if p_scheduled_for is null then
    raise exception using message = 'invalid_request', errcode = 'P0001';
  end if;
  if p_channel is null or p_channel not in ('organic', 'paid') then
    raise exception using message = 'invalid_request', errcode = 'P0001';
  end if;

  v_payload := jsonb_build_object(
    'asset_id', p_asset_id, 'scheduled_for', p_scheduled_for, 'channel', p_channel);
  v_existing := mcp_internal.take_content_request(
    p_bot_id, p_execution_id, 'content.queue_distribution', p_client_id, v_payload);
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

  insert into scheduled_posts (asset_id, scheduled_for, channel, created_by_bot)
  values (p_asset_id, p_scheduled_for, p_channel::post_channel, p_bot_id)
  returning id into v_schedule_id;

  v_result := jsonb_build_object(
    'client_id', p_client_id,
    'asset_id', p_asset_id,
    'schedule_id', v_schedule_id,
    'scheduled_for', p_scheduled_for,
    'channel', p_channel,
    'publication_status', 'scheduled',
    'created_by_bot', p_bot_id,
    'replayed', false
  );
  insert into mcp_internal.mcp_content_requests (
    bot_id, execution_id, request_id, tool, client_id, asset_id, schedule_id, payload, result
  ) values (
    p_bot_id, p_execution_id, p_request_id, 'content.queue_distribution', p_client_id,
    p_asset_id, v_schedule_id, v_payload, v_result
  );
  return v_result;
end;
$$;
revoke all on function mcp_internal.queue_distribution(text, text, text, uuid, uuid, date, text)
  from public, anon, authenticated;
grant execute on function mcp_internal.queue_distribution(text, text, text, uuid, uuid, date, text)
  to service_role;

create or replace function public.mcp_queue_distribution(
  p_bot_id text, p_request_id text, p_execution_id text, p_client_id uuid,
  p_asset_id uuid, p_scheduled_for date, p_channel text default 'organic'
)
returns jsonb language plpgsql security definer set search_path = mcp_internal, public as $$
begin
  perform mcp_internal.require_service_role();
  return mcp_internal.queue_distribution(
    p_bot_id, p_request_id, p_execution_id, p_client_id, p_asset_id, p_scheduled_for, p_channel);
end;
$$;
revoke all on function public.mcp_queue_distribution(text, text, text, uuid, uuid, date, text)
  from public, anon, authenticated;
grant execute on function public.mcp_queue_distribution(text, text, text, uuid, uuid, date, text)
  to service_role;

-- ---------------------------------------------------------------------------
-- Record publication: content.record_publication. Minimal companion tool
-- (Alex CLEAR #1/#2): until live Meta/etc. publish exists, this is the
-- explicit AA record path for Gate 10 "publish". Only decides a currently
-- 'scheduled' row (no re-decide), same asymmetry as Phase 9b approve_asset --
-- there is no separate human path for this row today, so no override case.
-- ---------------------------------------------------------------------------

create or replace function mcp_internal.record_publication(
  p_bot_id text, p_request_id text, p_execution_id text, p_client_id uuid,
  p_schedule_id uuid, p_status text, p_external_id text default null, p_failure_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = mcp_internal, public
as $$
declare
  v_row scheduled_posts;
  v_payload jsonb;
  v_existing jsonb;
  v_result jsonb;
begin
  -- Sec Phase 5 posture: active bot + mcp_bot_clients grant. Never can_access_client.
  perform mcp_internal.require_active_bot(p_bot_id);
  perform mcp_internal.require_bot_client_grant(p_bot_id, p_client_id);
  -- Phase 10 Alex CLEAR: publication record is bot_distribution only. Hard-coded,
  -- same rationale as queue_distribution above.
  if p_bot_id <> 'bot_distribution' then
    raise exception using message = 'bot_forbidden', errcode = 'P0001';
  end if;
  perform mcp_internal.require_mcp_ids(p_request_id, p_execution_id);
  if p_status is null or p_status not in ('published', 'failed') then
    raise exception using message = 'invalid_request', errcode = 'P0001';
  end if;
  if p_external_id is not null and length(p_external_id) > 200 then
    raise exception using message = 'invalid_request', errcode = 'P0001';
  end if;
  if p_failure_reason is not null and length(p_failure_reason) > 4000 then
    raise exception using message = 'invalid_request', errcode = 'P0001';
  end if;

  v_payload := jsonb_strip_nulls(jsonb_build_object(
    'schedule_id', p_schedule_id, 'status', p_status,
    'external_id', p_external_id, 'failure_reason', p_failure_reason));
  v_existing := mcp_internal.take_content_request(
    p_bot_id, p_execution_id, 'content.record_publication', p_client_id, v_payload);
  if v_existing is not null then
    return v_existing;
  end if;

  select * into v_row from scheduled_posts where id = p_schedule_id for update;
  if not found then
    raise exception using message = 'schedule_not_found', errcode = 'P0001';
  end if;
  if v_row.client_id is distinct from p_client_id then
    raise exception using message = 'client_mismatch', errcode = 'P0001';
  end if;
  if v_row.publication_status <> 'scheduled' then
    raise exception using message = 'invalid_schedule_status', errcode = 'P0001';
  end if;

  update scheduled_posts
     set publication_status = p_status,
         external_id = p_external_id,
         failure_reason = p_failure_reason,
         published_by_bot = p_bot_id,
         published_at = case when p_status = 'published' then now() else published_at end
   where id = p_schedule_id;

  v_result := jsonb_build_object(
    'client_id', p_client_id,
    'schedule_id', p_schedule_id,
    'asset_id', v_row.asset_id,
    'publication_status', p_status,
    'external_id', p_external_id,
    'published_by_bot', p_bot_id,
    'replayed', false
  );
  insert into mcp_internal.mcp_content_requests (
    bot_id, execution_id, request_id, tool, client_id, asset_id, schedule_id, payload, result
  ) values (
    p_bot_id, p_execution_id, p_request_id, 'content.record_publication', p_client_id,
    v_row.asset_id, p_schedule_id, v_payload, v_result
  );
  return v_result;
end;
$$;
revoke all on function mcp_internal.record_publication(text, text, text, uuid, uuid, text, text, text)
  from public, anon, authenticated;
grant execute on function mcp_internal.record_publication(text, text, text, uuid, uuid, text, text, text)
  to service_role;

create or replace function public.mcp_record_publication(
  p_bot_id text, p_request_id text, p_execution_id text, p_client_id uuid,
  p_schedule_id uuid, p_status text, p_external_id text default null, p_failure_reason text default null
)
returns jsonb language plpgsql security definer set search_path = mcp_internal, public as $$
begin
  perform mcp_internal.require_service_role();
  return mcp_internal.record_publication(
    p_bot_id, p_request_id, p_execution_id, p_client_id, p_schedule_id,
    p_status, p_external_id, p_failure_reason);
end;
$$;
revoke all on function public.mcp_record_publication(text, text, text, uuid, uuid, text, text, text)
  from public, anon, authenticated;
grant execute on function public.mcp_record_publication(text, text, text, uuid, uuid, text, text, text)
  to service_role;

-- ---------------------------------------------------------------------------
-- Read: extend the existing Phase 5 get_production_status RPC (already
-- seeded to bot_distribution) with a `distribution` field, rather than invent
-- a new read tool -- Alex CLEAR #1's "prefer existing registry names" applies
-- to reads too. Purely additive JSON; no change to any existing key.
-- ---------------------------------------------------------------------------

-- Based on migration 70's version (Phase 6 added `approvals`/durable-wait
-- fields and changed the brief/asset-only blocking logic) -- NOT migration
-- 68's -- so this additive change does not silently regress Phase 6. Only
-- `v_distribution`/`distribution` and the `next` message wording are new.
create or replace function mcp_internal.get_production_status(
  p_bot_id text, p_client_id uuid,
  p_idea_id uuid default null, p_brief_id uuid default null, p_asset_id uuid default null
)
returns jsonb
language plpgsql
volatile
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
  v_distribution jsonb := '[]'::jsonb;
  v_approved uuid;
  v_pending integer := 0;
  v_rejected integer := 0;
  v_revision boolean := false;
  v_blocked text;
  v_ready boolean := false;
  v_approvals jsonb := '[]'::jsonb;
  v_request record;
  v_wait jsonb;
  v_wait_blocked boolean := false;
begin
  -- Sec Phase 5: active bot + mcp_bot_clients grant. Never can_access_client.
  perform mcp_internal.require_active_bot(p_bot_id);
  perform mcp_internal.require_bot_client_grant(p_bot_id, p_client_id);
  select * into v from mcp_internal.resolve_content_target(p_client_id, p_idea_id, p_brief_id, p_asset_id);

  if v.brief_id is not null or v.asset_id is not null then
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
     where a.client_id = p_client_id
       and ((v.asset_id is not null and a.id = v.asset_id)
         or (v.asset_id is null and a.brief_id = v.brief_id));

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

  -- Phase 10: distribution schedule/publication status for the resolved
  -- asset, or for every asset on the resolved brief when no asset was given.
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', s.id, 'asset_id', s.asset_id, 'scheduled_for', s.scheduled_for,
    'channel', s.channel, 'publication_status', s.publication_status,
    'external_id', s.external_id, 'failure_reason', s.failure_reason,
    'published_at', s.published_at, 'created_by_bot', s.created_by_bot,
    'published_by_bot', s.published_by_bot
  ) order by s.created_at desc), '[]'::jsonb)
    into v_distribution
    from scheduled_posts s
   where s.client_id = p_client_id
     and (
       (v.asset_id is not null and s.asset_id = v.asset_id)
       or (v.asset_id is null and v.brief_id is not null and s.asset_id in (
         select id from client_media_assets where brief_id = v.brief_id
       ))
     );

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
  elsif v.brief_id is null and v.asset_id is null then
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

  for v_request in
    select r.execution_id from mcp_internal.mcp_content_requests r
      where r.bot_id = p_bot_id and r.client_id = p_client_id
        and r.tool = 'content.request_approval'
        and ((v.asset_id is not null and (r.asset_id = v.asset_id or
              (r.asset_id is null and r.brief_id = v.brief_id)))
          or (v.asset_id is null and r.brief_id = v.brief_id))
      order by r.created_at desc, r.execution_id
  loop
    v_wait := mcp_internal.get_approval(p_bot_id, p_client_id, v_request.execution_id);
    -- All matching waits gate readiness; only the displayed history is capped.
    -- No implicit supersession: newer requests cannot resolve an older wait.
    v_wait_blocked := v_wait_blocked or coalesce(
      v_wait->>'state' not in ('approved', 'resumed'), true);
    if jsonb_array_length(v_approvals) < 50 then
      v_approvals := v_approvals || jsonb_build_array(v_wait);
    end if;
  end loop;
  if v_ready and v_wait_blocked then
    v_ready := false;
    v_blocked := 'awaiting_asset_approval';
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
    'distribution', v_distribution,
    'actions', v_actions,
    'approvals', v_approvals,
    'handoff', jsonb_build_object(
      'ready_for_distribution', v_ready,
      'blocked_on', v_blocked,
      'approved_asset_id', v_approved,
      'next', case
        when v_ready then 'Ready for distribution. content.queue_distribution (bot_distribution).'
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
-- Preserve existing grants (definition replaced above; ACL untouched by
-- create or replace, but re-assert for a clean diff / defense in depth).
revoke all on function mcp_internal.get_production_status(text, uuid, uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function mcp_internal.get_production_status(text, uuid, uuid, uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- Permission seed: content.queue_distribution already granted to
-- bot_distribution (migration 65). content.record_publication is new.
-- ---------------------------------------------------------------------------

insert into mcp_internal.mcp_bot_permissions (bot_id, permission_pattern, granted_by)
select 'bot_distribution', 'content.record_publication', 'alex-locked:phase-10'
where not exists (
  select 1 from mcp_internal.mcp_bot_permissions
   where bot_id = 'bot_distribution' and permission_pattern = 'content.record_publication'
);

-- ---------------------------------------------------------------------------
-- Catalog + guard assertions.
-- ---------------------------------------------------------------------------

do $$
begin
  -- Informational guard: no future exact-name grant row for either new tool
  -- outside bot_distribution. Cannot see through bot_production's content.*
  -- wildcard match -- the hard p_bot_id checks above and the gateway
  -- allowed() hard-code are the real control.
  if exists (
    select 1 from mcp_internal.mcp_bot_permissions
     where permission_pattern in ('content.queue_distribution', 'content.record_publication')
       and bot_id <> 'bot_distribution'
  ) then
    raise exception
      'Phase 10: content.queue_distribution / content.record_publication must not be granted outside bot_distribution';
  end if;
  perform mcp_internal.assert_cos_prohibitions();
  if not exists (
    select 1 from mcp_internal.mcp_bot_permissions
     where bot_id = 'bot_distribution' and permission_pattern = 'content.queue_distribution'
  ) then
    raise exception 'Phase 10: Distribution Manager queue_distribution grant missing';
  end if;
  if not exists (
    select 1 from mcp_internal.mcp_bot_permissions
     where bot_id = 'bot_distribution' and permission_pattern = 'content.record_publication'
  ) then
    raise exception 'Phase 10: Distribution Manager record_publication grant missing';
  end if;
end $$;

comment on function mcp_internal.queue_distribution(text, text, text, uuid, uuid, date, text) is
  'Phase 10 Bot-safe schedule write (realizes content.queue_distribution). bot_distribution only (hard-coded). Approved asset only. Never can_access_client / schedule_asset().';
comment on function public.mcp_queue_distribution(text, text, text, uuid, uuid, date, text) is
  'Phase 10 public wrapper for mcp_internal.queue_distribution. service_role only.';
comment on function mcp_internal.record_publication(text, text, text, uuid, uuid, text, text, text) is
  'Phase 10 Bot-safe publication record (content.record_publication). bot_distribution only (hard-coded). Gate 10 stand-in for live platform publish; only decides a scheduled row.';
comment on function public.mcp_record_publication(text, text, text, uuid, uuid, text, text, text) is
  'Phase 10 public wrapper for mcp_internal.record_publication. service_role only.';
comment on column scheduled_posts.created_by_bot is
  'Phase 10: Bot attribution for a Bot-scheduled row. Mutually exclusive with created_by (human). Alex approval required before applying this migration to production.';
comment on column scheduled_posts.publication_status is
  'Phase 10: scheduled | published | failed. Gate 10 record-publication path until live platform publish exists.';

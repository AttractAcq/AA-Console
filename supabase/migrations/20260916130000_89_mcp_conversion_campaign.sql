-- Phase 16: Conversion Page Builder + Campaign Execution MCP.
-- Realizes conversion.* against client_pages / polish jobs, and rebinds
-- campaign list/get/status/writes to client_campaigns (Execution OS).
-- Legacy public.campaigns remains the attribution/spend tracker via
-- mcp_campaign_read.get_campaign_performance only.
-- DO NOT APPLY TO STAGING OR PRODUCTION without Alex via Chief of Staff.
--
-- Grants are ADDITIVE (PR #48 / mig 89): delete+insert the 17 names this
-- phase owns. Post-#48 Marketing count is 40 (Gate 9's 23 + 17). This is
-- NOT the final 45. After #48 then #46 then #47: Marketing 45, Sales Ops 28.
-- Sibling PRs must APPEND, not replace all bot_marketing rows.
--
-- Every Bot RPC: require_active_bot + require_bot_client_grant; never
-- can_access_client. Isolation tests must stay green before registry unstub.
-- Production does not get page publish (sites.* is a later batch).
-- campaign.launch sets client_campaigns.status=live only; no ad spend.

begin;

-- ---------------------------------------------------------------------------
-- Ledgers
-- ---------------------------------------------------------------------------

create table mcp_internal.mcp_conversion_requests (
  bot_id text not null references mcp_internal.mcp_bots(bot_id),
  execution_id text not null check (execution_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  request_id text not null check (request_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  tool text not null check (tool in (
    'conversion.create_page',
    'conversion.generate_structure',
    'conversion.generate_copy',
    'conversion.request_approval',
    'conversion.audit_page',
    'conversion.revise_page',
    'conversion.revert_page'
  )),
  client_id uuid not null references public.clients(id),
  page_id uuid references public.client_pages(id),
  payload jsonb not null,
  result jsonb not null,
  created_at timestamptz not null default now(),
  primary key (bot_id, execution_id)
);
create index mcp_conversion_requests_client_idx
  on mcp_internal.mcp_conversion_requests (client_id, created_at desc);

create table mcp_internal.mcp_campaign_requests (
  bot_id text not null references mcp_internal.mcp_bots(bot_id),
  execution_id text not null check (execution_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  request_id text not null check (request_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  tool text not null check (tool in (
    'campaign.create',
    'campaign.update',
    'campaign.request_approval',
    'campaign.plan',
    'campaign.provision',
    'campaign.launch'
  )),
  client_id uuid not null references public.clients(id),
  campaign_id uuid references public.client_campaigns(id),
  payload jsonb not null,
  result jsonb not null,
  created_at timestamptz not null default now(),
  primary key (bot_id, execution_id)
);
create index mcp_campaign_requests_client_idx
  on mcp_internal.mcp_campaign_requests (client_id, created_at desc);

alter table mcp_internal.mcp_conversion_requests enable row level security;
alter table mcp_internal.mcp_conversion_requests force row level security;
alter table mcp_internal.mcp_campaign_requests enable row level security;
alter table mcp_internal.mcp_campaign_requests force row level security;
revoke all on mcp_internal.mcp_conversion_requests, mcp_internal.mcp_campaign_requests
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Projections (no HTML, no job params/costs/errors)
-- ---------------------------------------------------------------------------

create function mcp_internal.page_json(p client_pages)
returns jsonb
language plpgsql
stable
set search_path = pg_catalog, mcp_internal, public
as $$
begin
  return jsonb_build_object(
    'id', p.id,
    'client_id', p.client_id,
    'page_type', p.page_type,
    'title', p.title,
    'status', p.status,
    'brief', mcp_internal.clip_text(p.brief, 4000),
    'html_present', (p.html is not null and length(p.html) > 0),
    'current_revision', p.current_revision,
    'published_url', p.published_url,
    'built_at', p.built_at,
    'created_at', p.created_at,
    'updated_at', p.updated_at
  );
end
$$;
revoke all on function mcp_internal.page_json(client_pages)
  from public, anon, authenticated, service_role;

create function mcp_internal.campaign_json(c client_campaigns)
returns jsonb
language plpgsql
stable
set search_path = pg_catalog, mcp_internal, public
as $$
begin
  return jsonb_build_object(
    'id', c.id,
    'client_id', c.client_id,
    'name', c.name,
    'brief', mcp_internal.clip_text(c.brief, 4000),
    'status', c.status,
    'objective', mcp_internal.clip_text(c.objective, 2000),
    'audience', mcp_internal.clip_text(c.audience, 2000),
    'offer_summary', mcp_internal.clip_text(c.offer_summary, 2000),
    'core_message', mcp_internal.clip_text(c.core_message, 2000),
    'channels', to_jsonb(c.channels),
    'budget', c.budget,
    'starts_on', c.starts_on,
    'ends_on', c.ends_on,
    'kpi_metric', c.kpi_metric,
    'kpi_target', c.kpi_target,
    'content_count', c.content_count,
    'needs_landing_page', c.needs_landing_page,
    'needs_sales_agent', c.needs_sales_agent,
    'ad_campaign_id', c.ad_campaign_id,
    'built_at', c.built_at,
    'launched_at', c.launched_at,
    'created_at', c.created_at,
    'updated_at', c.updated_at
  );
end
$$;
revoke all on function mcp_internal.campaign_json(client_campaigns)
  from public, anon, authenticated, service_role;

create function mcp_internal.campaign_readiness_rows(p_campaign_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, mcp_internal, public
set timezone = 'UTC'
as $$
declare
  c client_campaigns%rowtype;
  items jsonb := '[]'::jsonb;
  n integer;
begin
  select * into c from public.client_campaigns where id = p_campaign_id;
  if not found then
    raise exception using message = 'campaign_not_found', errcode = 'P0001';
  end if;

  items := items || jsonb_build_array(jsonb_build_object(
    'requirement', 'Plan',
    'required', 1,
    'have', (c.built_at is not null)::integer,
    'met', c.built_at is not null,
    'detail', case when c.built_at is not null then 'Written by the planner.'
                   else 'The planner has not written this campaign yet.' end
  ));

  if c.content_count > 0 then
    select count(*)::integer into n
      from public.campaign_artifacts a
      left join public.client_briefs b on b.id = a.brief_id
      left join public.client_media_assets m on m.id = a.asset_id
     where a.campaign_id = c.id
       and a.kind = 'content'
       and (b.body is not null or m.review_status = 'approved');
    items := items || jsonb_build_array(jsonb_build_object(
      'requirement', 'Content',
      'required', c.content_count,
      'have', n,
      'met', n >= c.content_count,
      'detail', format('%s of %s pieces written or approved.', n, c.content_count)
    ));
  end if;

  if c.needs_landing_page then
    select count(*)::integer into n
      from public.campaign_artifacts a
      join public.client_pages p on p.id = a.page_id
     where a.campaign_id = c.id and p.html is not null;
    items := items || jsonb_build_array(jsonb_build_object(
      'requirement', 'Landing page',
      'required', 1,
      'have', n,
      'met', n >= 1,
      'detail', case when n >= 1 then 'Built.'
                     else 'No page with any HTML in it is attached to this campaign.' end
    ));
  end if;

  if c.needs_sales_agent then
    select count(*)::integer into n
      from public.campaign_artifacts a
      join public.client_sales_agents s on s.id = a.sales_agent_id
     where a.campaign_id = c.id and s.built_at is not null and s.status = 'live';
    items := items || jsonb_build_array(jsonb_build_object(
      'requirement', 'Sales agent',
      'required', 1,
      'have', n,
      'met', n >= 1,
      'detail', case when n >= 1 then 'Built and live.'
                     else 'No built, live sales agent is attached. A draft agent answers nobody.' end
    ));
  end if;

  return items;
end
$$;
revoke all on function mcp_internal.campaign_readiness_rows(uuid)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Permission + idempotency helpers
-- ---------------------------------------------------------------------------

create function mcp_internal.require_conversion_permission(p_bot_id text, p_client_id uuid, p_tool text)
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
  if p_bot_id is distinct from 'bot_marketing' then
    raise exception using message = 'bot_forbidden', errcode = 'P0001';
  end if;
  if p_tool not in (
    'conversion.list_pages',
    'conversion.get_page',
    'conversion.create_page',
    'conversion.generate_structure',
    'conversion.generate_copy',
    'conversion.request_approval',
    'conversion.get_performance',
    'conversion.audit_page',
    'conversion.revise_page',
    'conversion.revert_page'
  ) then
    raise exception using message = 'bot_forbidden', errcode = 'P0001';
  end if;
  if not mcp_internal.bot_has_permission(p_bot_id, p_tool) then
    raise exception using message = 'bot_forbidden', errcode = 'P0001';
  end if;
end
$$;
revoke all on function mcp_internal.require_conversion_permission(text, uuid, text)
  from public, anon, authenticated, service_role;

create function mcp_internal.require_campaign_execution_permission(p_bot_id text, p_client_id uuid, p_tool text)
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
    'campaign.list',
    'campaign.get',
    'campaign.get_status',
    'campaign.get_readiness',
    'campaign.create',
    'campaign.update',
    'campaign.request_approval',
    'campaign.plan',
    'campaign.provision',
    'campaign.launch'
  ) then
    raise exception using message = 'bot_forbidden', errcode = 'P0001';
  end if;
  if not mcp_internal.bot_has_permission(p_bot_id, p_tool) then
    raise exception using message = 'bot_forbidden', errcode = 'P0001';
  end if;
end
$$;
revoke all on function mcp_internal.require_campaign_execution_permission(text, uuid, text)
  from public, anon, authenticated, service_role;

create function mcp_internal.take_conversion_request(
  p_bot_id text, p_execution_id text, p_tool text, p_client_id uuid, p_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, mcp_internal, public
as $$
declare
  v_row mcp_internal.mcp_conversion_requests;
begin
  perform mcp_internal.require_service_role();
  perform pg_advisory_xact_lock(hashtextextended(p_bot_id || ':conversion:' || p_execution_id, 0));
  select * into v_row
    from mcp_internal.mcp_conversion_requests
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
end
$$;
revoke all on function mcp_internal.take_conversion_request(text, text, text, uuid, jsonb)
  from public, anon, authenticated;
grant execute on function mcp_internal.take_conversion_request(text, text, text, uuid, jsonb)
  to service_role;

create function mcp_internal.take_campaign_request(
  p_bot_id text, p_execution_id text, p_tool text, p_client_id uuid, p_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, mcp_internal, public
as $$
declare
  v_row mcp_internal.mcp_campaign_requests;
begin
  perform mcp_internal.require_service_role();
  perform pg_advisory_xact_lock(hashtextextended(p_bot_id || ':campaign:' || p_execution_id, 0));
  select * into v_row
    from mcp_internal.mcp_campaign_requests
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
end
$$;
revoke all on function mcp_internal.take_campaign_request(text, text, text, uuid, jsonb)
  from public, anon, authenticated;
grant execute on function mcp_internal.take_campaign_request(text, text, text, uuid, jsonb)
  to service_role;

create function mcp_internal.enqueue_mcp_job(
  p_agent_key text, p_client_id uuid, p_input_table text, p_input_id uuid,
  p_bot_id text, p_request_id text, p_execution_id text, p_unavailable text
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, mcp_internal, public
as $$
declare
  v_job uuid;
  v_meta jsonb;
begin
  v_meta := jsonb_build_object(
    'source', 'aa-mcp-gateway',
    'bot_id', p_bot_id,
    'request_id', p_request_id,
    'execution_id', p_execution_id
  );
  begin
    v_job := enqueue_agent_job_internal(
      p_agent_key, p_client_id, p_input_table, p_input_id, null, v_meta, 'Queued by MCP gateway');
  exception
    when raise_exception then
      raise exception using message = p_unavailable, errcode = 'P0001';
    when others then
      raise exception using message = 'queue_failure', errcode = 'P0001';
  end;
  return v_job;
end
$$;
revoke all on function mcp_internal.enqueue_mcp_job(text, uuid, text, uuid, text, text, text, text)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Conversion reads / writes
-- ---------------------------------------------------------------------------

create function mcp_internal.conversion(
  p_bot_id text,
  p_client_id uuid,
  p_action text,
  p_page_id uuid default null,
  p_limit integer default 25,
  p_after uuid default null,
  p_page_type text default null,
  p_title text default null,
  p_brief text default null,
  p_campaign_id uuid default null,
  p_summary text default null,
  p_revision_number integer default null,
  p_finding_ids uuid[] default null,
  p_request_id text default null,
  p_execution_id text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, mcp_internal, public
set timezone = 'UTC'
as $$
declare
  tool text;
  page client_pages%rowtype;
  items jsonb;
  next_id uuid;
  payload jsonb;
  existing jsonb;
  result jsonb;
  v_job uuid;
  v_page uuid;
  v_type page_type;
  v_rev client_page_revisions%rowtype;
  v_next integer;
  v_findings jsonb;
  v_revisions jsonb;
  v_open integer;
  v_person integer;
  v_fixable integer;
  v_campaign_ids jsonb;
begin
  tool := 'conversion.' || p_action;
  perform mcp_internal.require_conversion_permission(p_bot_id, p_client_id, tool);
  if p_limit is null or p_limit not between 1 and 100 then
    raise exception using message = 'invalid_request', errcode = 'P0001';
  end if;

  if p_action in ('list_pages') then
    if p_page_type is not null and p_page_type not in ('landing', 'offer') then
      raise exception using message = 'invalid_request', errcode = 'P0001';
    end if;
    select coalesce(jsonb_agg(to_jsonb(x) order by x.id), '[]') into items
      from (
        select p.id, p.client_id, p.page_type, p.title, p.status,
               mcp_internal.clip_text(p.brief, 4000) as brief,
               (p.html is not null and length(p.html) > 0) as html_present,
               p.current_revision, p.published_url, p.built_at, p.created_at, p.updated_at
          from public.client_pages p
         where p.client_id = p_client_id
           and (p_page_type is null or p.page_type::text = p_page_type)
           and (p_after is null or p.id > p_after)
         order by p.id
         limit p_limit + 1
      ) x;
    if jsonb_array_length(items) > p_limit then
      items := items - p_limit;
      next_id := (items -> (p_limit - 1) ->> 'id')::uuid;
    end if;
    return jsonb_build_object(
      'client_id', p_client_id,
      'projection', 'client_pages_v1',
      'pages', items,
      'next_cursor', next_id
    );
  end if;

  if p_action in ('get_page', 'get_performance', 'generate_structure', 'generate_copy',
                  'request_approval', 'audit_page', 'revise_page', 'revert_page') then
    if p_page_id is null then
      raise exception using message = 'invalid_request', errcode = 'P0001';
    end if;
    select * into page from public.client_pages where id = p_page_id for share;
    if not found then
      raise exception using message = 'page_not_found', errcode = 'P0001';
    end if;
    if page.client_id is distinct from p_client_id then
      raise exception using message = 'client_mismatch', errcode = 'P0001';
    end if;
  end if;

  if p_action = 'get_page' then
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', f.id, 'category', f.category, 'severity', f.severity, 'title', f.title,
      'classification', f.classification, 'status', f.status, 'revision_number', f.revision_number
    ) order by f.created_at, f.id), '[]') into v_findings
      from public.client_page_findings f
     where f.page_id = page.id;
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', r.id, 'revision_number', r.revision_number, 'source', r.source,
      'summary', mcp_internal.clip_text(r.summary, 1000), 'created_at', r.created_at
    ) order by r.revision_number desc), '[]') into v_revisions
      from public.client_page_revisions r
     where r.page_id = page.id;
    select coalesce(jsonb_agg(a.campaign_id order by a.campaign_id), '[]') into v_campaign_ids
      from public.campaign_artifacts a
     where a.page_id = page.id and a.kind = 'landing_page';
    return jsonb_build_object(
      'client_id', p_client_id,
      'page', mcp_internal.page_json(page),
      'findings', v_findings,
      'revisions', v_revisions,
      'campaign_ids', v_campaign_ids
    );
  end if;

  if p_action = 'get_performance' then
    select count(*) filter (where status = 'open')::integer,
           count(*) filter (where classification = 'NEEDS_PERSON' and status = 'open')::integer,
           count(*) filter (where classification = 'FIXABLE' and status in ('open','selected'))::integer
      into v_open, v_person, v_fixable
      from public.client_page_findings
     where page_id = page.id;
    return jsonb_build_object(
      'client_id', p_client_id,
      'page_id', page.id,
      'projection', 'page_operational_status_v1',
      'page', mcp_internal.page_json(page),
      'findings', jsonb_build_object(
        'open', v_open, 'needs_person', v_person, 'fixable', v_fixable
      ),
      'metrics', jsonb_build_object(
        'availability', 'unknown',
        'note', 'Page performance is operational status only; site analytics are not connected.'
      )
    );
  end if;

  perform mcp_internal.require_mcp_ids(p_request_id, p_execution_id);
  payload := jsonb_strip_nulls(jsonb_build_object(
    'action', p_action,
    'page_id', p_page_id,
    'page_type', p_page_type,
    'title', p_title,
    'brief', p_brief,
    'campaign_id', p_campaign_id,
    'summary', p_summary,
    'revision_number', p_revision_number,
    'finding_ids', to_jsonb(p_finding_ids)
  ));
  existing := mcp_internal.take_conversion_request(p_bot_id, p_execution_id, tool, p_client_id, payload);
  if existing is not null then
    return existing;
  end if;

  if p_action = 'create_page' then
    if p_title is null or length(btrim(p_title)) not between 1 and 200 then
      raise exception using message = 'invalid_request', errcode = 'P0001';
    end if;
    if p_brief is null or length(btrim(p_brief)) not between 1 and 4000 then
      raise exception using message = 'invalid_request', errcode = 'P0001';
    end if;
    if p_page_type is not null and p_page_type not in ('landing', 'offer') then
      raise exception using message = 'invalid_request', errcode = 'P0001';
    end if;
    v_type := coalesce(nullif(p_page_type, ''), 'landing')::page_type;
    if p_campaign_id is not null then
      perform 1 from public.client_campaigns
       where id = p_campaign_id and client_id = p_client_id for share;
      if not found then
        raise exception using message = 'campaign_not_found', errcode = 'P0001';
      end if;
    end if;
    insert into public.client_pages (client_id, page_type, title, brief, status)
    values (p_client_id, v_type, btrim(p_title), btrim(p_brief), 'draft')
    returning * into page;
    if p_campaign_id is not null then
      insert into public.campaign_artifacts (campaign_id, client_id, kind, page_id)
      values (p_campaign_id, p_client_id, 'landing_page', page.id);
    end if;
    v_job := mcp_internal.enqueue_mcp_job(
      'landing_page', p_client_id, 'client_pages', page.id,
      p_bot_id, p_request_id, p_execution_id, 'page_agent_unavailable');
    result := jsonb_build_object(
      'client_id', p_client_id,
      'page', mcp_internal.page_json(page),
      'job_id', v_job,
      'replayed', false
    );
  elsif p_action in ('generate_structure', 'generate_copy') then
    v_job := mcp_internal.enqueue_mcp_job(
      'landing_page', p_client_id, 'client_pages', page.id,
      p_bot_id, p_request_id, p_execution_id, 'page_agent_unavailable');
    result := jsonb_build_object(
      'client_id', p_client_id, 'page_id', page.id, 'job_id', v_job, 'replayed', false
    );
  elsif p_action = 'audit_page' then
    if page.html is null or length(page.html) = 0 then
      raise exception using message = 'invalid_page_status', errcode = 'P0001';
    end if;
    v_job := mcp_internal.enqueue_mcp_job(
      'page_audit', p_client_id, 'client_pages', page.id,
      p_bot_id, p_request_id, p_execution_id, 'page_agent_unavailable');
    result := jsonb_build_object(
      'client_id', p_client_id, 'page_id', page.id, 'job_id', v_job, 'replayed', false
    );
  elsif p_action = 'revise_page' then
    if p_finding_ids is null or coalesce(array_length(p_finding_ids, 1), 0) < 1
       or coalesce(array_length(p_finding_ids, 1), 0) > 50 then
      raise exception using message = 'invalid_request', errcode = 'P0001';
    end if;
    if exists (
      select 1 from unnest(p_finding_ids) f(id)
      left join public.client_page_findings x on x.id = f.id
     where x.id is null
        or x.page_id is distinct from page.id
        or x.client_id is distinct from p_client_id
        or x.classification is distinct from 'FIXABLE'
        or x.status not in ('open', 'selected')
        or x.revision_number is distinct from page.current_revision
    ) then
      raise exception using message = 'invalid_request', errcode = 'P0001';
    end if;
    update public.client_page_findings
       set status = 'selected', updated_at = now()
     where id = any (p_finding_ids);
    v_job := mcp_internal.enqueue_mcp_job(
      'page_revise', p_client_id, 'client_pages', page.id,
      p_bot_id, p_request_id, p_execution_id, 'page_agent_unavailable');
    result := jsonb_build_object(
      'client_id', p_client_id, 'page_id', page.id, 'job_id', v_job,
      'finding_ids', to_jsonb(p_finding_ids), 'replayed', false
    );
  elsif p_action = 'revert_page' then
    if p_revision_number is null or p_revision_number < 1 then
      raise exception using message = 'invalid_request', errcode = 'P0001';
    end if;
    select * into page from public.client_pages where id = page.id for update;
    select * into v_rev from public.client_page_revisions
     where page_id = page.id and revision_number = p_revision_number;
    if not found then
      raise exception using message = 'revision_not_found', errcode = 'P0001';
    end if;
    select coalesce(max(revision_number), 0) + 1 into v_next
      from public.client_page_revisions where page_id = page.id;
    insert into public.client_page_revisions (
      client_id, page_id, revision_number, html, meta_title, meta_description,
      body, source, summary
    ) values (
      page.client_id, page.id, v_next, v_rev.html, v_rev.meta_title, v_rev.meta_description,
      v_rev.body, 'revert', format('Reverted to revision %s.', p_revision_number)
    );
    update public.client_pages
       set html = v_rev.html,
           meta_title = coalesce(v_rev.meta_title, meta_title),
           meta_description = coalesce(v_rev.meta_description, meta_description),
           body = coalesce(v_rev.body, body),
           current_revision = v_next,
           updated_at = now()
     where id = page.id
     returning * into page;
    result := jsonb_build_object(
      'client_id', p_client_id,
      'page', mcp_internal.page_json(page),
      'reverted_to', p_revision_number,
      'replayed', false
    );
  elsif p_action = 'request_approval' then
    if p_summary is not null and length(p_summary) > 4000 then
      raise exception using message = 'invalid_request', errcode = 'P0001';
    end if;
    result := jsonb_build_object(
      'client_id', p_client_id,
      'page_id', page.id,
      'queue', 'console_page_review',
      'message', 'Page is in the Console review queue. Bots cannot publish pages.',
      'summary', p_summary,
      'replayed', false
    );
  else
    raise exception using message = 'invalid_request', errcode = 'P0001';
  end if;

  insert into mcp_internal.mcp_conversion_requests (
    bot_id, execution_id, request_id, tool, client_id, page_id, payload, result
  ) values (
    p_bot_id, p_execution_id, p_request_id, tool, p_client_id,
    coalesce(page.id, v_page), payload, result
  );
  return result;
end
$$;
revoke all on function mcp_internal.conversion(text, uuid, text, uuid, integer, uuid, text, text, text, uuid, text, integer, uuid[], text, text)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Campaign Execution OS
-- ---------------------------------------------------------------------------

create function mcp_internal.campaign_execution(
  p_bot_id text,
  p_client_id uuid,
  p_action text,
  p_campaign_id uuid default null,
  p_limit integer default 25,
  p_after uuid default null,
  p_name text default null,
  p_brief text default null,
  p_status text default null,
  p_summary text default null,
  p_kind text default null,
  p_request_id text default null,
  p_execution_id text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, mcp_internal, public
set timezone = 'UTC'
as $$
declare
  tool text;
  c client_campaigns%rowtype;
  items jsonb;
  next_id uuid;
  payload jsonb;
  existing jsonb;
  result jsonb;
  v_job uuid;
  v_page uuid;
  v_agent uuid;
  v_created jsonb := '[]'::jsonb;
  missing text;
  reqs jsonb;
begin
  tool := 'campaign.' || p_action;
  perform mcp_internal.require_campaign_execution_permission(p_bot_id, p_client_id, tool);
  if p_limit is null or p_limit not between 1 and 100 then
    raise exception using message = 'invalid_request', errcode = 'P0001';
  end if;

  if p_action = 'list' then
    select coalesce(jsonb_agg(to_jsonb(x) order by x.id), '[]') into items
      from (
        select camp.id, camp.client_id, camp.name,
               mcp_internal.clip_text(camp.brief, 4000) as brief,
               camp.status,
               mcp_internal.clip_text(camp.objective, 2000) as objective,
               mcp_internal.clip_text(camp.audience, 2000) as audience,
               mcp_internal.clip_text(camp.offer_summary, 2000) as offer_summary,
               mcp_internal.clip_text(camp.core_message, 2000) as core_message,
               to_jsonb(camp.channels) as channels,
               camp.budget, camp.starts_on, camp.ends_on, camp.kpi_metric, camp.kpi_target,
               camp.content_count, camp.needs_landing_page, camp.needs_sales_agent,
               camp.ad_campaign_id, camp.built_at, camp.launched_at, camp.created_at, camp.updated_at
          from public.client_campaigns camp
         where camp.client_id = p_client_id
           and (p_after is null or camp.id > p_after)
         order by camp.id
         limit p_limit + 1
      ) x;
    if jsonb_array_length(items) > p_limit then
      items := items - p_limit;
      next_id := (items -> (p_limit - 1) ->> 'id')::uuid;
    end if;
    return jsonb_build_object(
      'client_id', p_client_id,
      'projection', 'client_campaigns_execution_v1',
      'campaigns', items,
      'next_cursor', next_id
    );
  end if;

  if p_action <> 'create' then
    if p_campaign_id is null then
      raise exception using message = 'invalid_request', errcode = 'P0001';
    end if;
    select * into c from public.client_campaigns where id = p_campaign_id for share;
    if not found then
      raise exception using message = 'campaign_not_found', errcode = 'P0001';
    end if;
    if c.client_id is distinct from p_client_id then
      raise exception using message = 'client_mismatch', errcode = 'P0001';
    end if;
  end if;

  if p_action = 'get' then
    return jsonb_build_object(
      'client_id', p_client_id,
      'campaign', mcp_internal.campaign_json(c),
      'projection', 'client_campaigns_execution_v1'
    );
  end if;

  if p_action = 'get_status' then
    return jsonb_build_object(
      'client_id', p_client_id,
      'campaign_id', c.id,
      'status', c.status,
      'built_at', c.built_at,
      'launched_at', c.launched_at,
      'projection', 'client_campaigns_execution_v1'
    );
  end if;

  if p_action = 'get_readiness' then
    reqs := mcp_internal.campaign_readiness_rows(c.id);
    return jsonb_build_object(
      'client_id', p_client_id,
      'campaign_id', c.id,
      'status', c.status,
      'readiness', reqs,
      'ready', not exists (
        select 1 from jsonb_array_elements(reqs) r
         where (r->>'met')::boolean is not true
      )
    );
  end if;

  perform mcp_internal.require_mcp_ids(p_request_id, p_execution_id);
  payload := jsonb_strip_nulls(jsonb_build_object(
    'action', p_action,
    'campaign_id', p_campaign_id,
    'name', p_name,
    'brief', p_brief,
    'status', p_status,
    'summary', p_summary,
    'kind', p_kind
  ));
  existing := mcp_internal.take_campaign_request(p_bot_id, p_execution_id, tool, p_client_id, payload);
  if existing is not null then
    return existing;
  end if;

  if p_action = 'create' then
    if p_name is null or length(btrim(p_name)) not between 1 and 200 then
      raise exception using message = 'invalid_request', errcode = 'P0001';
    end if;
    if p_brief is null or length(btrim(p_brief)) not between 1 and 4000 then
      raise exception using message = 'invalid_request', errcode = 'P0001';
    end if;
    insert into public.client_campaigns (client_id, name, brief)
    values (p_client_id, btrim(p_name), btrim(p_brief))
    returning * into c;
    v_job := mcp_internal.enqueue_mcp_job(
      'campaign_plan', p_client_id, 'client_campaigns', c.id,
      p_bot_id, p_request_id, p_execution_id, 'campaign_agent_unavailable');
    result := jsonb_build_object(
      'client_id', p_client_id,
      'campaign', mcp_internal.campaign_json(c),
      'job_id', v_job,
      'replayed', false
    );
  elsif p_action = 'update' then
    if (p_name is null or length(btrim(p_name)) = 0)
       and (p_brief is null or length(btrim(p_brief)) = 0)
       and p_status is null then
      raise exception using message = 'invalid_request', errcode = 'P0001';
    end if;
    if p_name is not null and length(btrim(p_name)) not between 1 and 200 then
      raise exception using message = 'invalid_request', errcode = 'P0001';
    end if;
    if p_brief is not null and length(btrim(p_brief)) not between 1 and 4000 then
      raise exception using message = 'invalid_request', errcode = 'P0001';
    end if;
    if p_status is not null and p_status not in ('complete', 'cancelled') then
      raise exception using message = 'invalid_request', errcode = 'P0001';
    end if;
    select * into c from public.client_campaigns where id = c.id for update;
    update public.client_campaigns
       set name = coalesce(nullif(btrim(coalesce(p_name, '')), ''), name),
           brief = coalesce(nullif(btrim(coalesce(p_brief, '')), ''), brief),
           status = coalesce(p_status, status),
           updated_at = now()
     where id = c.id
     returning * into c;
    result := jsonb_build_object(
      'client_id', p_client_id,
      'campaign', mcp_internal.campaign_json(c),
      'replayed', false
    );
  elsif p_action = 'plan' then
    v_job := mcp_internal.enqueue_mcp_job(
      'campaign_plan', p_client_id, 'client_campaigns', c.id,
      p_bot_id, p_request_id, p_execution_id, 'campaign_agent_unavailable');
    result := jsonb_build_object(
      'client_id', p_client_id, 'campaign_id', c.id, 'job_id', v_job, 'replayed', false
    );
  elsif p_action = 'provision' then
    select * into c from public.client_campaigns where id = c.id for update;
    if c.built_at is null then
      raise exception using message = 'no_plan', errcode = 'P0001';
    end if;
    if p_kind is not null and p_kind not in ('landing_page', 'sales_agent') then
      raise exception using message = 'invalid_request', errcode = 'P0001';
    end if;
    if p_kind is null or p_kind = 'landing_page' then
      if (p_kind = 'landing_page' or c.needs_landing_page)
         and not exists (select 1 from public.campaign_artifacts a
                          where a.campaign_id = c.id and a.page_id is not null) then
        insert into public.client_pages (client_id, page_type, title, brief, status)
        values (c.client_id, 'landing', c.name || ' — landing page',
                concat_ws(E'\n\n',
                  'Built for the campaign "' || c.name || '".',
                  nullif(c.objective, ''),
                  nullif(c.offer_summary, ''),
                  nullif(c.core_message, ''),
                  nullif(c.audience, '')),
                'draft')
        returning id into v_page;
        insert into public.campaign_artifacts (campaign_id, client_id, kind, page_id)
        values (c.id, c.client_id, 'landing_page', v_page);
        if p_kind = 'landing_page' then
          update public.client_campaigns set needs_landing_page = true, updated_at = now() where id = c.id;
        end if;
        perform mcp_internal.enqueue_mcp_job(
          'landing_page', c.client_id, 'client_pages', v_page,
          p_bot_id, p_request_id, p_execution_id, 'page_agent_unavailable');
        v_created := v_created || jsonb_build_array(jsonb_build_object(
          'created', 'landing_page', 'artifact_id', v_page));
      elsif p_kind = 'landing_page' then
        select a.page_id into v_page from public.campaign_artifacts a
         where a.campaign_id = c.id and a.page_id is not null limit 1;
        v_created := v_created || jsonb_build_array(jsonb_build_object(
          'created', 'already_exists', 'artifact_id', v_page));
      end if;
    end if;
    if p_kind is null or p_kind = 'sales_agent' then
      if (p_kind = 'sales_agent' or c.needs_sales_agent)
         and not exists (select 1 from public.campaign_artifacts a
                          where a.campaign_id = c.id and a.sales_agent_id is not null) then
        select a.page_id into v_page from public.campaign_artifacts a
         where a.campaign_id = c.id and a.page_id is not null limit 1;
        insert into public.client_sales_agents (client_id, page_id, name, purpose)
        values (c.client_id, v_page, c.name || ' — sales agent',
                concat_ws(E'\n\n',
                  'Built for the campaign "' || c.name || '".',
                  nullif(c.objective, ''),
                  nullif(c.audience, ''),
                  nullif(c.offer_summary, '')))
        returning id into v_agent;
        insert into public.campaign_artifacts (campaign_id, client_id, kind, sales_agent_id)
        values (c.id, c.client_id, 'sales_agent', v_agent);
        if p_kind = 'sales_agent' then
          update public.client_campaigns set needs_sales_agent = true, updated_at = now() where id = c.id;
        end if;
        perform mcp_internal.enqueue_mcp_job(
          'sales_agent', c.client_id, 'client_sales_agents', v_agent,
          p_bot_id, p_request_id, p_execution_id, 'campaign_agent_unavailable');
        v_created := v_created || jsonb_build_array(jsonb_build_object(
          'created', 'sales_agent', 'artifact_id', v_agent));
      elsif p_kind = 'sales_agent' then
        select a.sales_agent_id into v_agent from public.campaign_artifacts a
         where a.campaign_id = c.id and a.sales_agent_id is not null limit 1;
        v_created := v_created || jsonb_build_array(jsonb_build_object(
          'created', 'already_exists', 'artifact_id', v_agent));
      end if;
    end if;
    result := jsonb_build_object(
      'client_id', p_client_id,
      'campaign_id', c.id,
      'created', v_created,
      'replayed', false
    );
  elsif p_action = 'launch' then
    -- Marks Execution OS client_campaigns.status='live' only. Does not write
    -- public.campaigns (ad tracker), spend, Meta/TikTok, or paid-channel
    -- credentials. Stays MEDIUM with no gateway approval.
    select * into c from public.client_campaigns where id = c.id for update;
    if c.status is distinct from 'live' then
      reqs := mcp_internal.campaign_readiness_rows(c.id);
      select r->>'detail' into missing
        from jsonb_array_elements(reqs) r
       where (r->>'met')::boolean is not true
       order by r->>'requirement'
       limit 1;
      if missing is not null then
        raise exception using message = 'not_ready', errcode = 'P0001';
      end if;
      update public.client_campaigns
         set status = 'live', launched_at = now(), updated_at = now()
       where id = c.id
       returning * into c;
    end if;
    result := jsonb_build_object(
      'client_id', p_client_id,
      'campaign', mcp_internal.campaign_json(c),
      'replayed', false
    );
  elsif p_action = 'request_approval' then
    if p_summary is not null and length(p_summary) > 4000 then
      raise exception using message = 'invalid_request', errcode = 'P0001';
    end if;
    reqs := mcp_internal.campaign_readiness_rows(c.id);
    result := jsonb_build_object(
      'client_id', p_client_id,
      'campaign_id', c.id,
      'queue', 'console_campaign_launch',
      'readiness', reqs,
      'message', 'Launch approval requested. campaign.launch still requires derived readiness; Bots cannot record the human decision.',
      'summary', p_summary,
      'replayed', false
    );
  else
    raise exception using message = 'invalid_request', errcode = 'P0001';
  end if;

  insert into mcp_internal.mcp_campaign_requests (
    bot_id, execution_id, request_id, tool, client_id, campaign_id, payload, result
  ) values (
    p_bot_id, p_execution_id, p_request_id, tool, p_client_id, c.id, payload, result
  );
  return result;
end
$$;
revoke all on function mcp_internal.campaign_execution(text, uuid, text, uuid, integer, uuid, text, text, text, text, text, text, text)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Public wrappers (service_role only)
-- ---------------------------------------------------------------------------

create function public.mcp_conversion(
  p_bot_id text,
  p_client_id uuid,
  p_action text,
  p_page_id uuid default null,
  p_limit integer default 25,
  p_after uuid default null,
  p_page_type text default null,
  p_title text default null,
  p_brief text default null,
  p_campaign_id uuid default null,
  p_summary text default null,
  p_revision_number integer default null,
  p_finding_ids uuid[] default null,
  p_request_id text default null,
  p_execution_id text default null
) returns jsonb
language plpgsql volatile security definer
set search_path = pg_catalog, mcp_internal, public
set timezone = 'UTC'
as $$
begin
  perform mcp_internal.require_service_role();
  perform mcp_internal.require_active_bot(p_bot_id);
  perform mcp_internal.require_bot_client_grant(p_bot_id, p_client_id);
  return mcp_internal.conversion(
    p_bot_id, p_client_id, p_action, p_page_id, p_limit, p_after, p_page_type,
    p_title, p_brief, p_campaign_id, p_summary, p_revision_number, p_finding_ids,
    p_request_id, p_execution_id
  );
end
$$;
revoke all on function public.mcp_conversion(text, uuid, text, uuid, integer, uuid, text, text, text, uuid, text, integer, uuid[], text, text)
  from public, anon, authenticated;
grant execute on function public.mcp_conversion(text, uuid, text, uuid, integer, uuid, text, text, text, uuid, text, integer, uuid[], text, text)
  to service_role;

create function public.mcp_campaign_execution(
  p_bot_id text,
  p_client_id uuid,
  p_action text,
  p_campaign_id uuid default null,
  p_limit integer default 25,
  p_after uuid default null,
  p_name text default null,
  p_brief text default null,
  p_status text default null,
  p_summary text default null,
  p_kind text default null,
  p_request_id text default null,
  p_execution_id text default null
) returns jsonb
language plpgsql volatile security definer
set search_path = pg_catalog, mcp_internal, public
set timezone = 'UTC'
as $$
begin
  perform mcp_internal.require_service_role();
  perform mcp_internal.require_active_bot(p_bot_id);
  perform mcp_internal.require_bot_client_grant(p_bot_id, p_client_id);
  return mcp_internal.campaign_execution(
    p_bot_id, p_client_id, p_action, p_campaign_id, p_limit, p_after,
    p_name, p_brief, p_status, p_summary, p_kind, p_request_id, p_execution_id
  );
end
$$;
revoke all on function public.mcp_campaign_execution(text, uuid, text, uuid, integer, uuid, text, text, text, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.mcp_campaign_execution(text, uuid, text, uuid, integer, uuid, text, text, text, text, text, text, text)
  to service_role;

-- ---------------------------------------------------------------------------
-- Grants: additive Phase 16 names only (PR #48 / mig 89).
-- Delete+insert the 17 tools this phase owns. Do NOT replace all
-- bot_marketing rows — Gate 9 (mig 73) already set 23 exact names.
-- Post-#48 Marketing count: 40 (23 + 17). This is NOT the final 45.
-- Final after #48 then #46 then #47: Marketing 45, Sales Ops 28.
-- Sibling PRs MUST APPEND (delete+insert only names they own).
-- brand.*, sites.*, remaining attribution are not granted here.
-- CoS already holds campaign.* (covers new execution names).
-- CDM keeps campaign.get / campaign.get_status only (now Execution OS).
-- ---------------------------------------------------------------------------

delete from mcp_internal.mcp_bot_permissions
 where bot_id = 'bot_marketing'
   and permission_pattern in (
     'conversion.list_pages',
     'conversion.get_page',
     'conversion.get_performance',
     'conversion.create_page',
     'conversion.generate_structure',
     'conversion.generate_copy',
     'conversion.request_approval',
     'conversion.audit_page',
     'conversion.revise_page',
     'conversion.revert_page',
     'campaign.get_readiness',
     'campaign.create',
     'campaign.update',
     'campaign.request_approval',
     'campaign.plan',
     'campaign.provision',
     'campaign.launch'
   );
insert into mcp_internal.mcp_bot_permissions (bot_id, permission_pattern, granted_by) values
  ('bot_marketing', 'conversion.list_pages', 'alex-locked:phase-16'),
  ('bot_marketing', 'conversion.get_page', 'alex-locked:phase-16'),
  ('bot_marketing', 'conversion.get_performance', 'alex-locked:phase-16'),
  ('bot_marketing', 'conversion.create_page', 'alex-locked:phase-16'),
  ('bot_marketing', 'conversion.generate_structure', 'alex-locked:phase-16'),
  ('bot_marketing', 'conversion.generate_copy', 'alex-locked:phase-16'),
  ('bot_marketing', 'conversion.request_approval', 'alex-locked:phase-16'),
  ('bot_marketing', 'conversion.audit_page', 'alex-locked:phase-16'),
  ('bot_marketing', 'conversion.revise_page', 'alex-locked:phase-16'),
  ('bot_marketing', 'conversion.revert_page', 'alex-locked:phase-16'),
  ('bot_marketing', 'campaign.get_readiness', 'alex-locked:phase-16'),
  ('bot_marketing', 'campaign.create', 'alex-locked:phase-16'),
  ('bot_marketing', 'campaign.update', 'alex-locked:phase-16'),
  ('bot_marketing', 'campaign.request_approval', 'alex-locked:phase-16'),
  ('bot_marketing', 'campaign.plan', 'alex-locked:phase-16'),
  ('bot_marketing', 'campaign.provision', 'alex-locked:phase-16'),
  ('bot_marketing', 'campaign.launch', 'alex-locked:phase-16');

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
        or p.permission_pattern like 'conversion%'
        or mcp_internal.permission_matches(p.permission_pattern, 'economics.get_costs')
        or mcp_internal.permission_matches(p.permission_pattern, 'security.get_system_status')
        or mcp_internal.permission_matches(p.permission_pattern, 'sales_agents.deploy')
        or mcp_internal.permission_matches(p.permission_pattern, 'conversion.list_pages')
      )
  ) then
    raise exception 'CoS: bot_production must not have finance, security, deploy or conversion grants';
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
    where p.permission_pattern = 'conversion.*'
  ) then
    raise exception 'Phase 16: conversion.* wildcard is forbidden';
  end if;
  if exists (
    select 1 from mcp_internal.mcp_bot_permissions p
    where p.bot_id <> 'bot_marketing'
      and (
        p.permission_pattern like 'conversion.%'
        or p.permission_pattern = 'conversion.*'
      )
  ) then
    raise exception 'Phase 16: conversion tools must not be granted outside bot_marketing';
  end if;
end
$$;
revoke all on function mcp_internal.assert_cos_prohibitions() from public, anon, authenticated;
grant execute on function mcp_internal.assert_cos_prohibitions() to service_role;

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
    ('public', 'client_campaigns'),
    ('public', 'campaign_artifacts'),
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
    ('public', 'client_page_revisions'),
    ('public', 'client_page_findings'),
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
    ('mcp_internal', 'mcp_security_requests'),
    ('mcp_internal', 'mcp_conversion_requests'),
    ('mcp_internal', 'mcp_campaign_requests')
  ) as t(nsp, rel)
  left join pg_class c
    on c.relname = t.rel
   and c.relnamespace = (select n.oid from pg_namespace n where n.nspname = t.nsp);
end;
$$;
revoke all on function mcp_internal.bot_touched_rls_status() from public, anon, authenticated;
grant execute on function mcp_internal.bot_touched_rls_status() to service_role;

do $$
declare n integer;
declare missing text;
begin
  select count(*) into n from mcp_internal.mcp_bot_permissions where bot_id = 'bot_marketing';
  -- Post-#48 only: Gate 9's 23 + this phase's 17. Not the final 45.
  if n is distinct from 40 then
    raise exception 'Phase 16 / PR #48: bot_marketing must have exactly 40 permission rows after this additive grant (post-#48, not final 45), found %', n;
  end if;
  select string_agg(required.name, ', ' order by required.name) into missing
    from unnest(array[
      'campaign.list', 'campaign.get', 'campaign.get_status',
      'content.list_ideas', 'content.get_idea', 'content.get_brief',
      'content.get_production_status', 'attribution.get_campaign_performance',
      'delivery.get_client', 'delivery.get_status', 'delivery.get_client_health',
      'workflow.get_pending_approvals', 'workflow.get_activity',
      'workflow.list_tasks', 'workflow.get_task',
      'content.generate_brief', 'content.request_revision',
      'content.request_approval', 'content.create_repurpose_plan',
      'workflow.create_task', 'workflow.assign_task',
      'workflow.complete_task', 'workflow.create_approval'
    ]) as required(name)
   where not exists (
     select 1 from mcp_internal.mcp_bot_permissions p
      where p.bot_id = 'bot_marketing' and p.permission_pattern = required.name
   );
  if missing is not null then
    raise exception 'Phase 16 / PR #48: Gate 9 Marketing grants missing (mig 73 must land first; this phase is additive): %', missing;
  end if;
  select string_agg(required.name, ', ' order by required.name) into missing
    from unnest(array[
      'conversion.list_pages', 'conversion.get_page', 'conversion.get_performance',
      'conversion.create_page', 'conversion.generate_structure',
      'conversion.generate_copy', 'conversion.request_approval',
      'conversion.audit_page', 'conversion.revise_page', 'conversion.revert_page',
      'campaign.get_readiness', 'campaign.create', 'campaign.update',
      'campaign.request_approval', 'campaign.plan', 'campaign.provision',
      'campaign.launch'
    ]) as required(name)
   where not exists (
     select 1 from mcp_internal.mcp_bot_permissions p
      where p.bot_id = 'bot_marketing' and p.permission_pattern = required.name
   );
  if missing is not null then
    raise exception 'Phase 16 / PR #48: missing additive Phase 16 Marketing grants: %', missing;
  end if;
  if exists (
    select 1 from mcp_internal.mcp_bot_permissions
     where bot_id = 'bot_marketing' and permission_pattern in ('conversion.*', 'campaign.*', 'content.*')
  ) then
    raise exception 'Phase 16: Marketing domain wildcards must be gone';
  end if;
  perform mcp_internal.assert_cos_prohibitions();
end
$$;

commit;

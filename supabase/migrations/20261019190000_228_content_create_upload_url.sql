-- content.create_upload_url
--
-- Production mints a short-lived reservation for one object in the private
-- client-media bucket at {client_id}/{pending_asset_id}.{ext}. The Console
-- runtime (service role, never a bot env) turns that path into a Supabase
-- signed upload URL. The bot PUTs the bytes, then content.submit_asset
-- registers the row. The signed-upload token itself is the platform default
-- (about two hours) and is single-use at storage. This reservation expires
-- in 30 minutes and is consumed once, which is the TTL submit_asset enforces.
--
-- CoS may call the same RPC as a read-check: eligibility only, no path, no URL.
-- Marketing and every other bot are rejected.
--
-- Do not apply to production without Alex via Chief of Staff.

begin;

alter table client_briefs add column if not exists archived_at timestamptz;

create table mcp_internal.asset_upload_grants (
  id uuid primary key default gen_random_uuid(),
  bot_id text not null,
  client_id uuid not null references public.clients (id) on delete cascade,
  brief_id uuid not null references public.client_briefs (id) on delete cascade,
  storage_path text not null unique,
  content_type text not null,
  filename text,
  byte_size integer,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  asset_id uuid,
  created_at timestamptz not null default now(),
  constraint asset_upload_grants_content_type check (
    content_type in ('image/png', 'image/jpeg', 'image/webp')
  ),
  constraint asset_upload_grants_byte_size check (
    byte_size is null or (byte_size >= 1 and byte_size <= 26214400)
  )
);

comment on table mcp_internal.asset_upload_grants is
  'Single-use Production upload reservations. The service role mints the signed PUT URL outside SQL. Submit consumes the row only after the object exists.';

alter table mcp_internal.asset_upload_grants enable row level security;
alter table mcp_internal.asset_upload_grants force row level security;
revoke all on mcp_internal.asset_upload_grants from public, anon, authenticated, service_role;

alter table mcp_internal.mcp_content_requests
  drop constraint mcp_content_requests_tool_check;
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
    'content.submit_asset',
    'content.create_upload_url'
  ));

create or replace function mcp_internal.create_upload_url(
  p_bot_id text, p_request_id text, p_execution_id text, p_client_id uuid,
  p_brief_id uuid, p_content_type text, p_filename text default null,
  p_byte_size integer default null
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
  v_grant mcp_internal.asset_upload_grants;
  v_id uuid;
  v_ext text;
  v_path text;
  v_result jsonb;
  v_in_scope boolean;
begin
  perform mcp_internal.require_active_bot(p_bot_id);
  if p_bot_id not in ('bot_production', 'bot_chief_of_staff') then
    raise exception using message = 'bot_forbidden', errcode = 'P0001';
  end if;
  perform mcp_internal.require_bot_client_grant(p_bot_id, p_client_id);
  perform mcp_internal.require_mcp_ids(p_request_id, p_execution_id);
  if p_brief_id is null or p_content_type is null
     or p_content_type not in ('image/png', 'image/jpeg', 'image/webp') then
    raise exception using message = 'invalid_request', errcode = 'P0001';
  end if;
  if p_filename is not null and p_filename !~ '^[A-Za-z0-9][A-Za-z0-9._ -]{0,199}$' then
    raise exception using message = 'invalid_request', errcode = 'P0001';
  end if;
  if p_byte_size is not null and (p_byte_size < 1 or p_byte_size > 26214400) then
    raise exception using message = 'invalid_request', errcode = 'P0001';
  end if;

  select * into v_brief from client_briefs where id = p_brief_id for share;
  if not found then
    raise exception using message = 'brief_not_found', errcode = 'P0001';
  end if;
  if v_brief.client_id <> p_client_id then
    raise exception using message = 'client_mismatch', errcode = 'P0001';
  end if;
  -- DB-verified: Attract Acquisition is clients.id
  -- e4b4b001-81f6-4997-8429-ff21f4ee1fbe. The organic launch is
  -- client_campaigns.id 457e0ca8-8af6-4ead-a39d-d5326c729882 (status planning).
  -- client_ideas.campaign_id references that client_campaigns id. Briefs have
  -- no campaign_id of their own; they hang off source_idea_id.
  v_in_scope := v_brief.client_id = 'e4b4b001-81f6-4997-8429-ff21f4ee1fbe'::uuid;
  if not v_in_scope
     and to_regclass('public.client_campaigns') is not null
     and exists (
       select 1
         from pg_attribute a
         join pg_class c on c.oid = a.attrelid
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public'
          and c.relname = 'client_ideas'
          and a.attname = 'campaign_id'
          and a.attnum > 0
          and not a.attisdropped
     ) then
    execute $sql$
      select exists (
        select 1
          from public.client_ideas i
          join public.client_campaigns camp
            on camp.id = i.campaign_id
           and camp.client_id = i.client_id
         where i.id = $1
           and i.client_id = $2
           and camp.id = '457e0ca8-8af6-4ead-a39d-d5326c729882'::uuid
      )
    $sql$ into v_in_scope using v_brief.source_idea_id, v_brief.client_id;
  end if;
  if not coalesce(v_in_scope, false) then
    raise exception using message = 'client_mismatch', errcode = 'P0001';
  end if;
  -- draft covers campaign packs that have not been assigned yet (Harbour
  -- campaign briefs are draft). approved / in_production cover the rest of
  -- the submit window. rejected, complete, and archived briefs do not.
  if v_brief.archived_at is not null
     or v_brief.status not in ('draft', 'approved', 'in_production') then
    raise exception using message = 'invalid_brief_status', errcode = 'P0001';
  end if;

  if p_bot_id = 'bot_chief_of_staff' then
    return jsonb_build_object(
      'client_id', p_client_id,
      'brief_id', p_brief_id,
      'brief_status', v_brief.status,
      'eligible', true,
      'read_check', true
    );
  end if;

  v_payload := jsonb_strip_nulls(jsonb_build_object(
    'brief_id', p_brief_id,
    'content_type', p_content_type,
    'filename', p_filename,
    'byte_size', p_byte_size
  ));
  v_existing := mcp_internal.take_content_request(
    p_bot_id, p_execution_id, 'content.create_upload_url', p_client_id, v_payload);
  if v_existing is not null then
    select * into v_grant
      from mcp_internal.asset_upload_grants
     where id = nullif(v_existing->>'pending_asset_id', '')::uuid;
    if not found then
      raise exception using message = 'upload_not_found', errcode = 'P0001';
    end if;
    if v_grant.consumed_at is not null then
      raise exception using message = 'upload_consumed', errcode = 'P0001';
    end if;
    if v_grant.expires_at <= now() then
      raise exception using message = 'upload_expired', errcode = 'P0001';
    end if;
    return v_existing;
  end if;

  v_id := gen_random_uuid();
  v_ext := case p_content_type
    when 'image/png' then 'png'
    when 'image/jpeg' then 'jpg'
    when 'image/webp' then 'webp'
  end;
  v_path := p_client_id::text || '/' || v_id::text || '.' || v_ext;

  insert into mcp_internal.asset_upload_grants (
    id, bot_id, client_id, brief_id, storage_path, content_type, filename, byte_size, expires_at
  ) values (
    v_id, p_bot_id, p_client_id, p_brief_id, v_path, p_content_type, p_filename, p_byte_size,
    now() + interval '30 minutes'
  ) returning * into v_grant;

  v_result := jsonb_build_object(
    'client_id', p_client_id,
    'brief_id', p_brief_id,
    'pending_asset_id', v_grant.id,
    'storage_path', v_grant.storage_path,
    'content_type', v_grant.content_type,
    'expires_at', v_grant.expires_at,
    'filename', v_grant.filename,
    'byte_size', v_grant.byte_size,
    'replayed', false
  );
  insert into mcp_internal.mcp_content_requests (
    bot_id, execution_id, request_id, tool, client_id, brief_id, payload, result
  ) values (
    p_bot_id, p_execution_id, p_request_id, 'content.create_upload_url',
    p_client_id, p_brief_id, v_payload, v_result
  );
  return v_result;
end;
$$;
revoke all on function mcp_internal.create_upload_url(text, text, text, uuid, uuid, text, text, integer)
  from public, anon, authenticated;
grant execute on function mcp_internal.create_upload_url(text, text, text, uuid, uuid, text, text, integer)
  to service_role;

create or replace function public.mcp_create_upload_url(
  p_bot_id text, p_request_id text, p_execution_id text, p_client_id uuid,
  p_brief_id uuid, p_content_type text, p_filename text default null,
  p_byte_size integer default null
)
returns jsonb language plpgsql security definer set search_path = mcp_internal, public as $$
begin
  perform mcp_internal.require_service_role();
  return mcp_internal.create_upload_url(
    p_bot_id, p_request_id, p_execution_id, p_client_id, p_brief_id,
    p_content_type, p_filename, p_byte_size);
end;
$$;
revoke all on function public.mcp_create_upload_url(text, text, text, uuid, uuid, text, text, integer)
  from public, anon, authenticated;
grant execute on function public.mcp_create_upload_url(text, text, text, uuid, uuid, text, text, integer)
  to service_role;

-- submit_asset stays metadata-only. A path under the client prefix must be an
-- unconsumed, unexpired grant whose bytes are already in client-media.
-- Paths outside that prefix keep the previous metadata-only behaviour.

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
  v_grant mcp_internal.asset_upload_grants;
  v_prefix text;
  v_exists boolean;
  v_meta jsonb;
  v_size bigint;
  v_mime text;
begin
  perform mcp_internal.require_active_bot(p_bot_id);
  perform mcp_internal.require_bot_client_grant(p_bot_id, p_client_id);
  if p_bot_id <> 'bot_production' then
    raise exception using message = 'bot_forbidden', errcode = 'P0001';
  end if;
  perform mcp_internal.require_mcp_ids(p_request_id, p_execution_id);
  if p_storage_path is null or length(trim(p_storage_path)) < 1 or length(p_storage_path) > 500
     or position('..' in p_storage_path) > 0
     or left(trim(p_storage_path), 1) = '/'
     or strpos(p_storage_path, chr(92)) > 0 then
    raise exception using message = 'invalid_request', errcode = 'P0001';
  end if;
  p_storage_path := trim(p_storage_path);
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

  v_prefix := p_client_id::text || '/';
  select * into v_grant from mcp_internal.asset_upload_grants where storage_path = p_storage_path;
  if found or left(p_storage_path, length(v_prefix)) = v_prefix then
    if not found then
      raise exception using message = 'upload_not_found', errcode = 'P0001';
    end if;
    if v_grant.client_id <> p_client_id or v_grant.bot_id <> p_bot_id then
      raise exception using message = 'client_mismatch', errcode = 'P0001';
    end if;
    if p_brief_id is not null and v_grant.brief_id is distinct from p_brief_id then
      raise exception using message = 'client_mismatch', errcode = 'P0001';
    end if;
    if p_brief_id is null then
      p_brief_id := v_grant.brief_id;
    end if;
    if v_grant.consumed_at is not null then
      raise exception using message = 'upload_consumed', errcode = 'P0001';
    end if;
    if v_grant.expires_at <= now() then
      raise exception using message = 'upload_expired', errcode = 'P0001';
    end if;
    if v_grant.content_type like 'image/%' and p_media_type <> 'image' then
      raise exception using message = 'invalid_request', errcode = 'P0001';
    end if;
    if to_regclass('storage.objects') is null then
      raise exception using message = 'bytes_missing', errcode = 'P0001';
    end if;
    execute $sql$
      select exists (
        select 1 from storage.objects
         where bucket_id = 'client-media' and name = $1
      )
    $sql$ into v_exists using p_storage_path;
    if not coalesce(v_exists, false) then
      raise exception using message = 'bytes_missing', errcode = 'P0001';
    end if;
    execute $sql$
      select metadata from storage.objects
       where bucket_id = 'client-media' and name = $1
       limit 1
    $sql$ into v_meta using p_storage_path;
    if v_meta is not null and (v_meta ? 'size') then
      v_size := (v_meta->>'size')::bigint;
      if v_size > 26214400
         or (v_grant.byte_size is not null and v_size > v_grant.byte_size) then
        raise exception using message = 'invalid_request', errcode = 'P0001';
      end if;
    end if;
    v_mime := coalesce(v_meta->>'mimetype', v_meta->>'contentType');
    if v_mime is not null and v_mime <> v_grant.content_type then
      raise exception using message = 'invalid_request', errcode = 'P0001';
    end if;
  end if;

  insert into client_media_assets (
    client_id, brief_id, media_type, storage_path, title, review_status
  ) values (
    p_client_id, p_brief_id, p_media_type::media_type, p_storage_path,
    coalesce(p_title, v_grant.filename, v_brief.title, v_job.title, 'Submitted asset'),
    'pending'
  ) returning * into v_asset;

  if v_grant.id is not null then
    update mcp_internal.asset_upload_grants
       set consumed_at = now(), asset_id = v_asset.id
     where id = v_grant.id;
  end if;

  if v_job.id is not null and v_job.completed_at is null then
    update job_assignments set completed_at = now() where id = v_job.id;
  end if;

  v_result := jsonb_build_object(
    'client_id', p_client_id,
    'asset_id', v_asset.id,
    'brief_id', v_asset.brief_id,
    'assignment_id', v_job.id,
    'review_status', v_asset.review_status,
    'storage_path', v_asset.storage_path,
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

-- Route entry that accepts storage_path or pending_asset_id, then the same submit.
create or replace function public.mcp_submit_uploaded_asset(
  p_bot_id text, p_request_id text, p_execution_id text, p_client_id uuid,
  p_storage_path text default null, p_media_type text default null,
  p_brief_id uuid default null, p_assignment_id uuid default null,
  p_title text default null, p_pending_asset_id uuid default null
)
returns jsonb language plpgsql security definer set search_path = mcp_internal, public as $$
declare
  v_path text;
begin
  perform mcp_internal.require_service_role();
  if p_pending_asset_id is not null then
    select storage_path into v_path
      from mcp_internal.asset_upload_grants
     where id = p_pending_asset_id;
    if v_path is null then
      raise exception using message = 'upload_not_found', errcode = 'P0001';
    end if;
    if p_storage_path is not null and btrim(p_storage_path) <> v_path then
      raise exception using message = 'invalid_request', errcode = 'P0001';
    end if;
    p_storage_path := v_path;
  end if;
  return mcp_internal.submit_asset(
    p_bot_id, p_request_id, p_execution_id, p_client_id, p_storage_path, p_media_type,
    p_brief_id, p_assignment_id, p_title);
end;
$$;
revoke all on function public.mcp_submit_uploaded_asset(text, text, text, uuid, text, text, uuid, uuid, text, uuid)
  from public, anon, authenticated;
grant execute on function public.mcp_submit_uploaded_asset(text, text, text, uuid, text, text, uuid, uuid, text, uuid)
  to service_role;

insert into mcp_internal.mcp_bot_permissions (bot_id, permission_pattern, granted_by)
values ('bot_chief_of_staff', 'content.create_upload_url', 'content-create-upload-url')
on conflict (bot_id, permission_pattern) do nothing;

-- Partial fixtures (pipeline-route) stop before migration 91, which defines
-- this check. Production and the isolation fixture both have it.
do $$ begin
  if to_regprocedure('mcp_internal.assert_cos_prohibitions()') is not null then
    perform mcp_internal.assert_cos_prohibitions();
  end if;
end $$;

-- Keep the Bot-touched RLS inventory in step with the reservation table.
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
    ('mcp_internal', 'mcp_security_requests'),
    ('mcp_internal', 'mcp_conversion_requests'),
    ('mcp_internal', 'mcp_campaign_requests'),
    ('mcp_internal', 'asset_upload_grants')
  ) as t(nsp, rel)
  left join pg_class c
    on c.relname = t.rel
   and c.relnamespace = (select n.oid from pg_namespace n where n.nspname = t.nsp);
end;
$$;
revoke all on function mcp_internal.bot_touched_rls_status() from public, anon, authenticated;
grant execute on function mcp_internal.bot_touched_rls_status() to service_role;

commit;
